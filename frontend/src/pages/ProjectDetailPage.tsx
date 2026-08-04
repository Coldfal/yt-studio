import { useEffect, useState } from "react";
import { useParams, useNavigate, Link } from "react-router-dom";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowLeft,
  AlertTriangle,
  Pencil,
  Film,
  Upload,
  ExternalLink,
  Video,
  Music,
  Image,
  Clock,
  RefreshCw,
  Loader2,
} from "lucide-react";
import { Progress } from "@/components/ui/progress";
import { useTask } from "@/hooks/use-tasks";
import { TaskFailureCard } from "@/components/TaskFailureCard";
import type { BackgroundTask } from "@/types/index";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useProject, useUpdateProject } from "@/hooks/use-projects";
import { TranslationsPanel } from "@/components/TranslationsPanel";
import { useChannel } from "@/hooks/use-channels";
import { STATUS_COLORS } from "@/types/index";
import { formatDistanceToNow, format } from "date-fns";
import api from "@/lib/api";

function EditMetadataDialog({
  open,
  onOpenChange,
  project,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  project: {
    id: number;
    youtube_title: string | null;
    youtube_description: string | null;
    youtube_tags: string[] | null;
    title: string;
  };
}) {
  const [ytTitle, setYtTitle] = useState(
    project.youtube_title ?? project.title
  );
  const [ytDescription, setYtDescription] = useState(
    project.youtube_description ?? ""
  );
  const [ytTags, setYtTags] = useState(
    project.youtube_tags?.join(", ") ?? ""
  );
  const updateProject = useUpdateProject();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await updateProject.mutateAsync({
        id: project.id,
        youtube_title: ytTitle.trim(),
        youtube_description: ytDescription.trim(),
        youtube_tags: ytTags
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      toast.success("Metadata updated");
      onOpenChange(false);
    } catch {
      toast.error("Failed to update metadata");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Metadata</DialogTitle>
            <DialogDescription>
              Update the YouTube metadata for this project.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-yt-title">YouTube Title</Label>
              <Input
                id="edit-yt-title"
                value={ytTitle}
                onChange={(e) => setYtTitle(e.target.value)}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-yt-desc">Description</Label>
              <Textarea
                id="edit-yt-desc"
                value={ytDescription}
                onChange={(e) => setYtDescription(e.target.value)}
                rows={5}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="edit-yt-tags">Tags</Label>
              <Input
                id="edit-yt-tags"
                value={ytTags}
                onChange={(e) => setYtTags(e.target.value)}
                placeholder="Comma-separated tags"
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={updateProject.isPending}>
              {updateProject.isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="h-8 w-48 animate-pulse rounded bg-muted" />
      <div className="h-64 animate-pulse rounded-xl bg-muted" />
      <div className="h-32 animate-pulse rounded-xl bg-muted" />
    </div>
  );
}

/** Poll for any running or recently-finished task attached to this project.
 *  Refetches every 3s while any task is running so progress bars animate. */
function useActiveProjectTask(
  projectId: number | undefined,
  taskType: string,
) {
  return useQuery<BackgroundTask[]>({
    queryKey: ["project-tasks", projectId, taskType],
    queryFn: async () => {
      const { data } = await api.get("/tasks/", {
        params: { project_id: projectId, task_type: taskType, limit: 5 },
      });
      return data;
    },
    enabled: projectId != null,
    refetchInterval: (q) => {
      const tasks = q.state.data;
      if (!tasks || tasks.length === 0) return false;
      const t = tasks[0];
      if (t.status === "running" || t.status === "pending") return 3000;
      return false;
    },
  });
}

export default function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { data: project, isLoading, error } = useProject(id);
  const { data: channel } = useChannel(project?.channel_id);
  const [editOpen, setEditOpen] = useState(false);
  const [recomposing, setRecomposing] = useState(false);
  const [reuploading, setReuploading] = useState(false);
  const qc = useQueryClient();

  // Live progress for any in-flight upload / compose for this project.
  const projectIdNum = project?.id;
  const { data: uploadTasks } = useActiveProjectTask(projectIdNum, "youtube_upload");
  const { data: composeTasks } = useActiveProjectTask(projectIdNum, "video_composition");
  const activeUpload = uploadTasks?.[0];
  const activeCompose = composeTasks?.[0];
  const { data: liveUploadTask } = useTask(
    activeUpload && (activeUpload.status === "running" || activeUpload.status === "pending")
      ? activeUpload.id
      : undefined,
  );
  const { data: liveComposeTask } = useTask(
    activeCompose && (activeCompose.status === "running" || activeCompose.status === "pending")
      ? activeCompose.id
      : undefined,
  );
  const uploadView = liveUploadTask ?? activeUpload;
  const composeView = liveComposeTask ?? activeCompose;

  // When an upload that was running finishes successfully, refresh the
  // project so the YouTube link surfaces.
  useEffect(() => {
    if (liveUploadTask?.status === "completed") {
      // trigger a refetch of project data (react-query handles invalidation
      // elsewhere — we just nudge the cache by reloading the page once).
      // Keep it simple: no-op; the project query already refetches.
    }
  }, [liveUploadTask?.status]);

  if (isLoading) return <LoadingSkeleton />;

  if (error || !project) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-destructive">
            {error ? "Failed to load project." : "Project not found."}
          </p>
          <Button
            variant="outline"
            className="mt-4"
            onClick={() => navigate("/")}
          >
            Go to Dashboard
          </Button>
        </CardContent>
      </Card>
    );
  }

  const handleRecompose = async () => {
    setRecomposing(true);
    try {
      await api.post("/compose/start", {
        project_id: project.id,
        style: project.video_style ?? "loop",
        config: project.composition_config ?? {},
      });
      toast.success("Re-composition started");
    } catch {
      toast.error("Failed to start re-composition");
    }
    setRecomposing(false);
  };

  const handleReupload = async () => {
    setReuploading(true);
    try {
      await api.post("/youtube/upload", { project_id: project.id });
      toast.success("Re-upload started");
      // Refetch the project so the badge flips to "uploading" / "uploaded"
      // and the user has visible feedback that something is happening.
      qc.invalidateQueries({ queryKey: ["projects"] });
      qc.invalidateQueries({ queryKey: ["project", project.id] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    } catch (err: unknown) {
      // Surface the backend error so the user can see WHY (e.g. token
      // expired, missing metadata, title too long) instead of a generic
      // "Failed to start re-upload" — was making retries feel broken.
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "";
      toast.error(
        typeof detail === "string" && detail
          ? `Upload failed: ${detail}`
          : "Failed to start re-upload",
      );
    }
    setReuploading(false);
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => navigate(-1)}
        >
          <ArrowLeft className="size-4" />
        </Button>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-3">
            <h1 className="truncate text-2xl font-bold">{project.title}</h1>
            <Badge
              className={`${STATUS_COLORS[project.status] ?? "bg-gray-500"} text-white`}
            >
              {project.status.replace(/_/g, " ")}
            </Badge>
          </div>
          {channel && (
            <Link
              to={`/channels/${channel.id}`}
              className="text-sm text-muted-foreground hover:text-foreground"
            >
              {channel.name}
            </Link>
          )}
        </div>

        {/* Active-task progress card (rendered within the header right side) */}
        {/* The main card is rendered below in the body */}
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={() => navigate(`/projects/${project.id}/edit`)}
          >
            <Pencil className="size-4" />
            {project.status === "uploaded" ? "Edit" : "Continue"}
          </Button>
        </div>
      </div>

      {project.composed_asset_id && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Video Preview</CardTitle>
          </CardHeader>
          <CardContent>
            <video
              controls
              className="w-full rounded-lg"
              src={`/api/assets/${project.composed_asset_id}/stream`}
            />
          </CardContent>
        </Card>
      )}

      {project.youtube_url && (
        <Card>
          <CardContent className="flex items-center gap-3">
            <Video className="size-5 text-red-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Published on YouTube</p>
              <a
                href={project.youtube_url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline"
              >
                {project.youtube_url}
              </a>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => window.open(project.youtube_url!, "_blank")}
            >
              <ExternalLink className="size-4" />
              View
            </Button>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Project Details</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">YouTube Title</p>
              <p className="text-sm font-medium">
                {project.youtube_title ?? "Not set"}
              </p>
            </div>
            <div className="space-y-1">
              <p className="text-xs text-muted-foreground">Privacy</p>
              <p className="text-sm font-medium capitalize">
                {project.youtube_privacy}
              </p>
            </div>
          </div>

          <Separator />

          {project.youtube_description && (
            <>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Description</p>
                <p className="whitespace-pre-wrap text-sm">
                  {project.youtube_description}
                </p>
              </div>
              <Separator />
            </>
          )}

          {project.youtube_tags && project.youtube_tags.length > 0 && (
            <>
              <div className="space-y-1">
                <p className="text-xs text-muted-foreground">Tags</p>
                <div className="flex flex-wrap gap-1">
                  {project.youtube_tags.map((tag) => (
                    <Badge key={tag} variant="outline" className="text-xs">
                      {tag}
                    </Badge>
                  ))}
                </div>
              </div>
              <Separator />
            </>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex items-center gap-2">
              <Music className="size-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Music</p>
                <p className="text-sm">
                  {project.music_asset_id ? "Attached" : "None"}
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Image className="size-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Images</p>
                <p className="text-sm">
                  {project.image_asset_ids?.length ?? 0} images
                </p>
              </div>
            </div>
            <div className="flex items-center gap-2">
              <Film className="size-4 text-muted-foreground" />
              <div>
                <p className="text-xs text-muted-foreground">Style</p>
                <p className="text-sm capitalize">
                  {project.video_style?.replace(/_/g, " ") ?? "None"}
                </p>
              </div>
            </div>
          </div>

          <Separator />

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="size-3" />
              Created{" "}
              {formatDistanceToNow(new Date(project.created_at))} ago
            </div>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Clock className="size-3" />
              Updated{" "}
              {formatDistanceToNow(new Date(project.updated_at))} ago
            </div>
            {project.uploaded_at && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Upload className="size-3" />
                Uploaded {format(new Date(project.uploaded_at), "PPp")}
              </div>
            )}
            {project.youtube_scheduled_at && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Clock className="size-3" />
                Scheduled{" "}
                {format(new Date(project.youtube_scheduled_at), "PPp")}
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* Localised title + description for non-English YouTube viewers.
          Only shows up once the project has English metadata to translate
          from — a fresh draft can't be translated yet. */}
      {project.youtube_title && (
        <TranslationsPanel
          project={project}
          masterLanguage={channel?.master_language}
        />
      )}

      <div className="flex flex-wrap gap-3">
        {(project.status === "composed" ||
          project.status === "visuals_ready" ||
          project.status === "music_ready") && (
          <Button
            variant="outline"
            onClick={handleRecompose}
            disabled={recomposing}
          >
            {recomposing ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <RefreshCw className="size-4" />
            )}
            Re-compose
          </Button>
        )}

        {(project.status === "composed" ||
          project.status === "failed" ||
          project.status === "uploaded") && (
          <Button
            variant="outline"
            onClick={handleReupload}
            disabled={reuploading}
          >
            {reuploading ? (
              <Loader2 className="size-4 animate-spin" />
            ) : (
              <Upload className="size-4" />
            )}
            {project.status === "failed"
              ? "Retry Upload"
              : project.status === "uploaded"
                ? "Re-upload"
                : "Upload to YouTube"}
          </Button>
        )}
      </div>

      {/* Live task progress (upload/compose) */}
      {composeView &&
        (composeView.status === "running" || composeView.status === "pending") && (
          <Card className="border-blue-500/50 bg-blue-500/5">
            <CardContent className="space-y-2 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Loader2 className="size-4 animate-spin text-blue-400" />
                  {composeView.status_message ?? "Composing video…"}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {Math.round(composeView.progress ?? 0)}%
                </span>
              </div>
              <Progress value={composeView.progress ?? 0} />
            </CardContent>
          </Card>
        )}

      {uploadView &&
        (uploadView.status === "running" || uploadView.status === "pending") && (
          <Card className="border-blue-500/50 bg-blue-500/5">
            <CardContent className="space-y-2 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Loader2 className="size-4 animate-spin text-blue-400" />
                  {uploadView.status_message ?? "Uploading to YouTube…"}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {Math.round(uploadView.progress ?? 0)}%
                </span>
              </div>
              <Progress value={uploadView.progress ?? 0} />
              <p className="text-xs text-muted-foreground">
                Safe to close this page — the upload runs on the server.
              </p>
            </CardContent>
          </Card>
        )}

      {uploadView && uploadView.status === "failed" && !project.youtube_url && (
        <TaskFailureCard
          error={uploadView.error ?? "Upload failed"}
          channelId={project.channel_id}
          onRetry={handleReupload}
        />
      )}

      {project && (
        <EditMetadataDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          project={project}
        />
      )}
    </div>
  );
}
