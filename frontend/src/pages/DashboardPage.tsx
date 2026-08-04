import { useState, useCallback } from "react";
import { useNavigate } from "react-router-dom";
import {
  PlusCircle,
  Tv,
  BookOpen,
  Settings,
  ArrowRight,
  Zap,
  Sparkles,
  Loader2,
  CheckCircle2,
  XCircle,
  AlertCircle,
  RefreshCw,
  Lock,
  Unlock,
  Image as ImageIcon,
  Sliders,
  ChevronDown,
  Music,
  Clock,
  Palette,
  Calendar,
  Languages,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useChannels,
  useChannelQuota,
  useStorageStats,
} from "@/hooks/use-channels";
import { formatBytes } from "@/lib/format";
import { useProjects } from "@/hooks/use-projects";
import { useTasks, useTask, useLastChannelRun } from "@/hooks/use-tasks";
import {
  useVisualizerPresets,
  useUpdateVisualizerPreset,
  type VisualizerPreset,
} from "@/hooks/use-visualizer-presets";
import { useAssets, useUploadAsset } from "@/hooks/use-assets";
import {
  ThumbnailDesignerDialog,
  type ThumbnailEditorState,
} from "@/components/thumbnail/ThumbnailDesignerDialog";
import { QuickGeneratePreviewDrawer } from "@/components/QuickGeneratePreviewDrawer";
import { ThumbnailTemplateEditor } from "@/components/thumbnail/ThumbnailTemplateEditor";
import type { ThumbnailTemplate } from "@/components/thumbnail/renderTemplate";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
// FailedTasksPanel was promoted to a top-bar bell + drawer
// (FailedTasksDrawer in App.tsx), to free vertical space on
// dashboards with 5–10 channels. Import kept commented for posterity.
// import { FailedTasksPanel } from "@/components/FailedTasksPanel";
import { NICHE_OPTIONS, STATUS_COLORS } from "@/types/index";
import type { Channel } from "@/types/index";
import { formatDistanceToNow } from "date-fns";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { useEffect, useRef } from "react";

function LoadingSkeleton() {
  return (
    <div className="space-y-8">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Card key={i}>
            <CardContent className="flex items-center gap-3 py-5">
              <div className="h-10 w-10 animate-pulse rounded-lg bg-muted" />
              <div className="h-5 w-24 animate-pulse rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-3 lg:grid-cols-5">
        {Array.from({ length: 5 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <div className="h-4 w-20 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="h-8 w-12 animate-pulse rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <div className="h-5 w-32 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="h-4 w-48 animate-pulse rounded bg-muted" />
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function DashboardPage() {
  const navigate = useNavigate();
  const { data: channels, isLoading: channelsLoading } = useChannels();
  const { data: projects, isLoading: projectsLoading } = useProjects();
  const { data: tasks, isLoading: tasksLoading } = useTasks();

  const isLoading = channelsLoading || projectsLoading || tasksLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <h1 className="text-2xl font-bold">Content Pipeline</h1>
        </div>
        <LoadingSkeleton />
      </div>
    );
  }

  const channelList = channels ?? [];
  const projectList = projects ?? [];
  const _taskList = tasks ?? [];

  // Pipeline stage counts
  const stageCounts = {
    draft: projectList.filter((p) => p.status === "draft").length,
    music_ready: projectList.filter((p) => p.status === "music_ready").length,
    visuals_ready: projectList.filter((p) => p.status === "visuals_ready").length,
    composed: projectList.filter((p) => p.status === "composed").length,
    uploaded: projectList.filter((p) => p.status === "uploaded").length,
  };

  const pipelineStages = [
    { key: "draft", label: "Drafts", count: stageCounts.draft, color: "bg-gray-500", textColor: "text-gray-400" },
    { key: "music_ready", label: "Music Ready", count: stageCounts.music_ready, color: "bg-blue-500", textColor: "text-blue-400" },
    { key: "visuals_ready", label: "Ready to Compose", count: stageCounts.visuals_ready, color: "bg-indigo-500", textColor: "text-indigo-400" },
    { key: "composed", label: "Composed", count: stageCounts.composed, color: "bg-purple-500", textColor: "text-purple-400" },
    { key: "uploaded", label: "Uploaded", count: stageCounts.uploaded, color: "bg-green-500", textColor: "text-green-400" },
  ];

  const quickActions = [
    { label: "New Video", icon: PlusCircle, to: "/projects/new", description: "Start a new project" },
    { label: "Channels", icon: Tv, to: "/channels", description: "Manage channels" },
    { label: "Library", icon: BookOpen, to: "/assets", description: "Music & images" },
    { label: "Settings", icon: Settings, to: "/settings", description: "Configure integrations" },
  ];

  const recentProjects = [...projectList]
    .sort(
      (a, b) =>
        new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime()
    )
    .slice(0, 5);

  const channelProjectCounts = channelList.reduce<Record<number, number>>(
    (acc, ch) => {
      acc[ch.id] = projectList.filter((p) => p.channel_id === ch.id).length;
      return acc;
    },
    {}
  );

  return (
    <div className="space-y-8">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <Zap className="size-6 text-primary" />
          <h1 className="text-2xl font-bold">Content Pipeline</h1>
        </div>
        <Button onClick={() => navigate("/projects/new")}>
          <PlusCircle className="size-4" />
          New Video
        </Button>
      </div>

      {/* Quick Actions */}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {quickActions.map((action) => (
          <Card
            key={action.to}
            className="cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => navigate(action.to)}
          >
            <CardContent className="flex items-center gap-3 py-4">
              <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <action.icon className="size-5 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{action.label}</p>
                <p className="text-xs text-muted-foreground">
                  {action.description}
                </p>
              </div>
              <ArrowRight className="size-4 text-muted-foreground" />
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Pipeline Status */}
      <div>
        <h2 className="mb-4 text-lg font-semibold">Pipeline Status</h2>
        <div className="grid gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {pipelineStages.map((stage) => (
            <Card key={stage.key} className="cursor-pointer transition-colors hover:bg-accent/50">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">
                  {stage.label}
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="flex items-center gap-2">
                  <div className={`size-2.5 rounded-full ${stage.color}`} />
                  <span className={`text-2xl font-bold ${stage.textColor}`}>
                    {stage.count}
                  </span>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Your Channels */}
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Your Channels</h2>
          {channelList.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate("/channels")}
            >
              View All
            </Button>
          )}
        </div>

        {channelList.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Tv className="mb-4 size-12 text-muted-foreground" />
              <h3 className="mb-2 text-lg font-medium">No channels yet</h3>
              <p className="mb-4 text-sm text-muted-foreground">
                Create your first channel to start the AI pipeline.
              </p>
              <Button onClick={() => navigate("/channels")}>
                <PlusCircle className="size-4" />
                Create Channel
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {channelList.map((channel) => (
              <ChannelQuickActionCard
                key={channel.id}
                channel={channel}
                projectCount={channelProjectCounts[channel.id] ?? 0}
              />
            ))}
          </div>
        )}
      </div>

      {/* Failed-task surface lives in the top-bar drawer now
          (FailedTasksDrawer in App.tsx). Bell badge auto-shows when
          there's anything to retry. */}

      {/* Recent Activity */}
      {recentProjects.length > 0 && (
        <div>
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold">Recent Activity</h2>
            <Button
              size="sm"
              variant="outline"
              onClick={() => navigate("/projects/new")}
            >
              <PlusCircle className="size-4" />
              New Video
            </Button>
          </div>
          <div className="grid gap-3">
            {recentProjects.map((project) => {
              const channel = channelList.find(
                (c) => c.id === project.channel_id
              );
              return (
                <Card
                  key={project.id}
                  className="cursor-pointer transition-colors hover:bg-accent/50"
                  onClick={() => navigate(`/projects/${project.id}`)}
                >
                  <CardContent className="flex items-center justify-between">
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-medium">{project.title}</p>
                      <div className="flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{channel?.name ?? "Unknown channel"}</span>
                        <span>-</span>
                        <span>
                          {formatDistanceToNow(new Date(project.updated_at))} ago
                        </span>
                      </div>
                    </div>
                    <Badge
                      className={`${STATUS_COLORS[project.status] ?? "bg-gray-500"} text-white`}
                    >
                      {project.status.replace(/_/g, " ")}
                    </Badge>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Channel Quick Action Card ──────────────────────────────────────────
//
// Per-channel card on the Dashboard with the headline "Generate now" button.
// Loads the channel's primary automation preset; if one is configured, the
// button triggers it. While running, the card animates a progress bar wired
// to the active task via SSE/polling.

function useChannelPrimaryPreset(channelId: number) {
  return useQuery<{ id: number; name: string; is_active: boolean } | null>({
    queryKey: ["channel-primary-preset", channelId],
    queryFn: async () => {
      const { data } = await api.get(
        `/automation/channels/${channelId}/primary-preset`,
      );
      return data;
    },
    staleTime: 30_000,
  });
}

// ── Quick Generate hooks ────────────────────────────────────────────────

interface QuickGenPreview {
  image: {
    id: number;
    filename: string;
    file_url: string;
    title: string | null;
    /** "image" or "video" — when "video" the preview swaps the still
     *  <img> for a muted/looping <video> so the user sees the bg in
     *  motion. The compose pipeline detects the same flag downstream. */
    asset_type?: string;
  } | null;
  rotated: boolean;
  preset_id: number | null;
  /** True when the user has explicitly LOCKED the current image — auto-
   *  rotation skips and only an explicit reroll changes it. */
  pinned?: boolean;
}

/**
 * Full preview package for the Quick Generate flow. Powers the "preview
 * before generate" drawer (Phase 1 of farm redesign). The endpoint is
 * a real dry-run: it picks an image + tracks + runs the metadata
 * generator, but doesn't create a VideoProject or fire compose. The
 * operator can Approve (fires the real compose) or Re-roll (re-invokes
 * this endpoint with fresh picks).
 */
export interface QuickGenPreviewFull {
  channel_id: number;
  preset_id: number | null;
  image: {
    id: number;
    filename: string;
    filepath: string;
    file_url: string;
    role: string | null;
    asset_type: string;
  };
  music: {
    asset_ids: number[];
    count: number;
    total_duration_seconds: number;
    sample_names: string[];
  };
  thumbnail: {
    asset_id: number | null;
    file_url: string | null;
  };
  metadata: {
    title: string;
    description: string;
    tags: string[];
    category_id: string;
  };
  target_duration_seconds: number;
  auto_upload: boolean;
  auto_translate_languages: string[];
  video_style: string;
  composition_config: Record<string, unknown>;
  diagnostics: Record<string, unknown>;
}

/**
 * Trigger a full preview. Mutation (not query) because each call should
 * re-pick a fresh image / tracks / metadata — Re-roll wants different
 * results, not a cached read.
 */
export function useQuickGenPreviewFull() {
  return useMutation({
    mutationFn: async (channelId: number) => {
      const { data } = await api.post(
        `/automation/channels/${channelId}/quick-generate-preview/full`,
      );
      return data as QuickGenPreviewFull;
    },
  });
}

function useQuickGenPreview(channelId: number) {
  return useQuery<QuickGenPreview>({
    queryKey: ["quick-gen-preview", channelId],
    queryFn: async () => {
      const { data } = await api.get(
        `/automation/channels/${channelId}/quick-generate-preview`,
      );
      return data;
    },
    staleTime: 60_000,
  });
}

interface QuickGenPreset {
  id: number;
  channel_id: number;
  name: string;
  is_primary: boolean;
  target_duration_seconds: number;
  num_tracks: number | null;
  visualizer_color_override: Record<string, unknown> | null;
  visualizer_disabled: boolean;
  /** Dashboard particle controls — NULL = let the loaded VisualizerPreset
   *  or engine defaults decide. */
  particle_style: string | null;
  particle_density: number | null;
  /** Sticky thumbnail asset id — every quick-generated video on this
   *  channel inherits this thumbnail until the user clears or changes it. */
  default_thumbnail_asset_id: number | null;
  /** Editor state for the sticky thumbnail. Mirrors the same shape we
   *  use on VideoProject.thumbnail_editor_state — re-opening the
   *  designer restores layers/fonts/effects exactly. */
  default_thumbnail_editor_state: ThumbnailEditorState | null;
  output_fps: number | null;
  auto_upload: boolean;
  scheduled_publish_at: string | null;
  next_image_asset_id: number | null;
  next_image_pinned: boolean;
  visualizer_preset_id: number | null;
  /** YouTube localisation language codes — when non-empty, Quick
   *  Generate runs Claude after metadata to populate
   *  ``project.youtube_translations`` and ships them as YouTube
   *  ``localizations``. Empty / null = no auto-translation. */
  auto_translate_languages: string[] | null;
  /** Cron expression for recurring auto-runs. Set via the dashboard's
   *  Schedule editor; the scheduler fires this preset whenever
   *  ``next_run_at`` (computed server-side from this expression) is in
   *  the past. Null = no schedule. */
  schedule_cron: string | null;
  schedule_timezone: string;
  /** Computed by the backend whenever schedule_cron changes. Used by
   *  the dashboard to render "Next run: in 4h 12m". */
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  /** Phase 2: opt in to image+music folder pairing. When true, Quick
   *  Generate constrains music selection to folders sharing the
   *  picked image's ``pair_group`` label. */
  use_folder_pairing: boolean;
  /** Phase 3: shorter title (≤40 chars), description (≤200 words),
   *  and tags (≤8). Channel voice still wins on style; this caps
   *  length only. */
  terse_metadata: boolean;
  /** Phase 5: when true, Quick Generate picks a random active
   *  AssetSet (bg+thumbnail tuple) instead of independently picking
   *  a background + sticky thumbnail. Manage Sets in Library → Sets. */
  use_asset_sets: boolean;
  /** Phase 7: per-preset thumbnail template — when set, the preview
   *  drawer renders a fresh JPEG per video using these layers + pools.
   *  Shape defined in ``components/thumbnail/renderTemplate.ts``. */
  thumbnail_template?: Record<string, unknown> | null;
  /** Operator UX (2026-05-15): when true, clicking "Generate now"
   *  skips the preview-before-generate drawer and fires compose
   *  directly. Defaults false — the drawer stays the default UX. */
  skip_preview_drawer: boolean;
  /** Operator UX (2026-05-15): when false, Quick Generate skips the
   *  Phase 7b thumbnail-template renderer and uses the sticky
   *  thumbnail (if any) instead. Defaults true. */
  auto_generate_thumbnail: boolean;
}

// ── Cron helpers ──────────────────────────────────────────────────
// Build / parse the small subset of cron expressions the UI cares
// about. We deliberately don't try to handle every croniter feature —
// the editor only emits these four shapes:
//   - Daily at HH:MM            → "MM HH * * *"
//   - Specific days at HH:MM    → "MM HH * * <comma-list-of-0-6>"
//   - Every N hours             → "0 */N * * *"
//   - Off                       → null
type ScheduleMode = "off" | "daily" | "weekly" | "hourly";
interface ScheduleState {
  mode: ScheduleMode;
  time: string;       // "HH:MM" — used by daily + weekly
  days: number[];     // 0=Sun..6=Sat — used by weekly
  hours: number;      // every-N-hours — used by hourly
}
const DEFAULT_SCHEDULE: ScheduleState = {
  mode: "off",
  time: "09:00",
  days: [1, 3, 5], // Mon Wed Fri
  hours: 6,
};
function buildCron(s: ScheduleState): string | null {
  if (s.mode === "off") return null;
  if (s.mode === "hourly") {
    const n = Math.max(1, Math.min(23, Math.floor(s.hours)));
    return `0 */${n} * * *`;
  }
  const [hh, mm] = s.time.split(":").map((x) => parseInt(x, 10));
  const minute = isFinite(mm) ? mm : 0;
  const hour = isFinite(hh) ? hh : 9;
  if (s.mode === "daily") return `${minute} ${hour} * * *`;
  // weekly
  const days = s.days.length > 0 ? [...s.days].sort((a, b) => a - b) : [1];
  return `${minute} ${hour} * * ${days.join(",")}`;
}
function parseCron(cron: string | null | undefined): ScheduleState {
  if (!cron) return DEFAULT_SCHEDULE;
  const parts = cron.trim().split(/\s+/);
  if (parts.length !== 5) return DEFAULT_SCHEDULE;
  const [m, h, dom, mon, dow] = parts;
  // Every-N-hours form
  const hourlyMatch = h.match(/^\*\/(\d+)$/);
  if (hourlyMatch && m === "0" && dom === "*" && mon === "*" && dow === "*") {
    return { ...DEFAULT_SCHEDULE, mode: "hourly", hours: parseInt(hourlyMatch[1], 10) };
  }
  // Concrete hour + minute
  const minuteN = parseInt(m, 10);
  const hourN = parseInt(h, 10);
  if (!isFinite(minuteN) || !isFinite(hourN)) return DEFAULT_SCHEDULE;
  const time = `${String(hourN).padStart(2, "0")}:${String(minuteN).padStart(2, "0")}`;
  if (dow === "*") return { ...DEFAULT_SCHEDULE, mode: "daily", time };
  // Day-of-week list
  const days = dow.split(",").map((d) => parseInt(d, 10)).filter((d) => isFinite(d) && d >= 0 && d <= 6);
  return { ...DEFAULT_SCHEDULE, mode: "weekly", time, days };
}

// Translation language pool sourced from the shared module so the
// per-project translations panel + the per-channel auto-translate
// chips stay in sync. The chips below ALSO filter out the channel's
// master_language at render time (no point translating ko→ko).
import {
  TRANSLATION_LANGS as TRANSLATE_LANGS_FULL,
} from "@/lib/translation-langs";

// Map to the compact label shape this card uses (2-letter chip).
const TRANSLATE_LANGS_COMPACT = TRANSLATE_LANGS_FULL.map((l) => ({
  code: l.code,
  // Quick 2-letter chip: take the front of the full label, capitalized.
  label:
    l.code === "zh-Hans"
      ? "CN"
      : l.code === "id"
        ? "ID"
        : l.code === "vi"
          ? "VI"
          : l.code === "pt"
            ? "PT"
            : l.code === "en"
              ? "EN"
              : l.label.slice(0, 2).toUpperCase(),
  flag: l.flag,
}));

const FPS_OPTIONS = [15, 24, 30] as const;

const DURATION_OPTIONS: { label: string; seconds: number }[] = [
  // "10s test" trims the first track to 10 seconds so the visualizer
  // engine renders a short video — useful for checking the look /
  // upload pipeline without waiting on a full track. Backend kicks in
  // the trim path when target_seconds < 60.
  { label: "10s test", seconds: 10 },
  { label: "10 min", seconds: 600 },
  { label: "30 min", seconds: 1800 },
  { label: "1 h", seconds: 3600 },
  { label: "2 h", seconds: 7200 },
  { label: "5 h", seconds: 18000 },
  { label: "10 h", seconds: 36000 },
];

/**
 * Inline picker for the AutomationPreset's sticky default thumbnail.
 *
 * Two modes the operator can use:
 *   - "Design thumbnail" — opens the full canvas editor (text overlays,
 *      fonts, drag positioning, effect presets) and saves the rendered
 *      JPEG as the sticky thumbnail. This is the recommended path.
 *   - "Pick from library" / "Upload new" — for when the operator already
 *      has a flat thumbnail prepared elsewhere and just wants to attach
 *      it without text overlays.
 *
 * Lives inside the Quick Generate settings dialog.
 */
function StickyThumbnailPicker({
  channelId,
  presetId,
  value,
  editorState,
  onChange,
}: {
  channelId: number;
  presetId: number | null;
  value: number | null;
  editorState: ThumbnailEditorState | null;
  onChange: (id: number | null) => void;
}) {
  const { data: imageAssets } = useAssets({
    channel_id: String(channelId),
    asset_type: "image",
  });
  const uploadAsset = useUploadAsset();
  const library = (imageAssets ?? []).filter((a) => a.file_exists !== false);
  const current = value ? library.find((a) => a.id === value) : null;
  const [pickerOpen, setPickerOpen] = useState(false);
  const [designerOpen, setDesignerOpen] = useState(false);

  const handleUpload = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("channel_id", String(channelId));
    formData.append("asset_type", "image");
    try {
      const asset = await uploadAsset.mutateAsync(formData);
      onChange(asset.id);
    } catch {
      toast.error("Thumbnail upload failed");
    }
  };

  return (
    <div className="space-y-1.5">
      <Label className="flex items-center gap-1 text-[11px]">
        <ImageIcon className="size-3" /> Default thumbnail
      </Label>
      <div className="flex items-start gap-2">
        {current ? (
          <div className="relative h-12 w-20 shrink-0 overflow-hidden rounded border border-border">
            <img
              src={current.file_url}
              alt=""
              className="size-full object-cover"
            />
            <button
              type="button"
              onClick={() => onChange(null)}
              className="absolute right-0.5 top-0.5 rounded bg-black/70 px-1 text-[9px] text-white hover:bg-black/90"
              title="Clear sticky thumbnail"
            >
              ×
            </button>
          </div>
        ) : (
          <div className="flex h-12 w-20 shrink-0 items-center justify-center rounded border border-dashed border-border/60 text-[9px] text-muted-foreground">
            (none)
          </div>
        )}
        <div className="flex flex-1 flex-col gap-1">
          <button
            type="button"
            onClick={() => presetId && setDesignerOpen(true)}
            disabled={!presetId}
            className="h-6 rounded border border-primary/50 bg-primary/10 px-2 text-[10px] font-medium text-primary hover:bg-primary/20 disabled:opacity-50"
            title={
              presetId
                ? "Open the full thumbnail designer (text, fonts, effects)"
                : "Save the preset first by opening this dialog"
            }
          >
            ✨ Design thumbnail
          </button>
          <div className="flex gap-1">
            <button
              type="button"
              onClick={() => setPickerOpen((v) => !v)}
              className="h-6 flex-1 rounded border border-border bg-background px-2 text-[10px] hover:bg-muted"
            >
              Library
            </button>
            <label className="h-6 flex-1 cursor-pointer rounded border border-border bg-background px-2 text-center text-[10px] leading-6 hover:bg-muted">
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(f);
                  e.target.value = "";
                }}
              />
              Upload
            </label>
          </div>
        </div>
      </div>
      {pickerOpen && (
        <div className="max-h-40 overflow-y-auto rounded border border-border/40 p-1">
          {library.length === 0 ? (
            <div className="py-3 text-center text-[10px] text-muted-foreground">
              No images in this channel's library yet.
            </div>
          ) : (
            <div className="grid grid-cols-4 gap-1">
              {library.map((a) => {
                const selected = value === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => {
                      onChange(selected ? null : a.id);
                      setPickerOpen(false);
                    }}
                    className={cn(
                      "aspect-video overflow-hidden rounded border",
                      selected
                        ? "border-primary ring-2 ring-primary/50"
                        : "border-border/50 hover:border-foreground/40",
                    )}
                    title={a.title || a.filename}
                  >
                    <img
                      src={a.file_url}
                      alt=""
                      className="size-full object-cover"
                      loading="lazy"
                    />
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}
      <p className="text-[10px] text-muted-foreground">
        Design once, ships with every quick-generated video. Per-video override available in the wizard's Thumbnail step.
      </p>

      {presetId !== null && (
        <ThumbnailDesignerDialog
          open={designerOpen}
          onOpenChange={setDesignerOpen}
          channelId={channelId}
          presetId={presetId}
          initialState={editorState}
        />
      )}
    </div>
  );
}

function ChannelQuickActionCard({
  channel,
  projectCount,
}: {
  channel: Channel;
  projectCount: number;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const nicheLabel =
    NICHE_OPTIONS.find((n) => n.value === channel.niche)?.label ?? channel.niche;
  // Optional storage line — fetched once via the cached hook so every
  // card reads from the same query and the sub-line just shows "" until
  // the first response arrives.
  const { data: storageRows } = useStorageStats();
  const storageRow = storageRows?.find((s) => s.channel_id === channel.id);

  // Per-channel rate-limit snapshot. Polls every 30s. We surface only
  // the *tightest* bucket on the card to keep the line short — the
  // full breakdown lives on ChannelDetail's Storage tab next phase.
  const { data: quotaRows } = useChannelQuota(channel.id);
  const tightestQuota = (() => {
    if (!quotaRows || quotaRows.length === 0) return null;
    // Find the bucket whose `tokens_available / capacity` is lowest.
    // That's the one closest to running out, which is what the
    // operator wants to know about.
    let worst: (typeof quotaRows)[number] | null = null;
    let worstRatio = Infinity;
    for (const q of quotaRows) {
      if (q.capacity <= 0) continue;
      const ratio = q.tokens_available / q.capacity;
      if (ratio < worstRatio) {
        worstRatio = ratio;
        worst = q;
      }
    }
    // Only show when usefully informative — at full capacity the
    // line just adds noise. 70% threshold = "you've burned 30% or
    // more of your budget".
    if (!worst || worstRatio >= 0.7) return null;
    return worst;
  })();
  // Friendlier provider names for display.
  const PROVIDER_LABEL: Record<string, string> = {
    youtube_upload: "YT upload",
    youtube_api: "YT API",
    claude_cli: "Claude",
    openai_dalle: "DALL·E",
    suno: "Suno",
  };
  const { data: primaryPreset } = useChannelPrimaryPreset(channel.id);
  const { data: vizPresets } = useVisualizerPresets(channel.id);
  const defaultVizPreset =
    vizPresets?.find((p) => p.is_default) ?? vizPresets?.[0] ?? null;
  const updateVizPreset = useUpdateVisualizerPreset();
  const uploadAsset = useUploadAsset();
  const overlayInputRef = useRef<HTMLInputElement | null>(null);

  // Live preview of the next-up image (auto-rotates daily server-side)
  const { data: preview, refetch: refetchPreview } = useQuickGenPreview(channel.id);

  const [taskId, setTaskId] = useState<number | null>(null);
  const [triggering, setTriggering] = useState(false);
  const [rerolling, setRerolling] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Phase 1: preview-drawer state. The dashboard's "Generate now" button
  // now opens a drawer that shows the would-be title/description/tags/
  // image/thumbnail BEFORE firing compose. Approve commits with the
  // approved package; Re-roll fetches a fresh preview.
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewPkg, setPreviewPkg] = useState<QuickGenPreviewFull | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const previewMut = useQuickGenPreviewFull();
  const { data: task } = useTask(taskId ?? undefined);
  const stillRunning =
    task && (task.status === "running" || task.status === "pending");
  const lastFailed = task?.status === "failed";

  // Phase 1: "Last generation" diagnostic — most-recent automation_run
  // task on this channel, completed or otherwise. Used to render a
  // one-line readout below the Generate button so the operator can see
  // what voice/bandit/thumbnail picks last ran without opening Runs.
  const { data: lastRun } = useLastChannelRun(channel.id);

  // Phase 1: settings dialog reorg — collapse rarely-touched controls
  // (FPS, particles, color, terse-meta, translate, viz preset, corner
  // overlay) behind an Advanced disclosure so the dialog opens at a
  // human-scannable height. State persists per-channel in localStorage
  // so the operator who lives in Advanced doesn't get re-collapsed on
  // every page refresh.
  const advancedKey = `qg-advanced-open-${channel.id}`;
  const [advancedOpen, setAdvancedOpen] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    return window.localStorage.getItem(advancedKey) === "1";
  });
  const toggleAdvanced = useCallback(() => {
    setAdvancedOpen((open) => {
      const next = !open;
      try {
        window.localStorage.setItem(advancedKey, next ? "1" : "0");
      } catch {
        /* localStorage may be unavailable (incognito etc.) */
      }
      return next;
    });
  }, [advancedKey]);

  // Local working copy of preset settings; debounced-saved to backend
  const [draft, setDraft] = useState<QuickGenPreset | null>(
    primaryPreset
      ? (primaryPreset as unknown as QuickGenPreset)
      : null,
  );
  useEffect(() => {
    if (primaryPreset) {
      setDraft(primaryPreset as unknown as QuickGenPreset);
    }
  }, [primaryPreset]);

  // Resolve the preset currently driving the channel's Quick Generate
  // run — the explicit ``visualizer_preset_id`` if set, otherwise the
  // channel default. This is the preset whose overlay config we edit
  // when the user clicks the inline overlay buttons.
  const activeVizPreset =
    (draft?.visualizer_preset_id != null
      ? vizPresets?.find((p) => p.id === draft.visualizer_preset_id)
      : null) ?? defaultVizPreset;
  const activeOverlayMode: "none" | "subscribe" | "custom" = (() => {
    const c = (activeVizPreset?.config ?? {}) as Record<string, unknown>;
    if (!c.overlayEnabled) return "none";
    if (c.overlayBuiltin === "subscribe") return "subscribe";
    if (c.overlay_filepath) return "custom";
    return "none";
  })();

  const setOverlayMode = async (
    mode: "none" | "subscribe" | "custom",
    overlayPath?: string,
  ) => {
    if (!activeVizPreset) {
      toast.error("No visualizer preset to update — save one first");
      return;
    }
    const baseConfig = (activeVizPreset.config ?? {}) as Record<string, unknown>;
    const nextConfig: Record<string, unknown> = { ...baseConfig };
    if (mode === "none") {
      nextConfig.overlayEnabled = false;
      nextConfig.overlayBuiltin = null;
      nextConfig.overlay_filepath = null;
    } else if (mode === "subscribe") {
      nextConfig.overlayEnabled = true;
      nextConfig.overlayBuiltin = "subscribe";
      nextConfig.overlay_filepath = null;
    } else if (mode === "custom" && overlayPath) {
      nextConfig.overlayEnabled = true;
      nextConfig.overlayBuiltin = null;
      nextConfig.overlay_filepath = overlayPath;
    }
    try {
      await updateVizPreset.mutateAsync({
        id: activeVizPreset.id,
        body: { config: nextConfig },
      });
      toast.success(
        mode === "none"
          ? "Overlay removed from preset"
          : mode === "subscribe"
            ? "Subscribe overlay set & locked"
            : "Custom overlay set & locked",
      );
    } catch {
      toast.error("Couldn't update preset");
    }
  };

  // Patch a subset of the active preset's config — used for the
  // position / scale / opacity tweaks. Reads the latest preset from
  // the cache so concurrent edits don't clobber each other.
  const patchVizPresetConfig = async (patch: Record<string, unknown>) => {
    if (!activeVizPreset) return;
    const baseConfig = (activeVizPreset.config ?? {}) as Record<string, unknown>;
    try {
      await updateVizPreset.mutateAsync({
        id: activeVizPreset.id,
        body: { config: { ...baseConfig, ...patch } },
      });
    } catch {
      toast.error("Couldn't save overlay change");
    }
  };

  // Optimistically update the cached preset config so the preview
  // reflects slider drags BEFORE the server save commits. Mirrors the
  // pattern react-query exposes via setQueryData. Without this the
  // overlay preview would only redraw after the user releases the
  // slider, which felt frozen.
  const overlayPatchLocal = (patch: Record<string, unknown>) => {
    if (!activeVizPreset) return;
    queryClient.setQueryData<VisualizerPreset[]>(
      ["visualizer-presets", channel.id],
      (prev) =>
        prev?.map((p) =>
          p.id === activeVizPreset.id
            ? {
                ...p,
                config: { ...(p.config ?? {}), ...patch } as VisualizerPreset["config"],
              }
            : p,
        ) ?? prev,
    );
  };

  const handleOverlayUpload = async (
    e: React.ChangeEvent<HTMLInputElement>,
  ) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      toast.error("Use a PNG or WebP with alpha");
      return;
    }
    if (file.size > 10 * 1024 * 1024) {
      toast.error("Overlay too large (max 10MB)");
      return;
    }
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("channel_id", String(channel.id));
      fd.append("asset_type", "image");
      fd.append("replace_existing", "true");
      const asset = await uploadAsset.mutateAsync(fd);
      await setOverlayMode("custom", asset.filepath);
    } catch {
      toast.error("Upload failed");
    }
  };

  // Ensure a preset exists when the user opens the settings panel; needed
  // before any PATCH calls would otherwise 404.
  const ensurePreset = useCallback(async () => {
    if (draft?.id) return draft;
    const { data } = await api.post(
      `/automation/channels/${channel.id}/ensure-quick-generate-preset`,
    );
    setDraft(data as QuickGenPreset);
    queryClient.invalidateQueries({ queryKey: ["channel-primary-preset", channel.id] });
    return data as QuickGenPreset;
  }, [draft, channel.id, queryClient]);

  // Debounced save: when draft changes, PATCH the preset 350ms after last edit.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const saveDraftRef = useRef<QuickGenPreset | null>(null);
  saveDraftRef.current = draft;
  const queueSave = useCallback(
    (next: Partial<QuickGenPreset>) => {
      setDraft((prev) => (prev ? { ...prev, ...next } : prev));
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
      saveTimerRef.current = setTimeout(async () => {
        const ensured = await ensurePreset();
        const merged = { ...ensured, ...saveDraftRef.current, ...next };
        try {
          await api.put(`/automation/presets/${ensured.id}`, {
            target_duration_seconds: merged.target_duration_seconds,
            num_tracks: merged.num_tracks ?? null,
            visualizer_color_override: merged.visualizer_color_override ?? null,
            visualizer_disabled: merged.visualizer_disabled ?? false,
            particle_style: merged.particle_style ?? null,
            particle_density: merged.particle_density ?? null,
            default_thumbnail_asset_id: merged.default_thumbnail_asset_id ?? null,
            output_fps: merged.output_fps ?? null,
            auto_upload: merged.auto_upload,
            scheduled_publish_at: merged.scheduled_publish_at ?? null,
            next_image_asset_id: merged.next_image_asset_id ?? null,
            next_image_pinned: merged.next_image_pinned ?? false,
            visualizer_preset_id: merged.visualizer_preset_id ?? null,
            auto_translate_languages: merged.auto_translate_languages ?? null,
            // Recurring schedule. Either may be null when the user
            // turns the schedule off; the API accepts that and clears
            // ``next_run_at`` server-side.
            schedule_cron: merged.schedule_cron ?? null,
            schedule_timezone: merged.schedule_timezone ?? "UTC",
            // Folder pairing was removed in Phase 0 of the farm
            // redesign. Always send false so any DB row with the
            // legacy flag still set gets cleared on the next save.
            use_folder_pairing: false,
            // Phase 5: opt in to AssetSet-driven bg+thumbnail picks.
            use_asset_sets: merged.use_asset_sets ?? false,
            // Operator UX (2026-05-15) toggles.
            skip_preview_drawer: merged.skip_preview_drawer ?? false,
            auto_generate_thumbnail: merged.auto_generate_thumbnail ?? true,
            // Phase 7: thumbnail-template auto-generator config.
            // The editor saves this directly via its own PUT, but we
            // forward whatever draft holds so other queueSave-driven
            // edits don't accidentally clear the template.
            thumbnail_template: merged.thumbnail_template ?? null,
            // Phase 3: shorter metadata cap.
            terse_metadata: merged.terse_metadata ?? false,
          });
          queryClient.invalidateQueries({
            queryKey: ["channel-primary-preset", channel.id],
          });
        } catch {
          toast.error("Couldn't save settings — try again");
        }
      }, 350);
    },
    [channel.id, ensurePreset, queryClient],
  );

  const handleReroll = async () => {
    setRerolling(true);
    try {
      const { data } = await api.post(
        `/automation/channels/${channel.id}/quick-generate-preview/reroll`,
      );
      // Optimistically swap so the image updates instantly
      queryClient.setQueryData<QuickGenPreview>(
        ["quick-gen-preview", channel.id],
        (prev) =>
          prev
            ? { ...prev, image: data.image, rotated: false, pinned: false }
            : { image: data.image, rotated: false, preset_id: data.preset_id, pinned: false },
      );
      // The reroll endpoint clears any existing image lock — sync local
      // draft so the lock indicator flips off without a round-trip.
      setDraft((prev) =>
        prev ? { ...prev, next_image_pinned: false, next_image_asset_id: data.image?.id ?? null } : prev,
      );
      refetchPreview();
    } catch {
      toast.error("Couldn't pick a new image");
    } finally {
      setRerolling(false);
    }
  };

  // Toggle the image lock. Locked = the dashboard never auto-rotates the
  // pinned image; only an explicit reroll changes it. Useful for series-
  // style channels where every video uses the same backdrop.
  const handleToggleLock = async () => {
    if (!preview?.image) return;
    const ensured = await ensurePreset();
    const nextPinned = !(draft?.next_image_pinned ?? false);
    try {
      await api.put(`/automation/presets/${ensured.id}`, {
        next_image_asset_id: preview.image.id,
        next_image_pinned: nextPinned,
      });
      setDraft((prev) =>
        prev ? { ...prev, next_image_pinned: nextPinned, next_image_asset_id: preview.image!.id } : prev,
      );
      queryClient.setQueryData<QuickGenPreview>(
        ["quick-gen-preview", channel.id],
        (prev) => (prev ? { ...prev, pinned: nextPinned } : prev),
      );
      toast.success(nextPinned ? "Image locked — won't rotate" : "Image unlocked — daily rotation resumed");
    } catch {
      toast.error("Couldn't update lock");
    }
  };

  // Manual background picker — opens a thumbnail dialog of the
  // channel's image + video assets. Picking one calls the
  // ``/quick-generate-preview/set`` endpoint which auto-locks the
  // pick (next_image_pinned=true), since picking explicitly almost
  // always implies "use this for the next render(s)".
  const [pickerOpen, setPickerOpen] = useState(false);
  const { data: bgImages } = useAssets({
    channel_id: String(channel.id),
    asset_type: "image",
  });
  const { data: bgVideos } = useAssets({
    channel_id: String(channel.id),
    asset_type: "video",
  });
  const bgChoices = [...(bgVideos ?? []), ...(bgImages ?? [])];
  const handlePickBackground = async (assetId: number) => {
    try {
      const { data } = await api.post(
        `/automation/channels/${channel.id}/quick-generate-preview/set`,
        { asset_id: assetId },
      );
      queryClient.setQueryData<QuickGenPreview>(
        ["quick-gen-preview", channel.id],
        (prev) =>
          prev
            ? { ...prev, image: data.image, rotated: false, pinned: true }
            : { image: data.image, rotated: false, preset_id: data.preset_id, pinned: true },
      );
      setDraft((prev) =>
        prev
          ? { ...prev, next_image_pinned: true, next_image_asset_id: assetId }
          : prev,
      );
      setPickerOpen(false);
      toast.success("Background set & locked");
    } catch {
      toast.error("Couldn't set that background");
    }
  };

  /** Open the Phase-1 preview drawer with a fresh package. */
  const handleOpenPreview = async () => {
    setPreviewOpen(true);
    setPreviewError(null);
    setPreviewPkg(null);
    try {
      const pkg = await previewMut.mutateAsync(channel.id);
      setPreviewPkg(pkg);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Couldn't build a preview";
      setPreviewError(typeof msg === "string" ? msg : "Couldn't build a preview");
    }
  };

  /** Re-roll: fetch a new preview (different image/tracks/metadata). */
  const handlePreviewReroll = async () => {
    setPreviewError(null);
    setPreviewPkg(null);
    try {
      const pkg = await previewMut.mutateAsync(channel.id);
      setPreviewPkg(pkg);
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Re-roll failed";
      setPreviewError(typeof msg === "string" ? msg : "Re-roll failed");
    }
  };

  /** Commit the previewed package — fires the real compose+upload run.
   *  Phase 7: when the drawer renders a template thumbnail, it uploads
   *  the JPEG first and passes the new {asset_id, file_url} back here.
   *  We splice that into approved_package.thumbnail so the compose
   *  task picks up the freshly-rendered thumbnail instead of the
   *  channel's sticky one. */
  const handleApprovePreview = async (
    thumbnailOverride?: { asset_id: number; file_url: string } | null,
  ) => {
    if (!previewPkg) return;
    setTriggering(true);
    try {
      const pkgToSend = thumbnailOverride
        ? {
            ...previewPkg,
            thumbnail: {
              asset_id: thumbnailOverride.asset_id,
              file_url: thumbnailOverride.file_url,
            },
          }
        : previewPkg;
      const { data } = await api.post(
        `/automation/channels/${channel.id}/quick-generate`,
        { approved_package: pkgToSend },
      );
      setTaskId(data.task_id);
      setPreviewOpen(false);
      setPreviewPkg(null);
      toast.success(
        thumbnailOverride
          ? "Generating with approved preview + template thumbnail…"
          : "Generating with approved preview…",
      );
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Failed to start generation";
      toast.error(typeof msg === "string" ? msg : "Failed to start generation");
    } finally {
      setTriggering(false);
    }
  };

  /** Direct fire — bypasses the preview drawer. Used when the channel
   *  has skip_preview_drawer=true (operator opted out per-channel
   *  because they trust the auto pipeline). The compose task gets a
   *  fresh random pick on the backend side. */
  const handleDirectFire = async () => {
    setTriggering(true);
    try {
      const { data } = await api.post(
        `/automation/channels/${channel.id}/quick-generate`,
      );
      setTaskId(data.task_id);
      toast.success("Generating (preview skipped)…");
    } catch (err: unknown) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Failed to start generation";
      toast.error(typeof msg === "string" ? msg : "Failed to start generation");
    } finally {
      setTriggering(false);
    }
  };

  /** The Generate-now button's behavior: route through the preview
   *  drawer by default, but honor the per-channel skip_preview_drawer
   *  toggle when the operator has opted out. */
  const handleGenerate = () => {
    if (draft?.skip_preview_drawer) {
      void handleDirectFire();
    } else {
      void handleOpenPreview();
    }
  };

  // Pre-flight: count music + background assets so we can warn early
  // and disable Generate when a channel literally has nothing to work
  // with. Avoids the user clicking Generate, waiting 30 s for a deep
  // ValueError, and having to read the FailedTasksPanel to find out
  // they need to upload something. Cheap: one grouped COUNT query
  // cached for 60 s.
  const { data: assetCounts } = useQuery<{
    music: number;
    image: number;
    video: number;
    background: number;
  }>({
    queryKey: ["asset-counts", channel.id],
    queryFn: async () => {
      const { data } = await api.get("/assets/counts", {
        params: { channel_id: channel.id },
      });
      return data;
    },
    staleTime: 60_000,
  });
  const preflightMissing: string[] = [];
  if (assetCounts) {
    if (assetCounts.music === 0) preflightMissing.push("music");
    if (assetCounts.background === 0) preflightMissing.push("backgrounds");
  }
  const preflightBlocked = preflightMissing.length > 0;
  const canGenerate = !stillRunning && !preflightBlocked;

  // Color override: read primary color from override or fall back
  const currentColor =
    (draft?.visualizer_color_override?.linearBarColor as string) ?? "#ff4444";

  // Schedule helpers — convert ISO ↔ "YYYY-MM-DDTHH:mm" for <input type="datetime-local">
  const scheduledLocal = draft?.scheduled_publish_at
    ? new Date(draft.scheduled_publish_at).toISOString().slice(0, 16)
    : "";

  return (
    <Card className="overflow-hidden">
      <CardHeader className="pb-3">
        <div
          className="flex cursor-pointer items-start justify-between gap-2"
          onClick={() => navigate(`/channels/${channel.id}`)}
        >
          <div className="min-w-0 flex-1">
            <CardTitle className="truncate text-base">{channel.name}</CardTitle>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {nicheLabel}
              {storageRow && (
                <span title={`${storageRow.asset_count} assets`}>
                  {" · "}
                  {formatBytes(storageRow.total_bytes)}
                </span>
              )}
            </p>
            {tightestQuota && (
              <p
                className="mt-0.5 text-[10px] text-amber-500"
                title={`${PROVIDER_LABEL[tightestQuota.provider] ?? tightestQuota.provider}: ${tightestQuota.tokens_available.toFixed(1)} / ${tightestQuota.capacity} (refills ${tightestQuota.rate_per_minute}/min)`}
              >
                Quota:{" "}
                {PROVIDER_LABEL[tightestQuota.provider] ?? tightestQuota.provider}{" "}
                {Math.floor(tightestQuota.tokens_available)}/{tightestQuota.capacity}
              </p>
            )}
          </div>
          <Badge variant="secondary" className="shrink-0 text-[10px]">
            {projectCount} {projectCount === 1 ? "video" : "videos"}
          </Badge>
        </div>
      </CardHeader>

      {/* Live preview of the image that WILL be used on next generate.
          Reload icon top-right re-rolls the random pick. Server-side this
          auto-rotates once a day too. */}
      <div
        className="group relative mx-4 mb-3 overflow-hidden rounded-md bg-muted"
        style={{ aspectRatio: "16/9" }}
        title={
          preview?.image
            ? `Will use: ${preview.image.title || preview.image.filename}`
            : "Add images to the channel library"
        }
      >
        {preview?.image ? (
          preview.image.asset_type === "video" ? (
            <video
              src={preview.image.file_url}
              className="h-full w-full object-cover"
              autoPlay
              muted
              loop
              playsInline
              onError={(e) => {
                (e.currentTarget as HTMLVideoElement).style.display = "none";
              }}
            />
          ) : (
            <img
              src={preview.image.file_url}
              alt={preview.image.title || preview.image.filename}
              className="h-full w-full object-cover"
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = "none";
              }}
            />
          )
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-1 text-muted-foreground">
            <Tv className="size-6 opacity-40" />
            <span className="text-[11px] opacity-60">
              {defaultVizPreset
                ? `Preset: ${defaultVizPreset.name}`
                : "No images in library"}
            </span>
          </div>
        )}

        {/* Live overlay preview — mirrors what the offline render will
            do with the active preset's overlay config so the user can
            see scale / opacity / position changes WITHOUT composing a
            test video. Subscribe builtin uses the bundled webm; custom
            uses /files/{filepath}. Position is corner-pinned with a
            small inset so the overlay doesn't overflow the tile. */}
        {activeOverlayMode !== "none" && activeVizPreset && (() => {
          const cfg = (activeVizPreset.config ?? {}) as Record<string, unknown>;
          const pos = (cfg.overlayPosition as string) ?? "bottom-right";
          const scale = Number(cfg.overlayScale ?? 0.5);
          const opacity = Number(cfg.overlayOpacity ?? 0.8);
          const overlaySrc =
            activeOverlayMode === "subscribe"
              ? "/subscribe-animation.webm"
              : cfg.overlay_filepath
                ? `/files/${cfg.overlay_filepath}`
                : null;
          if (!overlaySrc) return null;
          // Position styles. Two modes:
          //   - "custom" (the dashboard X/Y inputs): X/Y are the
          //     ABSOLUTE position of the overlay's top-left corner as %
          //     of canvas. Mirrors the engine's custom branch so the
          //     preview tracks the inputs faithfully.
          //   - One of the four corner names (legacy / wizard-saved):
          //     pin to that corner with a 3% safe-area inset, matching
          //     the engine's ``W * 0.03`` margin.
          const posStyle: React.CSSProperties = (() => {
            if (pos === "custom") {
              const x = Number(cfg.overlayOffsetX ?? 0);
              const y = Number(cfg.overlayOffsetY ?? 0);
              return { left: `${x}%`, top: `${y}%` };
            }
            const m = "3%";
            switch (pos) {
              case "top-left":     return { top: m, left: m };
              case "top-right":    return { top: m, right: m };
              case "bottom-left":  return { bottom: m, left: m };
              default:             return { bottom: m, right: m };
            }
          })();
          // Width as % of the tile — must match the engine's actual
          // rendering math so the preview is honest. Engine bounding box:
          //   maxSize = min(W, H) * 0.12 * overlayScale
          // For a 16:9 video tile (tile-height = tile-width * 9/16) that
          // works out to ≈ scale * 6.75% of tile-width for a wide
          // overlay (e.g. a subscribe button). Without this the preview
          // looked ~7× bigger than the rendered output, leading you to
          // dial scale way too low and end up with an invisible overlay
          // in the final video.
          const widthPct = Math.max(0.5, Math.min(100, scale * 6.75));
          const isVideo =
            overlaySrc.endsWith(".webm") || overlaySrc.endsWith(".mp4");
          return (
            <div
              className="pointer-events-none absolute"
              style={{ width: `${widthPct}%`, opacity, ...posStyle }}
            >
              {isVideo ? (
                <video
                  src={overlaySrc}
                  className="h-auto w-full object-contain"
                  autoPlay
                  muted
                  loop
                  playsInline
                />
              ) : (
                <img
                  src={overlaySrc}
                  alt="overlay preview"
                  className="h-auto w-full object-contain"
                />
              )}
            </div>
          );
        })()}

        {/* Reroll + lock button row.
            - Reroll picks a new random image (and clears any existing lock).
            - Lock freezes the current image so the daily auto-rotation
              doesn't change it. Useful for series channels that always
              use the same backdrop.
            When LOCKED, the lock icon is always visible (yellow); when
            unlocked, both buttons fade in on hover. */}
        {preview?.image && (
          <div className="absolute right-2 top-2 flex gap-1">
            <button
              type="button"
              onClick={handleToggleLock}
              className={cn(
                "rounded-md p-1.5 text-white transition disabled:cursor-wait",
                draft?.next_image_pinned
                  ? "bg-yellow-500/80 opacity-100 hover:bg-yellow-500"
                  : "bg-black/60 opacity-0 group-hover:opacity-100 hover:bg-black/80",
              )}
              title={
                draft?.next_image_pinned
                  ? "Image locked — click to allow auto-rotation"
                  : "Lock this image — Quick Generate will keep using it"
              }
            >
              {draft?.next_image_pinned ? (
                <Lock className="size-3.5" />
              ) : (
                <Unlock className="size-3.5" />
              )}
            </button>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="rounded-md bg-black/60 p-1.5 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/80"
              title="Pick a specific background from the library"
            >
              <ImageIcon className="size-3.5" />
            </button>
            <button
              type="button"
              onClick={handleReroll}
              disabled={rerolling}
              className="rounded-md bg-black/60 p-1.5 text-white opacity-0 transition group-hover:opacity-100 hover:bg-black/80 disabled:cursor-wait"
              title="Pick a new random image (clears the lock)"
            >
              {rerolling ? (
                <Loader2 className="size-3.5 animate-spin" />
              ) : (
                <RefreshCw className="size-3.5" />
              )}
            </button>
          </div>
        )}

        {/* Bottom strip with image filename */}
        {preview?.image && (
          <div className="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-2 pb-1.5 pt-3">
            <p className="truncate text-[11px] font-medium text-white">
              {preview.image.title || preview.image.filename}
            </p>
          </div>
        )}
      </div>

      <CardContent className="space-y-3">
        {/* Status row — connection + summary line that doubles as the settings toggle */}
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-1.5">
              {channel.youtube_connected ? (
                <CheckCircle2 className="size-3.5 text-green-500" />
              ) : (
                <XCircle className="size-3.5 text-destructive" />
              )}
              <span
                className={
                  channel.youtube_connected
                    ? "text-green-500"
                    : "text-destructive"
                }
              >
                {channel.youtube_connected ? "YouTube" : "Not connected"}
              </span>
              <span className="text-muted-foreground">·</span>
              <Clock className="size-3 text-muted-foreground" />
              <span className="text-muted-foreground">
                {(() => {
                  const s = draft?.target_duration_seconds ?? 3600;
                  if (s < 60) return `${s}s`;
                  if (s >= 3600) return `${Math.round(s / 3600)}h`;
                  return `${Math.round(s / 60)}m`;
                })()}
              </span>
              {draft?.num_tracks ? (
                <>
                  <span className="text-muted-foreground">·</span>
                  <Music className="size-3 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {draft.num_tracks} song{draft.num_tracks !== 1 ? "s" : ""}
                  </span>
                </>
              ) : null}
            </div>
            <button
              type="button"
              onClick={() => setSettingsOpen((v) => !v)}
              className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
              title="Edit Quick Generate settings"
            >
              <Sliders className="size-3" />
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  settingsOpen && "rotate-180",
                )}
              />
            </button>
          </div>
        </div>

        {/* Quick Generate settings dialog. Same form state, same
            ``queueSave`` plumbing — we just moved the inline-expand
            panel into a Dialog so 5–10 channel cards fit on a
            1440x900 screen without one expanded card pushing the rest
            off-screen. The DialogContent has its own scrollbar for
            long panels. */}
        <Dialog open={settingsOpen} onOpenChange={setSettingsOpen}>
          <DialogContent className="max-h-[85vh] max-w-md overflow-y-auto">
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2 text-sm">
                <Sliders className="size-4" /> {channel.name} settings
              </DialogTitle>
            </DialogHeader>
            <div className="space-y-3 rounded-md border border-border/60 bg-muted/20 p-2.5">
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Clock className="size-3" /> Target duration
              </Label>
              <div className="flex flex-wrap gap-1">
                {DURATION_OPTIONS.map((opt) => {
                  const sel = (draft?.target_duration_seconds ?? 3600) === opt.seconds;
                  return (
                    <button
                      key={opt.seconds}
                      onClick={() =>
                        queueSave({ target_duration_seconds: opt.seconds })
                      }
                      className={cn(
                        "rounded px-2 py-0.5 text-[11px] transition",
                        sel
                          ? "bg-primary text-primary-foreground"
                          : "border border-border/50 text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {opt.label}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Music className="size-3" /> Songs per video
                <span className="ml-1 text-muted-foreground">
                  (blank = fill duration)
                </span>
              </Label>
              <Input
                type="number"
                min={1}
                max={100}
                placeholder="auto"
                value={draft?.num_tracks ?? ""}
                onChange={(e) => {
                  const v = e.target.value;
                  queueSave({ num_tracks: v === "" ? null : Math.max(1, Number(v)) });
                }}
                className="h-7 text-xs"
              />
            </div>

            {advancedOpen && (
            <>
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Sparkles className="size-3" /> Visualizer preset
              </Label>
              <select
                value={
                  draft?.visualizer_preset_id != null
                    ? String(draft.visualizer_preset_id)
                    : "__default__"
                }
                onChange={(e) => {
                  const v = e.target.value;
                  queueSave({
                    visualizer_preset_id: v === "__default__" ? null : Number(v),
                  });
                }}
                className="h-7 w-full rounded border border-border/50 bg-background px-2 text-xs"
                disabled={draft?.visualizer_disabled}
              >
                <option value="__default__">
                  ★ Channel default
                  {defaultVizPreset ? ` (${defaultVizPreset.name})` : ""}
                </option>
                {(vizPresets ?? []).map((vp) => (
                  <option key={vp.id} value={String(vp.id)}>
                    {vp.name}
                  </option>
                ))}
              </select>
              <p className="text-[10px] text-muted-foreground">
                Picks the visualizer style + colors + subscribe overlay
                from a saved preset. Image &amp; audio are still chosen
                automatically.
              </p>
            </div>

            {/* Inline overlay controls. Edits the *active* visualizer
                preset's config so the change sticks across every Quick
                Generate run that uses this preset. Three modes:
                  - None     → overlayEnabled=false
                  - Subscribe → overlayBuiltin="subscribe" (ships with app)
                  - Custom    → uploads the file and sets overlay_filepath
                Saves are atomic; activeVizPreset re-renders from the
                refreshed cache after the mutation. */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Sparkles className="size-3" /> Corner overlay
              </Label>
              <div className="flex flex-wrap gap-1">
                <button
                  type="button"
                  onClick={() => setOverlayMode("none")}
                  disabled={updateVizPreset.isPending || !activeVizPreset}
                  className={cn(
                    "rounded border px-2 py-1 text-[11px] transition disabled:opacity-50",
                    activeOverlayMode === "none"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/50 hover:border-primary",
                  )}
                >
                  None
                </button>
                <button
                  type="button"
                  onClick={() => setOverlayMode("subscribe")}
                  disabled={updateVizPreset.isPending || !activeVizPreset}
                  className={cn(
                    "rounded border px-2 py-1 text-[11px] transition disabled:opacity-50",
                    activeOverlayMode === "subscribe"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/50 hover:border-primary",
                  )}
                >
                  ▶ Subscribe
                </button>
                <button
                  type="button"
                  onClick={() => overlayInputRef.current?.click()}
                  disabled={
                    uploadAsset.isPending ||
                    updateVizPreset.isPending ||
                    !activeVizPreset
                  }
                  className={cn(
                    "rounded border px-2 py-1 text-[11px] transition disabled:opacity-50",
                    activeOverlayMode === "custom"
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/50 hover:border-primary",
                  )}
                >
                  {uploadAsset.isPending
                    ? "Uploading…"
                    : activeOverlayMode === "custom"
                      ? "Custom (replace)"
                      : "Upload custom"}
                </button>
                <input
                  ref={overlayInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleOverlayUpload}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                {activeVizPreset
                  ? `Saved to "${activeVizPreset.name}" — every render using this preset gets the overlay.`
                  : "No visualizer preset on this channel yet — save one first."}
              </p>

              {/* Position / scale / opacity — only shown when an overlay
                  is actually enabled. Each control writes a single field
                  back into the preset config so the change is atomic and
                  the live cache stays in sync. Defaults match the engine's
                  DEFAULT_PROJECT_CONFIG (bottom-right, 0.5 scale, 0.8
                  opacity) so users only see the actual saved values. */}
              {activeOverlayMode !== "none" && activeVizPreset && (() => {
                const cfg = (activeVizPreset.config ?? {}) as Record<string, unknown>;
                // First time the user opens this panel after the corner-
                // buttons UX, ``overlayPosition`` may still be one of the
                // legacy corner names. Treat anything that isn't already
                // "custom" as "needs migration" — read the live X/Y from
                // the rendered position so the inputs aren't stuck at 0,0.
                const isCustom = cfg.overlayPosition === "custom";
                // Live X/Y in % of canvas. In custom mode these are
                // ``overlayOffsetX`` / ``overlayOffsetY`` directly. In
                // legacy corner mode we synthesise a sensible starting
                // value by mapping the corner to a percentage so the UI
                // doesn't show 0,0 for an overlay that's actually pinned
                // to bottom-right at scale 1.5.
                const xPct = isCustom
                  ? Number(cfg.overlayOffsetX ?? 0)
                  : (() => {
                      const pos = String(cfg.overlayPosition ?? "bottom-right");
                      return pos.endsWith("right") ? 80 : 3;
                    })();
                const yPct = isCustom
                  ? Number(cfg.overlayOffsetY ?? 0)
                  : (() => {
                      const pos = String(cfg.overlayPosition ?? "bottom-right");
                      return pos.startsWith("bottom") ? 85 : 3;
                    })();
                const scale = Number(cfg.overlayScale ?? 0.5);
                const opacity = Number(cfg.overlayOpacity ?? 0.8);
                return (
                  <div className="space-y-2 rounded border border-border/40 bg-background/40 p-2">
                    <div className="grid grid-cols-2 gap-2">
                      <div>
                        <Label className="text-[10px]">X position (%)</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={Number(xPct.toFixed(2))}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            // Switch to absolute mode + write the new X.
                            // Y comes along too so an in-progress legacy
                            // migration doesn't lose its synthesised
                            // starting Y on the first edit.
                            overlayPatchLocal({
                              overlayPosition: "custom",
                              overlayOffsetX: v,
                              overlayOffsetY: yPct,
                            });
                          }}
                          onBlur={(e) =>
                            patchVizPresetConfig({
                              overlayPosition: "custom",
                              overlayOffsetX: Number(e.target.value),
                              overlayOffsetY: yPct,
                            })
                          }
                          className="h-7 text-[11px]"
                        />
                      </div>
                      <div>
                        <Label className="text-[10px]">Y position (%)</Label>
                        <Input
                          type="number"
                          min={0}
                          max={100}
                          step={0.1}
                          value={Number(yPct.toFixed(2))}
                          onChange={(e) => {
                            const v = Number(e.target.value);
                            overlayPatchLocal({
                              overlayPosition: "custom",
                              overlayOffsetX: xPct,
                              overlayOffsetY: v,
                            });
                          }}
                          onBlur={(e) =>
                            patchVizPresetConfig({
                              overlayPosition: "custom",
                              overlayOffsetX: xPct,
                              overlayOffsetY: Number(e.target.value),
                            })
                          }
                          className="h-7 text-[11px]"
                        />
                      </div>
                    </div>
                    <p className="text-[10px] text-muted-foreground">
                      0,0 = top-left. 100,100 = bottom-right edge of the
                      canvas (overlay will clip off-screen). For 1080p,
                      1% ≈ 19px horizontal · 11px vertical.
                    </p>
                    <div>
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px]">Scale</Label>
                        <span className="text-[10px] text-muted-foreground">
                          {scale.toFixed(2)}×
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.1}
                        max={5}
                        step={0.05}
                        value={scale}
                        onChange={(e) =>
                          overlayPatchLocal({
                            overlayScale: Number(e.target.value),
                          })
                        }
                        onMouseUp={(e) =>
                          patchVizPresetConfig({
                            overlayScale: Number((e.target as HTMLInputElement).value),
                          })
                        }
                        onTouchEnd={(e) =>
                          patchVizPresetConfig({
                            overlayScale: Number((e.target as HTMLInputElement).value),
                          })
                        }
                        className="h-1 w-full"
                      />
                    </div>
                    <div>
                      <div className="flex items-center justify-between">
                        <Label className="text-[10px]">Opacity</Label>
                        <span className="text-[10px] text-muted-foreground">
                          {Math.round(opacity * 100)}%
                        </span>
                      </div>
                      <input
                        type="range"
                        min={0.1}
                        max={1}
                        step={0.05}
                        value={opacity}
                        onChange={(e) =>
                          overlayPatchLocal({
                            overlayOpacity: Number(e.target.value),
                          })
                        }
                        onMouseUp={(e) =>
                          patchVizPresetConfig({
                            overlayOpacity: Number((e.target as HTMLInputElement).value),
                          })
                        }
                        onTouchEnd={(e) =>
                          patchVizPresetConfig({
                            overlayOpacity: Number((e.target as HTMLInputElement).value),
                          })
                        }
                        className="h-1 w-full"
                      />
                    </div>
                  </div>
                );
              })()}
            </div>

            </>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <Sparkles className="size-3" /> Audio-reactive visualizer
                </Label>
                <Switch
                  checked={!draft?.visualizer_disabled}
                  onCheckedChange={(v) =>
                    queueSave({ visualizer_disabled: !v })
                  }
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Off = no spectrum bars at the bottom. Particles (configured below) still render.
              </p>
            </div>

            {advancedOpen && (
            <>
            {/* Particle effect controls — independent of the visualizer
                toggle above. Set style + density so videos still have
                motion even when spectrum bars are off. Default = let
                the engine decide (subtle floating dots at density 50). */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Sparkles className="size-3" /> Particle effect
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <Select
                  value={draft?.particle_style ?? "default"}
                  onValueChange={(v) =>
                    queueSave({
                      particle_style: v === "default" ? null : v,
                    })
                  }
                >
                  <SelectTrigger className="h-7 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">Default (subtle)</SelectItem>
                    <SelectItem value="stars">Stars</SelectItem>
                    <SelectItem value="snow">Snow</SelectItem>
                    <SelectItem value="fireflies">Fireflies</SelectItem>
                    <SelectItem value="floating">Floating dots</SelectItem>
                    <SelectItem value="rain">Rain</SelectItem>
                    <SelectItem value="smoke">Smoke</SelectItem>
                  </SelectContent>
                </Select>
                <Input
                  type="number"
                  min={10}
                  max={100}
                  step={10}
                  placeholder="density"
                  className="h-7 text-[11px]"
                  value={draft?.particle_density ?? ""}
                  onChange={(e) => {
                    const v = e.target.value;
                    queueSave({
                      particle_density: v === "" ? null : Number(v),
                    });
                  }}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Style + density. Try Stars at 80 for a visible starry background.
              </p>
            </div>
            </>
            )}

            {/* Sticky default thumbnail — design once with the full
                canvas editor (text, fonts, effect presets), ships with
                every quick-generated video on this channel until you
                change it. Per-video override is still available in the
                wizard's Thumbnail step. */}
            <StickyThumbnailPicker
              channelId={channel.id}
              presetId={draft?.id ?? null}
              value={draft?.default_thumbnail_asset_id ?? null}
              editorState={draft?.default_thumbnail_editor_state ?? null}
              onChange={(id) => queueSave({ default_thumbnail_asset_id: id })}
            />

            {/* Phase 7: Thumbnail template auto-generator. When set,
                Quick Generate's preview drawer renders a fresh JPEG
                per video from this template (wordmark + bottom stamp
                + corner tags + rotating colour pool). Falls back to
                the sticky thumbnail above when not configured. */}
            <ThumbnailTemplateEditor
              presetId={draft?.id ?? null}
              value={
                (draft?.thumbnail_template ?? null) as unknown as
                  | ThumbnailTemplate
                  | null
              }
              sampleBgUrl={preview?.image?.file_url ?? null}
              onSaved={(next) =>
                setDraft((d) =>
                  d
                    ? ({
                        ...d,
                        thumbnail_template: next as unknown as
                          | Record<string, unknown>
                          | null,
                      } as typeof d)
                    : d,
                )
              }
            />

            {/* Phase 5: Asset Sets toggle. When on, Quick Generate
                picks a random active set (bg+thumbnail tuple) from
                this channel's Sets library instead of independently
                picking a background + the sticky thumbnail above.
                Sticky stays as a fallback when no active set exists. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <ImageIcon className="size-3" /> Use Asset Sets
                </Label>
                <Switch
                  checked={Boolean(draft?.use_asset_sets)}
                  onCheckedChange={(v) => queueSave({ use_asset_sets: v })}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Pair bg + thumbnail combos in Library → Sets. Quick
                Generate will pick one set at random for each render.
                Falls back to the sticky thumbnail when no active set
                exists.
              </p>
            </div>

            {/* Operator UX (2026-05-15): bypass the preview-before-
                generate drawer when the operator trusts the auto
                pipeline and finds the confirm step annoying. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <Zap className="size-3" /> Skip preview drawer
                </Label>
                <Switch
                  checked={Boolean(draft?.skip_preview_drawer)}
                  onCheckedChange={(v) => queueSave({ skip_preview_drawer: v })}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                When on, "Generate now" fires compose immediately
                instead of showing the preview drawer. Faster but you
                won't see the title/description until after compose.
              </p>
            </div>

            {/* Operator UX (2026-05-15): gate the Phase-7b template
                renderer. When off, sticky thumbnail (if any) is used
                instead. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <ImageIcon className="size-3" /> Auto-generate thumbnail
                </Label>
                <Switch
                  checked={Boolean(draft?.auto_generate_thumbnail ?? true)}
                  onCheckedChange={(v) =>
                    queueSave({ auto_generate_thumbnail: v })
                  }
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                When on, every render produces a fresh templated
                thumbnail JPEG (Phase 7b template above). When off,
                Quick Generate uses the sticky thumbnail.
              </p>
            </div>

            {/* Folder pairing was removed in Phase 0 of the farm
                redesign. The schema column lingers but no UI reads or
                writes it. Backgrounds reuse freely; track selection
                is channel-wide. */}

            {advancedOpen && (
            <>
            {/* Shorter metadata. Caps title/desc/tags lengths so the
                output fits on screen and is easier to scan. Channel
                voice still drives style; this is a length nudge. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <Sparkles className="size-3" /> Shorter titles & descriptions
                </Label>
                <Switch
                  checked={Boolean(draft?.terse_metadata)}
                  onCheckedChange={(v) => queueSave({ terse_metadata: v })}
                />
              </div>
              <p className="text-[10px] text-muted-foreground">
                Caps title under 40 chars, description under 200 words,
                tags at 8. Channel voice still drives style.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Clock className="size-3" /> Frame rate
              </Label>
              <div className="flex flex-wrap gap-1">
                {FPS_OPTIONS.map((fps) => {
                  const sel =
                    (draft?.output_fps ?? 30) === fps;
                  return (
                    <button
                      key={fps}
                      onClick={() => queueSave({ output_fps: fps })}
                      className={cn(
                        "rounded px-2 py-0.5 text-[11px] transition",
                        sel
                          ? "bg-primary text-primary-foreground"
                          : "border border-border/50 text-muted-foreground hover:bg-muted",
                      )}
                    >
                      {fps} fps
                    </button>
                  );
                })}
              </div>
              <p className="text-[10px] text-muted-foreground">
                15 fps cuts render time roughly in half — good for ambient.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Palette className="size-3" /> Visualizer color
              </Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={currentColor}
                  onChange={(e) =>
                    queueSave({
                      visualizer_color_override: {
                        ...(draft?.visualizer_color_override ?? {}),
                        linearBarColor: e.target.value,
                        waveColor1: e.target.value,
                      },
                    })
                  }
                  className="h-7 w-12 cursor-pointer rounded border border-border/50 bg-transparent"
                />
                <Input
                  value={currentColor}
                  onChange={(e) =>
                    queueSave({
                      visualizer_color_override: {
                        ...(draft?.visualizer_color_override ?? {}),
                        linearBarColor: e.target.value,
                        waveColor1: e.target.value,
                      },
                    })
                  }
                  className="h-7 flex-1 font-mono text-xs"
                />
                {draft?.visualizer_color_override && (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      queueSave({ visualizer_color_override: null })
                    }
                  >
                    <XCircle className="size-3" /> Reset
                  </Button>
                )}
              </div>
            </div>

            </>
            )}

            {/* Recurring schedule. Computes a cron string client-side
                and sends it to the backend; the scheduler fires the
                preset whenever ``next_run_at`` is in the past, which
                works robustly even if the host PC was off — on boot
                any overdue window fires within 60 s. */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <Calendar className="size-3" /> Schedule
                </Label>
                {draft?.next_run_at && draft?.schedule_cron && (
                  <span className="text-[10px] text-muted-foreground">
                    Next run:{" "}
                    {formatDistanceToNow(new Date(draft.next_run_at), {
                      addSuffix: true,
                    })}
                  </span>
                )}
              </div>
              {(() => {
                const sched = parseCron(draft?.schedule_cron);
                const updateSched = (next: ScheduleState) => {
                  const cron = buildCron(next);
                  // Default to host TZ on first save so "9 AM" means
                  // local 9 AM, not UTC 9 AM. The user can fix it via
                  // the API later if they really want UTC.
                  const tz =
                    draft?.schedule_timezone ||
                    Intl.DateTimeFormat().resolvedOptions().timeZone ||
                    "UTC";
                  queueSave({
                    schedule_cron: cron,
                    schedule_timezone: tz,
                  });
                };
                return (
                  <div className="space-y-1.5">
                    <Select
                      value={sched.mode}
                      onValueChange={(v) =>
                        v && updateSched({ ...sched, mode: v as ScheduleMode })
                      }
                    >
                      <SelectTrigger className="h-7 text-[11px]">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="off">Off</SelectItem>
                        <SelectItem value="daily">Every day</SelectItem>
                        <SelectItem value="weekly">Specific days</SelectItem>
                        <SelectItem value="hourly">Every N hours</SelectItem>
                      </SelectContent>
                    </Select>

                    {(sched.mode === "daily" || sched.mode === "weekly") && (
                      <div>
                        <Label className="text-[10px]">Time</Label>
                        <Input
                          type="time"
                          value={sched.time}
                          onChange={(e) =>
                            updateSched({ ...sched, time: e.target.value })
                          }
                          className="h-7 text-[11px]"
                        />
                      </div>
                    )}

                    {sched.mode === "weekly" && (
                      <div>
                        <Label className="text-[10px]">Days</Label>
                        <div className="mt-1 flex gap-1">
                          {(
                            [
                              [1, "M"],
                              [2, "T"],
                              [3, "W"],
                              [4, "T"],
                              [5, "F"],
                              [6, "S"],
                              [0, "S"],
                            ] as [number, string][]
                          ).map(([d, lbl]) => {
                            const on = sched.days.includes(d);
                            return (
                              <button
                                key={d}
                                type="button"
                                onClick={() => {
                                  const days = on
                                    ? sched.days.filter((x) => x !== d)
                                    : [...sched.days, d];
                                  updateSched({ ...sched, days });
                                }}
                                className={cn(
                                  "h-6 w-6 rounded border text-[10px] transition",
                                  on
                                    ? "border-primary bg-primary/10 text-primary"
                                    : "border-border/50 hover:border-primary",
                                )}
                              >
                                {lbl}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}

                    {sched.mode === "hourly" && (
                      <div>
                        <Label className="text-[10px]">Every N hours</Label>
                        <Input
                          type="number"
                          min={1}
                          max={23}
                          value={sched.hours}
                          onChange={(e) =>
                            updateSched({
                              ...sched,
                              hours: Math.max(
                                1,
                                Math.min(23, Number(e.target.value)),
                              ),
                            })
                          }
                          className="h-7 text-[11px]"
                        />
                      </div>
                    )}

                    {sched.mode !== "off" && (
                      <p className="text-[10px] text-muted-foreground">
                        Auto-fires Generate now on this channel. Catches
                        up missed runs when the PC is back on.
                      </p>
                    )}
                  </div>
                );
              })()}
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <Calendar className="size-3" /> Auto-publish
                </Label>
                <Switch
                  checked={Boolean(draft?.auto_upload)}
                  onCheckedChange={(v) => queueSave({ auto_upload: v })}
                />
              </div>
              {draft?.auto_upload && (
                <>
                  <Label className="text-[11px] text-muted-foreground">
                    Schedule publish (optional — leave blank to publish
                    immediately)
                  </Label>
                  <Input
                    type="datetime-local"
                    value={scheduledLocal}
                    onChange={(e) => {
                      const v = e.target.value;
                      queueSave({
                        scheduled_publish_at: v
                          ? new Date(v).toISOString()
                          : null,
                      });
                    }}
                    className="h-7 text-xs"
                  />
                </>
              )}
            </div>

            {advancedOpen && (
            <>
            {/* Auto-translate: when chips are selected, Quick Generate
                runs Claude after metadata gen and ships the result as
                YouTube `localizations` so non-English viewers see the
                right language. Each chip is independently togglable;
                empty = English-only upload (default behaviour). */}
            <div className="space-y-1.5">
              <Label className="flex items-center gap-1 text-[11px]">
                <Languages className="size-3" /> Auto-translate
                <span className="text-muted-foreground">
                  (adds ~10s + 1 Claude call per run)
                </span>
              </Label>
              <div className="flex flex-wrap gap-1">
                {TRANSLATE_LANGS_COMPACT
                  // Filter out the channel's master_language — translating
                  // a Korean-master channel to Korean is a no-op. The
                  // operator can change the master via Brand Profile tab.
                  .filter((l) => l.code !== (channel.master_language || "en"))
                  .map(({ code, label, flag }) => {
                    const active = (draft?.auto_translate_languages ?? []).includes(code);
                    return (
                      <Button
                        key={code}
                        type="button"
                        size="xs"
                        variant={active ? "default" : "outline"}
                        onClick={() => {
                          const cur = draft?.auto_translate_languages ?? [];
                          const next = active
                            ? cur.filter((c) => c !== code)
                            : [...cur, code];
                          queueSave({
                            auto_translate_languages: next.length > 0 ? next : null,
                          });
                        }}
                        className="h-6 gap-1 px-2 text-[11px]"
                      >
                        <span aria-hidden>{flag}</span>
                        {label}
                      </Button>
                    );
                  })}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Master language: <code className="rounded bg-muted px-1">{channel.master_language || "en"}</code>{" "}
                — change in Brand Profile.
              </p>
            </div>
            </>
            )}
            </div>

            {/* Phase 1: Advanced settings disclosure. Hides 7 controls
                (viz preset, corner overlay, particles, terse, FPS,
                color, translate) behind a single toggle so the dialog
                opens at a glanceable height. State persisted per-channel
                in localStorage. */}
            <button
              type="button"
              onClick={toggleAdvanced}
              className="mt-2 flex w-full items-center justify-center gap-1 rounded-md border border-dashed border-border/60 px-3 py-1.5 text-[11px] text-muted-foreground hover:border-primary/50 hover:text-foreground transition"
            >
              <ChevronDown
                className={cn(
                  "size-3 transition-transform",
                  advancedOpen && "rotate-180",
                )}
              />
              {advancedOpen ? "Hide advanced settings" : "Show advanced settings (visualizer, FPS, color, translate…)"}
            </button>
          </DialogContent>
        </Dialog>

        {/* Pre-flight banner. Renders ONLY when the channel can't run
            yet (no music or no background). Disabling Generate alone
            wasn't enough — the user needs to know WHY the button is
            disabled, and where to fix it (Library page). */}
        {preflightBlocked && (
          <div className="rounded-md border border-yellow-500/40 bg-yellow-500/10 px-3 py-2 text-[11px] text-yellow-600 dark:text-yellow-400">
            <div className="flex items-center gap-1.5 font-medium">
              <AlertCircle className="size-3.5" />
              Can't generate yet — missing {preflightMissing.join(" and ")}
            </div>
            <div className="mt-0.5 text-yellow-600/80 dark:text-yellow-400/80">
              Upload some in the{" "}
              <button
                type="button"
                onClick={() => navigate(`/assets?channel_id=${channel.id}`)}
                className="underline hover:no-underline"
              >
                Library
              </button>{" "}
              first.
            </div>
          </div>
        )}

        {/* Generate Now button */}
        <Button
          onClick={handleGenerate}
          disabled={!canGenerate || triggering}
          className="w-full"
          variant={canGenerate ? "default" : "outline"}
        >
          {triggering ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Starting…
            </>
          ) : stillRunning ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              Generating…
            </>
          ) : (
            <>
              <Sparkles className="size-4" />
              Generate video now
            </>
          )}
        </Button>

        {/* Live progress while a task is in flight */}
        {stillRunning && task && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-[11px]">
              <span className="truncate text-muted-foreground">
                {task.status_message ?? "Running…"}
              </span>
              <span className="tabular-nums">
                {Math.round(task.progress ?? 0)}%
              </span>
            </div>
            <Progress value={task.progress ?? 0} />
          </div>
        )}

        {/* Last-run failure surface */}
        {lastFailed && task?.error && (
          <div className="rounded-md border border-destructive/40 bg-destructive/10 p-2 text-[11px]">
            <p className="flex items-center gap-1 font-medium text-destructive">
              <XCircle className="size-3" />
              Last run failed
            </p>
            <p className="mt-0.5 line-clamp-2 text-muted-foreground">
              {task.error}
            </p>
          </div>
        )}

        {/* Phase 1: "Last generation" diagnostic line. Shows the most
            recent automation_run on this channel — when it ran, what
            status, and the project / track / image picks. Click → open
            the channel page where Runs / Projects live. Hidden when a
            task is currently running (the live progress bar above
            already covers that state). */}
        {!stillRunning && lastRun && (
          <button
            type="button"
            onClick={() => navigate(`/channels/${channel.id}`)}
            className="flex w-full items-center gap-1.5 rounded-md border border-border/40 bg-muted/30 px-2 py-1.5 text-left text-[10px] text-muted-foreground hover:border-primary/40 hover:bg-muted/60 transition"
            title="Open channel page for run history"
          >
            {lastRun.status === "completed" ? (
              <CheckCircle2 className="size-3 text-green-500 shrink-0" />
            ) : lastRun.status === "failed" ? (
              <XCircle className="size-3 text-destructive shrink-0" />
            ) : lastRun.status === "cancelled" ? (
              <XCircle className="size-3 text-muted-foreground shrink-0" />
            ) : (
              <Loader2 className="size-3 animate-spin shrink-0" />
            )}
            <span className="truncate">
              Last run{" "}
              {lastRun.completed_at
                ? formatDistanceToNow(new Date(lastRun.completed_at), { addSuffix: true })
                : lastRun.created_at
                  ? formatDistanceToNow(new Date(lastRun.created_at), { addSuffix: true })
                  : "—"}
              {(() => {
                const r = (lastRun.result ?? {}) as Record<string, unknown>;
                const parts: string[] = [];
                if (typeof r.track_count === "number") parts.push(`${r.track_count} tracks`);
                if (typeof r.total_duration === "number" && r.total_duration > 0) {
                  const m = Math.round((r.total_duration as number) / 60);
                  parts.push(`${m}m`);
                }
                const yt = r.youtube as Record<string, unknown> | null | undefined;
                if (yt && typeof yt.video_id === "string") parts.push("uploaded");
                return parts.length ? ` · ${parts.join(" · ")}` : "";
              })()}
            </span>
          </button>
        )}

        {/* Setup links */}
        <div className="flex flex-wrap gap-1">
          {!channel.youtube_connected && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => navigate(`/channels/${channel.id}`)}
            >
              Connect YouTube
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="ml-auto"
            onClick={() => navigate(`/channels/${channel.id}`)}
          >
            Open
            <ArrowRight className="size-3" />
          </Button>
        </div>
      </CardContent>

      {/* Manual background picker. Lists the channel's image AND video
          assets — videos render as autoplay/muted/looping <video> tiles
          so the loop motion is visible before picking. Picking auto-
          locks the choice (next_image_pinned=true). */}
      <Dialog open={pickerOpen} onOpenChange={setPickerOpen}>
        <DialogContent className="max-w-3xl">
          <DialogHeader>
            <DialogTitle>Pick a background — {channel.name}</DialogTitle>
          </DialogHeader>
          {bgChoices.length === 0 ? (
            <div className="py-8 text-center text-sm text-muted-foreground">
              No images or videos in this channel's library yet.
              <br />
              Open the channel's Library tab to upload some.
            </div>
          ) : (
            <div className="grid max-h-[60vh] grid-cols-3 gap-2 overflow-y-auto pr-1 sm:grid-cols-4 md:grid-cols-5">
              {bgChoices.map((a) => {
                const isVideo = a.asset_type === "video";
                const isCurrent = preview?.image?.id === a.id;
                return (
                  <button
                    key={a.id}
                    type="button"
                    onClick={() => handlePickBackground(a.id)}
                    className={cn(
                      "group/tile relative aspect-video overflow-hidden rounded-md border bg-black transition",
                      isCurrent
                        ? "border-yellow-500 ring-2 ring-yellow-500/50"
                        : "border-border/50 hover:border-primary",
                    )}
                    title={a.title || a.filename}
                  >
                    {isVideo ? (
                      <video
                        src={a.file_url}
                        className="h-full w-full object-cover"
                        autoPlay
                        muted
                        loop
                        playsInline
                      />
                    ) : (
                      <img
                        src={a.file_url}
                        alt={a.title || a.filename}
                        className="h-full w-full object-cover"
                      />
                    )}
                    <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/80 to-transparent px-1.5 pb-1 pt-3">
                      <p className="truncate text-[10px] text-white">
                        {a.title || a.filename}
                      </p>
                    </div>
                    {isVideo && (
                      <span className="absolute left-1 top-1 rounded bg-black/70 px-1 text-[9px] font-medium uppercase text-white">
                        mp4
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Phase 1: preview-before-generate drawer. Open by clicking
          "Generate now"; approve to commit the previewed package to a
          real compose run. */}
      <QuickGeneratePreviewDrawer
        open={previewOpen}
        onOpenChange={(o) => {
          if (!o) {
            setPreviewOpen(false);
            setPreviewPkg(null);
            setPreviewError(null);
          }
        }}
        pkg={previewPkg}
        loading={previewMut.isPending}
        error={previewError}
        channelName={channel.name}
        onReroll={handlePreviewReroll}
        onApprove={handleApprovePreview}
        approving={triggering}
        thumbnailTemplate={
          (draft?.thumbnail_template ?? null) as unknown as
            | ThumbnailTemplate
            | null
        }
      />
    </Card>
  );
}
