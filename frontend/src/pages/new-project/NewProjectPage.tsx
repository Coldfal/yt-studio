/**
 * New / Edit Project wizard shell.
 *
 * Owns the cross-step state (step index, channel/title for the unsaved
 * project, the saved VideoProject, draft metadata) and routes step props
 * down to the per-step files under ``./steps/``. Each step is responsible
 * for its own internal state — this shell only knows about the contract.
 *
 * Step layout: 0=Setup, 1=Music, 2=Compose, 3=Thumbnail (optional),
 * 4=Publish (metadata + upload). Images for the VIDEO are picked inside
 * the Compose step's VisualizerEditor → ImagesPanel. The Thumbnail step
 * is a separate canvas-edited still that uploads alongside the video.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { useChannels } from "@/hooks/use-channels";
import {
  useCreateProject,
  useProject,
  useUpdateProject,
} from "@/hooks/use-projects";
import { useTaskSSE } from "@/hooks/use-sse";
import api from "@/lib/api";
import type { VideoProject } from "@/types/index";
import { StepIndicator, STEPS } from "./components/StepIndicator";
import { SetupStep } from "./steps/SetupStep";
import { MusicStep } from "./steps/MusicStep";
import { ComposeStep } from "./steps/ComposeStep";
import { MetadataStep } from "./steps/MetadataStep";
import { ReviewUploadStep } from "./steps/ReviewUploadStep";
import { ThumbnailStep } from "./steps/ThumbnailStep";
import { getSmartStep } from "./utils";

export default function NewProjectPage() {
  const { id: editId } = useParams<{ id: string }>();
  const { data: channels } = useChannels();
  const createProject = useCreateProject();
  const updateProject = useUpdateProject();
  const { data: existingProject } = useProject(editId);

  const [initialized, setInitialized] = useState(!editId);
  const [step, setStep] = useState(0);
  const [channelId, setChannelId] = useState("");
  const [title, setTitle] = useState("");
  const [project, setProject] = useState<VideoProject | null>(null);
  const [metadata, setMetadata] = useState({
    youtube_title: "",
    youtube_description: "",
    youtube_tags: [] as string[],
  });

  // Initial load: when editing an existing project, seed local state.
  // After init, the sync effect below keeps local ``project`` in step
  // with React Query as child steps mutate the row.
  useEffect(() => {
    if (existingProject && !initialized) {
      setChannelId(String(existingProject.channel_id));
      setTitle(existingProject.title);
      setMetadata({
        youtube_title: existingProject.youtube_title ?? "",
        youtube_description: existingProject.youtube_description ?? "",
        youtube_tags: existingProject.youtube_tags ?? [],
      });
      setStep(getSmartStep(existingProject));
      setInitialized(true);
    }
  }, [existingProject, initialized]);

  // Keep local project state in sync with React Query. Without this,
  // mutations from inside child steps (e.g. ComposeStep's image picker
  // calling updateProject.mutateAsync directly) update the server +
  // invalidate the query cache, but the shell's snapshot of ``project``
  // stays stale — which means re-running auto-apply effects, broken
  // prop chains, and (the bug that surfaced this) image_asset_ids the
  // backend renders not matching what the visualizer preview shows.
  // Always trust the latest fetched value.
  useEffect(() => {
    if (existingProject) setProject(existingProject);
  }, [existingProject]);

  useTaskSSE(() => {
    // SSE updates are handled globally in App.tsx SSEHandler
  });

  const channelList = channels ?? [];

  const canGoNext = () => {
    switch (step) {
      case 0:
        // Title auto-fills from channel name + count, so only channel is required.
        return !!channelId;
      case 1: {
        const hasMusic =
          !!project?.music_asset_id ||
          (project?.music_asset_ids && project.music_asset_ids.length > 0) ||
          (project?.music_folder_files && project.music_folder_files.length > 0);
        return hasMusic;
      }
      case 2:
        return !!project?.composed_asset_id;
      case 3:
        // Thumbnail step is optional — Next always advances.
        return true;
      case 4:
        return true; // Publish step — upload button handles the action
      default:
        return false;
    }
  };

  const handleNext = async () => {
    if (step === 0) {
      const fallbackTitle =
        title.trim() ||
        `${channelList.find((c) => String(c.id) === channelId)?.name ?? "Untitled"} video`;

      if (project) {
        // Editing existing project — update title only. Backend's ProjectUpdate
        // schema doesn't accept channel_id so we omit it; the channel was set at
        // create-time and isn't user-mutable from this step (the Select is just
        // there for visual confirmation).
        try {
          const updated = await updateProject.mutateAsync({
            id: project.id,
            title: fallbackTitle,
          });
          setProject(updated);
          setStep(1);
        } catch (err: unknown) {
          const detail =
            (err as { response?: { data?: { detail?: string } } })?.response?.data
              ?.detail ?? "Failed to update project";
          toast.error(typeof detail === "string" ? detail : "Failed to update project");
        }
      } else {
        try {
          const newProject = await createProject.mutateAsync({
            channel_id: parseInt(channelId),
            title: fallbackTitle,
          });
          setProject(newProject);
          setStep(1);
        } catch (err: unknown) {
          const detail =
            (err as { response?: { data?: { detail?: string } } })?.response?.data
              ?.detail ?? "Failed to create project";
          toast.error(typeof detail === "string" ? detail : "Failed to create project");
        }
      }
      return;
    }

    setStep((s) => Math.min(s + 1, STEPS.length - 1));
  };

  const handleBack = () => {
    setStep((s) => Math.max(s - 1, 0));
  };

  const handleMusicReady = useCallback(
    async (assetIds: number | number[]) => {
      if (!project) return;
      const ids = Array.isArray(assetIds) ? assetIds : [assetIds];
      if (ids.length === 0) {
        // Folder mode: files were already saved directly via api.put inside MusicStep.
        // Re-fetch the project so local state reflects music_folder_files and canGoNext() works.
        try {
          const { data } = await api.get(`/projects/${project.id}`);
          setProject(data);
        } catch {
          // non-fatal — worst case user refreshes
        }
        return;
      }
      try {
        const updated = await updateProject.mutateAsync({
          id: project.id,
          music_asset_id: ids[0],
          music_asset_ids: ids,
        });
        setProject(updated);
      } catch {
        toast.error("Failed to update project with music");
      }
    },
    [project, updateProject],
  );

  const projectRef = useRef(project);
  projectRef.current = project;

  const handleComposed = useCallback(async () => {
    const p = projectRef.current;
    if (!p) return;
    try {
      const { data } = await api.get(`/projects/${p.id}`);
      setProject(data);
    } catch {
      // silent refresh failure
    }
  }, []);

  const handleUpload = async (
    privacy: string,
    scheduledAt: string | null,
  ): Promise<number | null> => {
    if (!project) return null;
    try {
      await updateProject.mutateAsync({
        id: project.id,
        youtube_privacy: privacy,
        youtube_scheduled_at: scheduledAt,
        ...metadata,
      });
      const { data } = await api.post("/youtube/upload", {
        project_id: project.id,
      });
      toast.success("Upload started");
      return data?.id ?? null;
    } catch (err: any) {
      const detail =
        err?.response?.data?.detail ?? "Failed to start upload";
      toast.error(detail);
      return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">{editId ? "Edit Video" : "Create Video"}</h1>
        {project && (
          <Badge variant="outline" className="text-xs">
            Project #{project.id}
          </Badge>
        )}
      </div>

      <StepIndicator currentStep={step} steps={STEPS} />

      <div className="min-h-[400px]">
        {step === 0 && (
          <SetupStep
            channelId={channelId}
            setChannelId={setChannelId}
            title={title}
            setTitle={setTitle}
            channels={channelList}
          />
        )}
        {step === 1 && project && (
          <MusicStep project={project} onMusicReady={handleMusicReady} />
        )}
        {step === 2 && project && (
          <ComposeStep project={project} onComposed={handleComposed} />
        )}
        {step === 3 && project && (
          <ThumbnailStep project={project} />
        )}
        {step === 4 && project && (
          // Merged Publish step: metadata editor + upload in one screen.
          <div className="space-y-8">
            <MetadataStep project={project} onMetadataUpdate={setMetadata} />
            <Separator />
            <ReviewUploadStep
              project={project}
              channels={channelList}
              onUpload={handleUpload}
            />
          </div>
        )}
      </div>

      <Separator />

      {/* Back / Next buttons centered together so they're easy to find on
          ultrawide screens. The wizard step indicator at the top still
          shows current progress. */}
      <div className="flex items-center justify-center gap-3">
        <Button
          variant="outline"
          onClick={handleBack}
          disabled={step === 0}
        >
          <ChevronLeft className="size-4" />
          Back
        </Button>
        {step < STEPS.length - 1 && (
          // No "Next" button on the final Publish step — the upload button
          // inside ReviewUploadStep is the primary action there.
          <Button
            onClick={handleNext}
            disabled={!canGoNext() || createProject.isPending}
          >
            {createProject.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Creating...
              </>
            ) : (
              <>
                Next
                <ChevronRight className="size-4" />
              </>
            )}
          </Button>
        )}
      </div>
    </div>
  );
}
