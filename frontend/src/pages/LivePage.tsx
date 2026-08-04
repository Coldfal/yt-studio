import { useState, useEffect } from "react";
import {
  Radio,
  Play,
  Square,
  Loader2,
  Clock,
  Music,
  Image,
  CheckCircle2,
  XCircle,
  AlertCircle,
  Sparkles,
  Film,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { useChannels } from "@/hooks/use-channels";
import { useAssets } from "@/hooks/use-assets";
import { useVisualizerPresets } from "@/hooks/use-visualizer-presets";
import { VisualizerEditor } from "@/components/visualizer/VisualizerEditor";
import { DEFAULT_PROJECT_CONFIG } from "@/types/visualizer";
import { cn } from "@/lib/utils";
import api from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────

interface LiveStream {
  id: number;
  channel_id: number;
  status: string;
  broadcast_id: string | null;
  title: string;
  description: string | null;
  music_folder_path: string | null;
  use_channel_music_assets: boolean;
  image_path: string | null;
  image_asset_id: number | null;
  target_duration_hours: number;
  use_visualizer: boolean;
  visualizer_preset_id: string | null;
  tracks_used: string[] | null;
  total_audio_duration: number | null;
  started_at: string | null;
  stopped_at: string | null;
  error: string | null;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatElapsed(startIso: string): string {
  const start = new Date(startIso).getTime();
  const now = Date.now();
  const sec = Math.floor((now - start) / 1000);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const STATUS_CONFIG: Record<
  string,
  { color: string; icon: typeof Radio; label: string }
> = {
  preparing: {
    color: "text-yellow-500",
    icon: Loader2,
    label: "Preparing...",
  },
  starting: {
    color: "text-yellow-500",
    icon: Loader2,
    label: "Starting...",
  },
  live: { color: "text-red-500", icon: Radio, label: "LIVE" },
  stopping: {
    color: "text-orange-500",
    icon: Loader2,
    label: "Stopping...",
  },
  stopped: {
    color: "text-muted-foreground",
    icon: CheckCircle2,
    label: "Stopped",
  },
  failed: {
    color: "text-destructive",
    icon: XCircle,
    label: "Failed",
  },
};

// ── Main Page ──────────────────────────────────────────────────────────

type LiveSourceMode = "composed" | "visualizer" | "static";

type LiveForm = {
  channel_id: number;
  title: string;
  description: string;
  // Top-level mode — defines what gets streamed.
  //   "composed"   — stream a pre-rendered MP4 from the library (most efficient, recommended)
  //   "visualizer" — live-render audio-reactive visualizer (CPU intensive)
  //   "static"     — static image over channel/folder audio (lightweight)
  source_mode: LiveSourceMode;
  // For "composed" mode
  composed_asset_id: number | null;
  // For "visualizer" and "static" modes — audio source
  music_source: "channel" | "folder";
  music_folder_path: string;
  use_channel_music_assets: boolean;
  // For "visualizer" and "static" modes — image source
  image_source: "asset" | "path";
  image_asset_id: number | null;
  image_path: string;
  target_duration_hours: number;
  /** Output resolution for the live encoder — 720p strongly recommended for
   *  smoother streaming when the visualizer is on. */
  resolution: "720p" | "1080p";
  // Visualizer-mode specific
  visualizer_preset_id: string;
  visualizer_config: Record<string, unknown> | null;
};

// ── localStorage persistence ──────────────────────────────────────────
//
// Remember each channel's Go Live setup between sessions. Keyed per channel
// so switching channels inside the dialog swaps in the right saved config.

const LIVE_FORM_STORAGE_KEY = (channelId: number) =>
  `yt-studio:live-form:${channelId}`;

function defaultLiveForm(channelId: number): LiveForm {
  return {
    channel_id: channelId,
    title: `Live Stream - ${new Date().toLocaleDateString()}`,
    description: "",
    // Default to composed-video streaming — user gets smooth 1080p with zero
    // live-render CPU cost. Visualizer mode is available but CPU-heavy.
    source_mode: "composed",
    composed_asset_id: null,
    music_source: "channel",
    music_folder_path: "",
    use_channel_music_assets: true,
    image_source: "asset",
    image_asset_id: null,
    image_path: "",
    target_duration_hours: 4,
    resolution: "1080p",
    visualizer_preset_id: "trap-nation",
    visualizer_config: null,
  };
}

function loadLiveFormForChannel(channelId: number): LiveForm {
  const base = defaultLiveForm(channelId);
  if (!channelId) return base;
  try {
    const raw = localStorage.getItem(LIVE_FORM_STORAGE_KEY(channelId));
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<LiveForm>;
    return { ...base, ...parsed, channel_id: channelId };
  } catch {
    return base;
  }
}

function saveLiveFormForChannel(channelId: number, form: LiveForm): void {
  if (!channelId) return;
  try {
    localStorage.setItem(LIVE_FORM_STORAGE_KEY(channelId), JSON.stringify(form));
  } catch {
    // Storage full / disabled — silently ignore; it's a convenience feature.
  }
}

/** Picker for pre-composed MP4s in the channel's library. Selecting one
 *  sends it to the backend, which streams it to RTMP via
 *  ``ffmpeg -re -stream_loop -1 -i <mp4>`` — zero live-render CPU. */
function ComposedVideoPicker({
  channelId,
  selectedId,
  onSelect,
}: {
  channelId: number;
  selectedId: number | null;
  onSelect: (id: number | null) => void;
}) {
  const channelIdStr = channelId > 0 ? String(channelId) : undefined;
  const { data: composed } = useAssets({
    channel_id: channelIdStr,
    asset_type: "composed",
  });

  const fmtDur = (s: number | null | undefined) => {
    if (!s) return "";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    return `${m}:${String(r).padStart(2, "0")}`;
  };

  return (
    <div className="space-y-2">
      <Label className="flex items-center gap-1">
        <Film className="size-3 text-primary" />
        Composed video
      </Label>
      {!composed || composed.length === 0 ? (
        <div className="rounded-md border border-dashed border-border/50 p-3 text-xs text-muted-foreground">
          No composed videos for this channel yet. Compose one via the Projects
          wizard, then come back here to stream it 24/7.
        </div>
      ) : (
        <div className="grid max-h-64 grid-cols-1 gap-2 overflow-y-auto rounded-md border border-border/40 p-2 sm:grid-cols-2">
          {composed.map((a) => {
            const selected = selectedId === a.id;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onSelect(selected ? null : a.id)}
                className={cn(
                  "flex items-center gap-3 rounded-md border p-2 text-left text-sm transition",
                  selected
                    ? "border-primary bg-primary/10"
                    : "border-border/50 hover:bg-muted/40",
                )}
              >
                <div className="flex size-10 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
                  <Film className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {a.title || a.filename}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {a.duration_seconds
                      ? `${fmtDur(a.duration_seconds)} · `
                      : ""}
                    {a.file_size
                      ? `${(a.file_size / 1024 / 1024).toFixed(1)} MB`
                      : ""}
                  </p>
                </div>
                {selected && (
                  <Badge variant="secondary" className="text-[10px]">
                    Selected
                  </Badge>
                )}
              </button>
            );
          })}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        The video will loop to fill the target duration. Re-mux only — zero
        CPU cost for the visualizer.
      </p>
    </div>
  );
}

/** Music + image + visualizer pickers for the Go Live dialog. Scopes all
 *  DB queries to the currently-selected channel so changing channels refreshes
 *  the asset options. */
function GoLiveAssetSection({
  channelId,
  form,
  onChange,
}: {
  channelId: number;
  form: LiveForm;
  onChange: (f: LiveForm) => void;
}) {
  const channelIdStr = channelId > 0 ? String(channelId) : undefined;
  const { data: musicAssets } = useAssets({
    channel_id: channelIdStr,
    asset_type: "music",
  });
  const { data: imageAssets } = useAssets({
    channel_id: channelIdStr,
    asset_type: "image",
  });
  const { data: visualizerPresets } = useVisualizerPresets(
    channelId > 0 ? channelId : null,
  );

  const musicCount = musicAssets?.length ?? 0;

  return (
    <>
      {/* ── Music source ─────────────────────────────────────── */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1">
          <Music className="size-3" />
          Music source
        </Label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={form.music_source === "channel" ? "default" : "outline"}
            onClick={() => onChange({ ...form, music_source: "channel" })}
            className="flex-1"
          >
            Channel library ({musicCount})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={form.music_source === "folder" ? "default" : "outline"}
            onClick={() => onChange({ ...form, music_source: "folder" })}
            className="flex-1"
          >
            Disk folder
          </Button>
        </div>
        {form.music_source === "channel" ? (
          <p className="text-xs text-muted-foreground">
            {musicCount === 0
              ? "No imported music for this channel yet — switch to Disk folder or import tracks first."
              : `The stream will shuffle-pick tracks up to the target duration from the ${musicCount} imported tracks on this channel.`}
          </p>
        ) : (
          <Input
            value={form.music_folder_path}
            onChange={(e) =>
              onChange({ ...form, music_folder_path: e.target.value })
            }
            placeholder="D:/Music/Lofi"
          />
        )}
      </div>

      {/* ── Background image source ─────────────────────────── */}
      <div className="space-y-2">
        <Label className="flex items-center gap-1">
          <Image className="size-3" />
          Background image
        </Label>
        <div className="flex gap-2">
          <Button
            type="button"
            size="sm"
            variant={form.image_source === "asset" ? "default" : "outline"}
            onClick={() => onChange({ ...form, image_source: "asset" })}
            className="flex-1"
          >
            From library ({imageAssets?.length ?? 0})
          </Button>
          <Button
            type="button"
            size="sm"
            variant={form.image_source === "path" ? "default" : "outline"}
            onClick={() => onChange({ ...form, image_source: "path" })}
            className="flex-1"
          >
            Disk path
          </Button>
        </div>
        {form.image_source === "asset" ? (
          <>
            {!imageAssets || imageAssets.length === 0 ? (
              <p className="rounded-md border border-dashed border-border/50 p-3 text-center text-xs text-muted-foreground">
                No imported images for this channel. Import some in the
                Assets page or switch to "Disk path".
              </p>
            ) : (
              <div className="grid max-h-48 grid-cols-3 gap-2 overflow-y-auto rounded-md border border-border/40 p-2 sm:grid-cols-4 md:grid-cols-5">
                {imageAssets.map((a) => {
                  const selected = form.image_asset_id === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() =>
                        onChange({
                          ...form,
                          image_asset_id: selected ? null : a.id,
                        })
                      }
                      className={cn(
                        "relative aspect-video overflow-hidden rounded border bg-muted transition",
                        selected
                          ? "ring-2 ring-primary"
                          : "border-border/50 hover:border-border",
                      )}
                      title={a.title || a.filename}
                    >
                      <img
                        src={a.file_url}
                        alt={a.title || a.filename}
                        className="h-full w-full object-cover"
                      />
                      {selected && (
                        <div className="absolute inset-0 bg-primary/15" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {form.image_asset_id
                ? "Click the selected image again to clear."
                : "Optional — black background if nothing is picked."}
            </p>
          </>
        ) : (
          <Input
            value={form.image_path}
            onChange={(e) => onChange({ ...form, image_path: e.target.value })}
            placeholder="D:/Images/stream_bg.jpg"
          />
        )}
      </div>

      {/* ── Visualizer editor (only for visualizer mode) ───── */}
      {form.source_mode === "visualizer" && (
        <div className="space-y-3 rounded-lg border border-border/60 bg-card/40 p-3">
          <div>
            <Label className="flex items-center gap-1">
              <Sparkles className="size-3 text-primary" />
              Visualizer editor
            </Label>
            <p className="text-xs text-muted-foreground">
              Same editor as composing a video. Live preview uses the first
              track in the channel library.
            </p>
          </div>
          <LiveVisualizerEditor
            channelId={channelId}
            musicAssets={musicAssets}
            imageAssets={imageAssets}
            visualizerPresets={visualizerPresets}
            form={form}
            onChange={onChange}
          />
        </div>
      )}
    </>
  );
}

/** The full visualizer editor embedded in the Go Live dialog. Uses the first
 *  music + image asset from the channel as the preview source so the RAF loop
 *  can drive an audio-reactive preview even though the real stream will
 *  shuffle through the whole library. */
function LiveVisualizerEditor({
  channelId,
  musicAssets,
  imageAssets,
  visualizerPresets,
  form,
  onChange,
}: {
  channelId: number;
  musicAssets: { id: number; file_url: string; filename: string; title?: string | null; duration_seconds: number | null }[] | undefined;
  imageAssets: { id: number; file_url: string; filename: string; title?: string | null }[] | undefined;
  visualizerPresets: {
    id: number;
    name: string;
    preset_id: string;
    config: Record<string, unknown>;
    is_default: boolean;
  }[] | undefined;
  form: LiveForm;
  onChange: (f: LiveForm) => void;
}) {
  // Seed the editor config on first use
  const config = form.visualizer_config ?? {
    ...DEFAULT_PROJECT_CONFIG,
    presetId: form.visualizer_preset_id,
    output_width: 1920,
    output_height: 1080,
    output_fps: 30,
    crf: 23,
  };

  // Pick the first track/image as the preview seeds
  const previewTrack = musicAssets?.[0];
  const previewBg =
    (form.image_asset_id != null
      ? imageAssets?.find((i) => i.id === form.image_asset_id)
      : undefined) ?? imageAssets?.[0];

  return (
    <div className="space-y-3">
      {visualizerPresets && visualizerPresets.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Label className="text-xs">Load saved look:</Label>
          <Select
            onValueChange={(v) => {
              const p = visualizerPresets.find((x) => String(x.id) === v);
              if (!p) return;
              onChange({
                ...form,
                visualizer_preset_id: p.preset_id,
                visualizer_config: p.config as Record<string, unknown>,
              });
            }}
          >
            <SelectTrigger className="h-8 w-64">
              <SelectValue placeholder="Use a saved preset…" />
            </SelectTrigger>
            <SelectContent>
              {visualizerPresets.map((p) => (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.is_default ? "★ " : ""}
                  {p.name}{" "}
                  <span className="text-xs text-muted-foreground">
                    ({p.preset_id})
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {previewTrack ? (
        <VisualizerEditor
          value={config as any}
          onChange={(next) =>
            onChange({
              ...form,
              visualizer_config: next as unknown as Record<string, unknown>,
            })
          }
          presetId={form.visualizer_preset_id}
          onPresetIdChange={(id) =>
            onChange({ ...form, visualizer_preset_id: id })
          }
          audioUrl={previewTrack.file_url}
          audioName={previewTrack.title || previewTrack.filename}
          audioDuration={previewTrack.duration_seconds ?? 0}
          backgroundUrl={previewBg?.file_url ?? null}
        />
      ) : (
        <p className="rounded-md border border-dashed border-border/50 p-3 text-center text-xs text-muted-foreground">
          Add music assets to channel #{channelId} to see a live preview.
          You can still pick a preset and stream — the preview just needs at
          least one track to animate against.
        </p>
      )}
    </div>
  );
}

export default function LivePage() {
  const { data: channels } = useChannels();
  const [activeStreams, setActiveStreams] = useState<LiveStream[]>([]);
  const [history, setHistory] = useState<LiveStream[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [starting, setStarting] = useState(false);
  const [stoppingId, setStoppingId] = useState<number | null>(null);

  // Form state — starts blank, populated via openGoLive() from localStorage.
  const [form, setForm] = useState<LiveForm>(() => defaultLiveForm(0));

  // Elapsed time tickers
  const [, setTick] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(interval);
  }, []);

  const fetchStreams = async () => {
    try {
      const [activeRes, historyRes] = await Promise.all([
        api.get("/streaming/active"),
        api.get("/streaming/history?limit=10"),
      ]);
      setActiveStreams(activeRes.data);
      setHistory(historyRes.data);
    } catch {
      // silent — will show empty
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchStreams();
    const interval = setInterval(fetchStreams, 5000); // Poll every 5s
    return () => clearInterval(interval);
  }, []);

  const openGoLive = () => {
    const channelId = channels?.[0]?.id ?? 0;
    setForm(loadLiveFormForChannel(channelId));
    setDialogOpen(true);
  };

  // When the user switches channel inside the open dialog, swap the form to
  // whatever we remembered for that channel.
  useEffect(() => {
    if (!dialogOpen) return;
    if (!form.channel_id) return;
    const saved = loadLiveFormForChannel(form.channel_id);
    // Only replace if the remembered channel differs from current, to avoid
    // overwriting mid-edit values on the same channel.
    if (saved.channel_id === form.channel_id && saved !== form) {
      // noop — handled via setForm below on explicit channel change
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dialogOpen]);

  // Persist on every form change (debounced slightly via rAF).
  useEffect(() => {
    if (!dialogOpen || !form.channel_id) return;
    const h = requestAnimationFrame(() => saveLiveFormForChannel(form.channel_id, form));
    return () => cancelAnimationFrame(h);
  }, [form, dialogOpen]);

  const handleStartStream = async () => {
    if (!form.channel_id || !form.title) {
      toast.error("Please fill in channel and title");
      return;
    }
    if (form.source_mode === "composed" && !form.composed_asset_id) {
      toast.error("Pick a composed video to stream");
      return;
    }
    if (
      form.source_mode !== "composed" &&
      form.music_source === "folder" &&
      !form.music_folder_path
    ) {
      toast.error("Enter a music folder path or switch to channel library");
      return;
    }
    setStarting(true);
    try {
      const [w, h] = form.resolution === "1080p" ? [1920, 1080] : [1280, 720];
      const visCfg =
        form.source_mode === "visualizer"
          ? {
              ...(form.visualizer_config ?? {}),
              output_width: w,
              output_height: h,
              output_fps: 30,
            }
          : null;

      const body = {
        channel_id: form.channel_id,
        title: form.title,
        description: form.description,
        target_duration_hours: form.target_duration_hours,
        // Mode-specific fields — send nulls for branches we're not using so
        // the backend picks the right path.
        composed_asset_id:
          form.source_mode === "composed" ? form.composed_asset_id : null,
        music_folder_path:
          form.source_mode !== "composed" && form.music_source === "folder"
            ? form.music_folder_path
            : null,
        use_channel_music_assets:
          form.source_mode !== "composed" && form.music_source === "channel",
        image_asset_id:
          form.source_mode !== "composed" && form.image_source === "asset"
            ? form.image_asset_id
            : null,
        image_path:
          form.source_mode !== "composed" && form.image_source === "path"
            ? form.image_path
            : null,
        use_visualizer: form.source_mode === "visualizer",
        visualizer_preset_id:
          form.source_mode === "visualizer" ? form.visualizer_preset_id : null,
        visualizer_config: visCfg,
      };
      await api.post("/streaming/start", body);
      toast.success("Stream starting...");
      setDialogOpen(false);
      fetchStreams();
    } catch (e: unknown) {
      // Pydantic validation errors come back as `detail: [{type, loc, msg, input}, ...]`
      // — flatten to a single readable string so React never tries to render
      // the object directly.
      const rawDetail = (e as { response?: { data?: { detail?: unknown } } })
        ?.response?.data?.detail;
      let msg = "Failed to start stream";
      if (typeof rawDetail === "string") {
        msg = rawDetail;
      } else if (Array.isArray(rawDetail)) {
        msg = rawDetail
          .map((d: { loc?: unknown[]; msg?: string }) => {
            const loc = Array.isArray(d.loc) ? d.loc.join(".") : "";
            return loc ? `${loc}: ${d.msg ?? "invalid"}` : (d.msg ?? "invalid");
          })
          .join("; ");
      }
      // Also log to console so we can see the actual payload mismatch
      // eslint-disable-next-line no-console
      console.error("start stream failed:", e, "detail:", rawDetail);
      toast.error(msg);
    } finally {
      setStarting(false);
    }
  };

  const handleStopStream = async (streamId: number) => {
    setStoppingId(streamId);
    try {
      await api.post(`/streaming/${streamId}/stop`);
      toast.success("Stream stopping...");
      fetchStreams();
    } catch {
      toast.error("Failed to stop stream");
    } finally {
      setStoppingId(null);
    }
  };

  // Channels that have YouTube connected
  const connectedChannels = channels?.filter(
    (c) => c.youtube_channel_id
  );

  // Channels currently streaming
  const streamingChannelIds = new Set(
    activeStreams.map((s) => s.channel_id)
  );

  if (loading) {
    return <Spinner.Page label="Loading…" />;
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Radio className="size-6 text-red-500" />
            Live Streaming
          </h1>
          <p className="text-sm text-muted-foreground">
            Stream music to YouTube Live with a click
          </p>
        </div>
        <Button
          onClick={openGoLive}
          className="bg-red-600 hover:bg-red-700"
        >
          <Radio className="size-4" />
          Go Live
        </Button>
      </div>

      {/* Active Streams */}
      {activeStreams.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Active Streams
          </h2>
          {activeStreams.map((stream) => {
            const channel = channels?.find(
              (c) => c.id === stream.channel_id
            );
            const cfg = STATUS_CONFIG[stream.status] ?? STATUS_CONFIG.failed;
            const Icon = cfg.icon;
            const isSpinning =
              stream.status === "preparing" ||
              stream.status === "starting" ||
              stream.status === "stopping";

            return (
              <Card key={stream.id} className="border-red-500/30">
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <Icon
                          className={`size-4 ${cfg.color} ${isSpinning ? "animate-spin" : ""}`}
                        />
                        <h3 className="text-lg font-semibold">
                          {stream.title}
                        </h3>
                        <Badge
                          variant={
                            stream.status === "live"
                              ? "destructive"
                              : "secondary"
                          }
                        >
                          {cfg.label}
                        </Badge>
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>Channel: {channel?.name ?? "Unknown"}</span>
                        {stream.started_at && (
                          <span className="flex items-center gap-1">
                            <Clock className="size-3" />
                            {formatElapsed(stream.started_at)}
                          </span>
                        )}
                        {stream.tracks_used && (
                          <span className="flex items-center gap-1">
                            <Music className="size-3" />
                            {stream.tracks_used.length} tracks
                          </span>
                        )}
                        {stream.total_audio_duration && (
                          <span>
                            Audio:{" "}
                            {formatDuration(stream.total_audio_duration)}
                          </span>
                        )}
                      </div>
                      {stream.tracks_used &&
                        stream.tracks_used.length > 0 && (
                          <details className="text-xs text-muted-foreground">
                            <summary className="cursor-pointer">
                              Track list
                            </summary>
                            <ol className="mt-1 ml-4 list-decimal space-y-0.5">
                              {stream.tracks_used.map((t, i) => (
                                <li key={i}>{t}</li>
                              ))}
                            </ol>
                          </details>
                        )}
                    </div>
                    <Button
                      variant="destructive"
                      size="sm"
                      onClick={() => handleStopStream(stream.id)}
                      disabled={
                        stoppingId === stream.id ||
                        stream.status === "stopping"
                      }
                    >
                      {stoppingId === stream.id ? (
                        <Loader2 className="size-4 animate-spin" />
                      ) : (
                        <Square className="size-4" />
                      )}
                      Stop
                    </Button>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* Empty state */}
      {activeStreams.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Radio className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-lg font-medium">No active streams</p>
            <p className="mb-4 text-sm text-muted-foreground">
              Go live on YouTube with your music collection
            </p>
            <Button
              onClick={openGoLive}
              className="bg-red-600 hover:bg-red-700"
            >
              <Radio className="size-4" />
              Go Live
            </Button>
          </CardContent>
        </Card>
      )}

      {/* Stream History */}
      {history.length > 0 && (
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-muted-foreground">
            Recent Streams
          </h2>
          {history
            .filter((s) => s.status === "stopped" || s.status === "failed")
            .slice(0, 5)
            .map((stream) => {
              const channel = channels?.find(
                (c) => c.id === stream.channel_id
              );
              const cfg =
                STATUS_CONFIG[stream.status] ?? STATUS_CONFIG.failed;

              return (
                <Card key={stream.id} className="opacity-70">
                  <CardContent className="flex items-center justify-between p-3">
                    <div className="flex items-center gap-3">
                      <Badge
                        variant={
                          stream.status === "stopped"
                            ? "outline"
                            : "destructive"
                        }
                        className="text-xs"
                      >
                        {cfg.label}
                      </Badge>
                      <span className="text-sm font-medium">
                        {stream.title}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {channel?.name}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      {stream.error && (
                        <span
                          className="flex items-center gap-1 text-destructive"
                          title={stream.error}
                        >
                          <AlertCircle className="size-3" />
                          Error
                        </span>
                      )}
                      <span>
                        {new Date(stream.created_at).toLocaleDateString()}
                      </span>
                    </div>
                  </CardContent>
                </Card>
              );
            })}
        </div>
      )}

      {/* ── Go Live Dialog ──────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[95vh] overflow-y-auto sm:max-w-[min(95vw,1400px)]">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Radio className="size-5 text-red-500" />
              Go Live
            </DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-1">
              <Label>Channel</Label>
              <Select
                value={String(form.channel_id || "")}
                onValueChange={(v) => {
                  // Swap to the newly-picked channel's saved settings.
                  setForm(loadLiveFormForChannel(Number(v)));
                }}
              >
                <SelectTrigger>
                  <SelectValue placeholder="Select channel">
                    {channels?.find((c) => c.id === form.channel_id)
                      ?.name ?? "Select channel"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  {connectedChannels?.map((c) => (
                    <SelectItem
                      key={c.id}
                      value={String(c.id)}
                      disabled={streamingChannelIds.has(c.id)}
                    >
                      {c.name}
                      {streamingChannelIds.has(c.id) && " (already live)"}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-1">
              <Label>Stream Title</Label>
              <Input
                value={form.title}
                onChange={(e) =>
                  setForm({ ...form, title: e.target.value })
                }
                placeholder="My Live Stream"
              />
            </div>

            <div className="space-y-1">
              <Label>Description</Label>
              <Textarea
                value={form.description}
                onChange={(e) =>
                  setForm({ ...form, description: e.target.value })
                }
                placeholder="What's this stream about? Shown on the YouTube video page."
                rows={3}
              />
            </div>

            <Separator />

            <div className="space-y-2">
              <Label>What's streaming?</Label>
              <div className="grid grid-cols-3 gap-2">
                <Button
                  type="button"
                  size="sm"
                  variant={form.source_mode === "composed" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, source_mode: "composed" })}
                  className="flex-col h-auto py-2"
                >
                  <span className="font-medium">Composed video</span>
                  <span className="text-[10px] font-normal opacity-80">
                    Loop a pre-rendered MP4 — smooth, low CPU
                  </span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.source_mode === "visualizer" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, source_mode: "visualizer" })}
                  className="flex-col h-auto py-2"
                >
                  <span className="font-medium">Live visualizer</span>
                  <span className="text-[10px] font-normal opacity-80">
                    Real-time render from audio — CPU heavy
                  </span>
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant={form.source_mode === "static" ? "default" : "outline"}
                  onClick={() => setForm({ ...form, source_mode: "static" })}
                  className="flex-col h-auto py-2"
                >
                  <span className="font-medium">Static image</span>
                  <span className="text-[10px] font-normal opacity-80">
                    Audio over a fixed image — lightest
                  </span>
                </Button>
              </div>
            </div>

            {form.source_mode === "composed" ? (
              <ComposedVideoPicker
                channelId={form.channel_id}
                selectedId={form.composed_asset_id}
                onSelect={(id) =>
                  setForm({ ...form, composed_asset_id: id })
                }
              />
            ) : (
              <GoLiveAssetSection
                channelId={form.channel_id}
                form={form}
                onChange={setForm}
              />
            )}

            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Duration: {form.target_duration_hours}h</Label>
                <Slider
                  min={1}
                  max={12}
                  step={1}
                  value={[form.target_duration_hours]}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      target_duration_hours: Array.isArray(v) ? v[0] : v,
                    })
                  }
                />
              </div>
              {form.source_mode === "visualizer" && (
                <div className="space-y-1">
                  <Label>Resolution</Label>
                  <Select
                    value={form.resolution}
                    onValueChange={(v) =>
                      setForm({
                        ...form,
                        resolution: v as "720p" | "1080p",
                      })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="720p">720p (smoother)</SelectItem>
                      <SelectItem value="1080p">1080p (may stutter)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              )}
            </div>

            <Separator />

            <div className="flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setDialogOpen(false)}
              >
                Cancel
              </Button>
              <Button
                onClick={handleStartStream}
                disabled={starting}
                className="bg-red-600 hover:bg-red-700"
              >
                {starting && (
                  <Loader2 className="size-4 animate-spin" />
                )}
                <Radio className="size-4" />
                Go Live
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
