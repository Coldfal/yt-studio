import { useCallback, useEffect, useRef, useState } from "react";
import { ListMusic, Loader2, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useChannel } from "@/hooks/use-channels";
import { useAssets } from "@/hooks/use-assets";
import { useTasks } from "@/hooks/use-tasks";
import api from "@/lib/api";
import type { VideoProject } from "@/types/index";
import { KeywordResearchPanel } from "../components/KeywordResearchPanel";
import { buildTracklist } from "../utils";

export function MetadataStep({
  project,
  onMetadataUpdate,
}: {
  project: VideoProject;
  onMetadataUpdate: (meta: {
    youtube_title: string;
    youtube_description: string;
    youtube_tags: string[];
  }) => void;
}) {
  const [ytTitle, setYtTitle] = useState(project.youtube_title ?? "");
  const [ytDescription, setYtDescription] = useState(
    project.youtube_description ?? "",
  );
  const [ytTags, setYtTags] = useState(
    project.youtube_tags?.join(", ") ?? "",
  );

  // Resolve the tracklist for this project (multi-track → names + durations)
  const { data: channelMusic } = useAssets({
    channel_id: String(project.channel_id),
    asset_type: "music",
  });
  const { data: channel } = useChannel(project.channel_id);
  const trackIds =
    project.music_asset_ids && project.music_asset_ids.length > 0
      ? project.music_asset_ids
      : project.music_asset_id
        ? [project.music_asset_id]
        : [];
  const tracklistItems = trackIds
    .map((id) => channelMusic?.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .map((a) => ({
      name: a.title || a.filename,
      duration: a.duration_seconds ?? 0,
    }));
  const tracklistText = buildTracklist(tracklistItems);

  // Resolve template placeholders against the actual project context.
  const resolveTemplate = useCallback(
    (tpl: string): string => {
      const totalSec = tracklistItems.reduce((s, t) => s + (t.duration || 0), 0);
      const totalMin = Math.round(totalSec / 60);
      const today = new Date();
      const shortDate = today.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
      const repl: Record<string, string> = {
        "{channel_name}": channel?.name ?? "",
        "{niche}": channel?.niche ?? "",
        "{date}": today.toLocaleDateString(),
        "{short_date}": shortDate,
        "{track_count}": String(tracklistItems.length),
        "{total_duration}":
          totalMin >= 60
            ? `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`
            : `${totalMin}m`,
        "{tracklist}": tracklistText,
      };
      return tpl.replace(/\{[a-z_]+\}/g, (m) => repl[m] ?? m);
    },
    [channel, tracklistItems, tracklistText],
  );

  const [aiFilling, setAiFilling] = useState(false);

  // ── Unified "Generate with AI" — always uses /metadata/fill-template (sync ~3s) ──
  // Uses channel template when present; otherwise sends free-form creative prompts.
  // Single button replaces the old "Auto-Generate All" + per-field "Regenerate" paths.
  const handleGenerateWithAI = useCallback(async () => {
    if (!channel) return;
    const titleResolved = channel.title_template
      ? resolveTemplate(channel.title_template)
      : ytTitle || `{COMPELLING TITLE for a ${channel.niche || channel.name} video}`;
    const descResolved = channel.description_template
      ? resolveTemplate(channel.description_template)
      : ytDescription ||
        `{ENGAGING DESCRIPTION for a ${channel.niche || channel.name} YouTube video}`;

    setAiFilling(true);
    try {
      const { data } = await api.post("/metadata/fill-template", {
        project_id: project.id,
        title_template: titleResolved,
        description_template: descResolved,
        tag_count: 28,
      });
      if (data?.title) setYtTitle(data.title);
      if (data?.description) setYtDescription(data.description);
      if (Array.isArray(data?.tags) && data.tags.length > 0) {
        setYtTags(data.tags.join(", "));
      }
      toast.success("Generated with AI");
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(
        typeof detail === "string"
          ? detail
          : "AI generation failed — check Claude CLI status in Settings.",
      );
    } finally {
      setAiFilling(false);
    }
  }, [channel, resolveTemplate, ytTitle, ytDescription, project.id]);

  // Auto-fill on first mount when the project has no metadata yet.
  const autoFilledRef = useRef(false);
  useEffect(() => {
    if (autoFilledRef.current) return;
    if (!channel) return;
    const hasExisting =
      Boolean(project.youtube_title) ||
      Boolean(project.youtube_description) ||
      Boolean(project.youtube_tags?.length);
    if (hasExisting) {
      autoFilledRef.current = true;
      return;
    }
    if (channel.title_template && !ytTitle) {
      setYtTitle(resolveTemplate(channel.title_template));
    }
    if (channel.description_template && !ytDescription) {
      setYtDescription(resolveTemplate(channel.description_template));
    }
    autoFilledRef.current = true;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, tracklistItems.length]);

  // ── Pre-generation tracking ──────────────────────────────────────────────
  // When compose starts the backend concurrently enqueues a metadata_generation
  // task. We detect it here to show skeletons and auto-populate when it lands —
  // usually before the user even reaches this step.
  const { data: projectTasks } = useTasks({ project_id: project.id });
  const preGenTask = projectTasks
    ?.filter((t) => t.task_type === "metadata_generation")
    .sort((a, b) => b.id - a.id)[0]; // most recent

  const isPreGenRunning =
    preGenTask?.status === "pending" || preGenTask?.status === "running";

  const preGenCompletedRef = useRef<number | null>(null);
  useEffect(() => {
    if (preGenTask?.status !== "completed") return;
    if (preGenCompletedRef.current === preGenTask.id) return;
    preGenCompletedRef.current = preGenTask.id;
    // Don't overwrite fields the user has already edited manually
    if (autoFilledRef.current && (ytTitle || ytDescription)) return;

    api
      .get(`/projects/${project.id}`)
      .then(({ data }) => {
        if (data.youtube_title) {
          setYtTitle(data.youtube_title);
          autoFilledRef.current = true;
        }
        if (data.youtube_description) setYtDescription(data.youtube_description);
        if (data.youtube_tags?.length) setYtTags(data.youtube_tags.join(", "));
        toast.success("Metadata ready", {
          description: "Pre-generated while your video was composing",
        });
      })
      .catch(() => {});
  }, [preGenTask?.status, preGenTask?.id]);

  const updateMetadata = useCallback(() => {
    onMetadataUpdate({
      youtube_title: ytTitle,
      youtube_description: ytDescription,
      youtube_tags: ytTags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean),
    });
  }, [ytTitle, ytDescription, ytTags, onMetadataUpdate]);

  useEffect(() => {
    updateMetadata();
  }, [ytTitle, ytDescription, ytTags]);

  return (
    <div className="mx-auto w-full max-w-6xl space-y-6">
      <div>
        <h2 className="text-xl font-semibold">Metadata</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Set your YouTube video title, description, and tags. Claude is fed
          live keyword research (autocomplete + trending tags) so output
          rides current search trends instead of being made up.
        </p>
      </div>

      {/* Keyword research preview — what Claude sees */}
      <KeywordResearchPanel channelId={project.channel_id} />

      {/* Pre-generation in-progress banner */}
      {isPreGenRunning && (
        <div className="flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin text-primary" />
          <span>AI is generating metadata in the background…</span>
        </div>
      )}

      {/* Single unified AI generation button */}
      <Button
        variant="outline"
        onClick={handleGenerateWithAI}
        disabled={aiFilling || isPreGenRunning}
        className="w-full"
      >
        {aiFilling ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Generating…
          </>
        ) : (
          <>
            <Sparkles className="size-4" />
            Generate with AI
          </>
        )}
      </Button>

      {/* Channel template info (no duplicate button — Generate with AI covers it) */}
      {channel && (channel.title_template || channel.description_template) && (
        <p className="text-center text-xs text-muted-foreground">
          <Sparkles className="mr-1 inline size-3 text-primary" />
          Uses your channel template — substitutes placeholders, fills creative
          blocks with Claude, and generates tags.
        </p>
      )}

      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="yt-title">YouTube Title</Label>
          {isPreGenRunning ? (
            <div className="h-9 animate-pulse rounded-md bg-muted" />
          ) : (
            <Input
              id="yt-title"
              placeholder="Video title for YouTube"
              value={ytTitle}
              onChange={(e) => setYtTitle(e.target.value)}
            />
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="yt-desc">YouTube Description</Label>
          {isPreGenRunning ? (
            <div className="h-[120px] animate-pulse rounded-md bg-muted" />
          ) : (
            <>
              <Textarea
                id="yt-desc"
                placeholder="Video description..."
                value={ytDescription}
                onChange={(e) => setYtDescription(e.target.value)}
                rows={5}
              />
              {tracklistItems.length > 1 && (
                <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/50 bg-muted/30 p-2 text-xs">
                  <ListMusic className="size-3.5 text-primary" />
                  <span className="font-medium">
                    {tracklistItems.length} tracks — insert timestamped tracklist?
                  </span>
                  <div className="flex-1" />
                  <Button
                    variant="outline"
                    size="xs"
                    onClick={() => {
                      const already = ytDescription.includes("Tracklist:");
                      const next = already
                        ? ytDescription.replace(
                            /Tracklist:[\s\S]*?(?=\n\n|$)/,
                            tracklistText,
                          )
                        : ytDescription
                          ? `${ytDescription.trimEnd()}\n\n${tracklistText}`
                          : tracklistText;
                      setYtDescription(next);
                      toast.success(
                        already ? "Tracklist refreshed" : "Tracklist inserted",
                      );
                    }}
                  >
                    <ListMusic className="size-3" />
                    {ytDescription.includes("Tracklist:") ? "Refresh" : "Insert"} tracklist
                  </Button>
                </div>
              )}
            </>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="yt-tags">Tags</Label>
          {isPreGenRunning ? (
            <div className="h-9 animate-pulse rounded-md bg-muted" />
          ) : (
            <Input
              id="yt-tags"
              placeholder="lofi, chill, study music, beats"
              value={ytTags}
              onChange={(e) => setYtTags(e.target.value)}
            />
          )}
          <p className="text-xs text-muted-foreground">Separate tags with commas</p>
        </div>
      </div>
    </div>
  );
}
