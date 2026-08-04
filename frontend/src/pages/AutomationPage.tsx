import { useState, useEffect } from "react";
import {
  Zap,
  Plus,
  Play,
  Pause,
  Trash2,
  Clock,
  CheckCircle2,
  XCircle,
  Loader2,
  FolderOpen,
  Music,
  Image,
  Settings2,
  CalendarClock,
  Sparkles,
} from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import { Slider } from "@/components/ui/slider";
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
import api from "@/lib/api";

// ── Types ──────────────────────────────────────────────────────────────

interface AutomationPreset {
  id: number;
  channel_id: number;
  name: string;
  is_active: boolean;
  is_primary: boolean;
  music_folder_path: string;
  image_folder_path: string;
  image_source: string;
  image_generation_prompt: string | null;
  target_duration_seconds: number;
  video_style: string;
  composition_config: Record<string, unknown> | null;
  metadata_mode: string;
  title_template: string | null;
  description_template: string | null;
  tags_template: string | null;
  youtube_privacy: string;
  made_for_kids: boolean;
  auto_upload: boolean;
  schedule_cron: string | null;
  schedule_timezone: string;
  next_run_at: string | null;
  last_run_at: string | null;
  last_run_status: string | null;
  last_run_error: string | null;
  created_at: string;
}

// ── Helpers ────────────────────────────────────────────────────────────

function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}

function formatDate(iso: string | null): string {
  if (!iso) return "-";
  return new Date(iso).toLocaleString();
}

// ── Defaults for new preset ────────────────────────────────────────────

// Cron expressions for the "Schedule" preset buttons in Quick mode.
const CRON_PRESETS = [
  { label: "Manual only", value: "" },
  { label: "Daily at 9am", value: "0 9 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Twice daily", value: "0 9,21 * * *" },
  { label: "Weekdays 8am", value: "0 8 * * 1-5" },
] as const;

const DEFAULT_PRESET = {
  name: "",
  channel_id: 0,
  is_primary: false,
  music_folder_path: "",
  image_folder_path: "",
  image_source: "folder",
  image_generation_prompt: "",
  target_duration_seconds: 3600,
  audio_extensions: '["mp3","wav","flac","ogg","m4a"]',
  video_style: "spectrum",
  composition_config: {
    // Default visualizer config mirrors MV's DEFAULT_PROJECT_CONFIG.
    // See backend/app/api/compose.py for the canonical shape.
    presetId: "linear-dots",
    waveColor1: "#ffffff",
    waveColor2: "#a855f7",
    accentColor: "#ec4899",
    backgroundColor: "#0f0f1a",
    reactivity: 1.0,
    waveformScale: 1.0,
    particles: true,
    particleStyle: "floating",
    particleDensity: 50,
    logoEnabled: false,
    beatShake: false,
    beatZoom: false,
    output_width: 1920,
    output_height: 1080,
    output_fps: 30,
    crf: 23,
  },
  metadata_mode: "template",
  title_template: "{channel_name} - {niche} mix {short_date}",
  description_template:
    "{channel_name} - {track_count} tracks ({total_duration})\n\nTracklist:\n{tracklist}\n\nEnjoy!",
  tags_template: "",
  claude_prompt: "",
  youtube_privacy: "private",
  youtube_category_id: "10",
  made_for_kids: false,
  auto_upload: true,
  schedule_cron: "",
  schedule_timezone: "UTC",
};

// ── Main Component (reusable with optional channel filter) ─────────────

/**
 * AutomationContent can be used standalone (on the Automation route, which
 * now redirects to /channels) **or** embedded inside a ChannelDetailPage tab
 * by passing the `channelId` prop. When `channelId` is provided, the list is
 * filtered to that channel and new presets default to that channel.
 */
export function AutomationContent({ channelId }: { channelId?: number } = {}) {
  const { data: channels } = useChannels();
  const [presets, setPresets] = useState<AutomationPreset[]>([]);
  const [loading, setLoading] = useState(true);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState({ ...DEFAULT_PRESET });
  const [saving, setSaving] = useState(false);
  // Quick mode hides the 15+ advanced fields. Default to Quick on create,
  // Advanced on edit (presumably the user already configured details).
  const [quickMode, setQuickMode] = useState(true);
  const [triggering, setTriggering] = useState<number | null>(null);
  const [scanResult, setScanResult] = useState<{
    file_count: number;
    total_duration_seconds: number;
  } | null>(null);
  const [scanning, setScanning] = useState(false);

  const fetchPresets = async () => {
    try {
      const url = channelId
        ? `/automation/presets?channel_id=${channelId}`
        : "/automation/presets";
      const res = await api.get(url);
      setPresets(res.data);
    } catch {
      toast.error("Failed to load automation presets");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPresets();
  }, []);

  const openCreate = () => {
    setEditingId(null);
    setForm({
      ...DEFAULT_PRESET,
      channel_id: channelId ?? channels?.[0]?.id ?? 0,
    });
    setQuickMode(true);
    setScanResult(null);
    setDialogOpen(true);
  };

  const openEdit = (preset: AutomationPreset) => {
    setEditingId(preset.id);
    setQuickMode(false);
    setForm({
      ...DEFAULT_PRESET,
      ...preset,
      composition_config: preset.composition_config ?? DEFAULT_PRESET.composition_config,
      schedule_cron: preset.schedule_cron ?? "",
      title_template: preset.title_template ?? DEFAULT_PRESET.title_template,
      description_template: preset.description_template ?? DEFAULT_PRESET.description_template,
      tags_template: preset.tags_template ?? "",
      claude_prompt: "",
    } as typeof DEFAULT_PRESET);
    setScanResult(null);
    setDialogOpen(true);
  };

  const handleSave = async () => {
    const imageValid =
      form.image_source === "generate"
        ? !!form.image_generation_prompt
        : !!form.image_folder_path;
    if (!form.name || !form.channel_id || !form.music_folder_path || !imageValid) {
      toast.error("Please fill in all required fields");
      return;
    }
    setSaving(true);
    try {
      const body = {
        ...form,
        schedule_cron: form.schedule_cron || null,
      };
      if (editingId) {
        await api.put(`/automation/presets/${editingId}`, body);
        toast.success("Preset updated");
      } else {
        await api.post("/automation/presets", body);
        toast.success("Preset created");
      }
      setDialogOpen(false);
      fetchPresets();
    } catch (e: unknown) {
      const msg = (e as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Failed to save preset");
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this automation preset?")) return;
    try {
      await api.delete(`/automation/presets/${id}`);
      toast.success("Preset deleted");
      fetchPresets();
    } catch {
      toast.error("Failed to delete");
    }
  };

  const handleToggleActive = async (preset: AutomationPreset) => {
    try {
      await api.put(`/automation/presets/${preset.id}`, {
        is_active: !preset.is_active,
      });
      fetchPresets();
    } catch {
      toast.error("Failed to toggle");
    }
  };

  const handleTrigger = async (presetId: number) => {
    setTriggering(presetId);
    try {
      const res = await api.post(`/automation/presets/${presetId}/trigger`);
      toast.success(`Automation run started (task ${res.data.task_id})`);
    } catch {
      toast.error("Failed to trigger run");
    } finally {
      setTriggering(null);
    }
  };

  const handleScanFolder = async () => {
    if (!form.music_folder_path) return;
    setScanning(true);
    setScanResult(null);
    try {
      const res = await api.post("/automation/scan-folder", {
        folder_path: form.music_folder_path,
      });
      setScanResult(res.data);
    } catch {
      toast.error("Failed to scan folder. Check the path.");
    } finally {
      setScanning(false);
    }
  };

  if (loading) {
    return <Spinner.Page label="Loading…" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Automated video creation and publishing pipelines
        </p>
        <Button onClick={openCreate}>
          <Plus className="size-4" />
          New Automation
        </Button>
      </div>

      {presets.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12 text-center">
            <Zap className="mb-3 size-10 text-muted-foreground/50" />
            <p className="text-lg font-medium">No automations yet</p>
            <p className="mb-4 text-sm text-muted-foreground">
              Create your first automation to start producing videos on autopilot
            </p>
            <Button onClick={openCreate}>
              <Plus className="size-4" />
              Create Automation
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {presets.map((preset) => {
            const channelName =
              channels?.find((c) => c.id === preset.channel_id)?.name ?? "Unknown";
            return (
              <Card key={preset.id}>
                <CardContent className="p-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 space-y-1">
                      <div className="flex items-center gap-2">
                        <h3 className="text-lg font-semibold">{preset.name}</h3>
                        <Badge variant={preset.is_active ? "default" : "secondary"}>
                          {preset.is_active ? "Active" : "Paused"}
                        </Badge>
                        {preset.last_run_status === "success" && (
                          <Badge variant="outline" className="text-green-500">
                            <CheckCircle2 className="mr-1 size-3" />
                            Last run OK
                          </Badge>
                        )}
                        {preset.last_run_status === "failed" && (
                          <Badge variant="destructive">
                            <XCircle className="mr-1 size-3" />
                            Failed
                          </Badge>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                        <span>Channel: {channelName}</span>
                        <span>Target: {formatDuration(preset.target_duration_seconds)}</span>
                        <span>Style: {preset.video_style}</span>
                        {preset.schedule_cron && (
                          <span className="flex items-center gap-1">
                            <CalendarClock className="size-3" />
                            {preset.schedule_cron}
                          </span>
                        )}
                      </div>
                      <div className="flex gap-x-4 text-xs text-muted-foreground">
                        {preset.last_run_at && (
                          <span>Last run: {formatDate(preset.last_run_at)}</span>
                        )}
                        {preset.next_run_at && (
                          <span>Next run: {formatDate(preset.next_run_at)}</span>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch
                        checked={preset.is_active}
                        onCheckedChange={() => handleToggleActive(preset)}
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => handleTrigger(preset.id)}
                        disabled={triggering === preset.id}
                      >
                        {triggering === preset.id ? (
                          <Loader2 className="size-4 animate-spin" />
                        ) : (
                          <Play className="size-4" />
                        )}
                        Run Now
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => openEdit(preset)}
                      >
                        <Settings2 className="size-4" />
                      </Button>
                      <Button
                        size="sm"
                        variant="ghost"
                        className="text-destructive"
                        onClick={() => handleDelete(preset.id)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {/* ── Create / Edit Dialog ────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle className="flex items-center justify-between">
              <span>{editingId ? "Edit Automation" : "New Automation"}</span>
              <div className="flex gap-1 rounded-md border border-border/50 bg-muted/40 p-0.5">
                <button
                  type="button"
                  onClick={() => setQuickMode(true)}
                  className={cn(
                    "rounded px-2 py-1 text-xs transition",
                    quickMode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Quick
                </button>
                <button
                  type="button"
                  onClick={() => setQuickMode(false)}
                  className={cn(
                    "rounded px-2 py-1 text-xs transition",
                    !quickMode
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:text-foreground",
                  )}
                >
                  Advanced
                </button>
              </div>
            </DialogTitle>
          </DialogHeader>

          {/* Quick mode — 5 fields with smart defaults */}
          {quickMode && (
            <div className="space-y-5">
              <p className="text-xs text-muted-foreground">
                Five fields. Defaults inherit from the channel's brand profile —
                tweak in Advanced mode if needed.
              </p>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label>Name</Label>
                  <Input
                    placeholder="e.g. Daily Lofi Mix"
                    value={form.name}
                    onChange={(e) => setForm({ ...form, name: e.target.value })}
                  />
                </div>
                <div className="space-y-1">
                  <Label>Channel</Label>
                  <Select
                    value={String(form.channel_id || "")}
                    onValueChange={(v) =>
                      setForm({ ...form, channel_id: Number(v) })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue placeholder="Select channel">
                        {channels?.find((c) => c.id === form.channel_id)?.name ??
                          "Select channel"}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      {channels?.map((c) => (
                        <SelectItem key={c.id} value={String(c.id)}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              <div className="space-y-1">
                <Label>Music folder</Label>
                <Input
                  placeholder="D:/Music/Lofi"
                  value={form.music_folder_path}
                  onChange={(e) =>
                    setForm({ ...form, music_folder_path: e.target.value })
                  }
                />
                <p className="text-xs text-muted-foreground">
                  Local path scanned each run for random track picks.
                </p>
              </div>

              <div className="space-y-2">
                <Label>Image source</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={form.image_source === "folder" ? "default" : "outline"}
                    onClick={() => setForm({ ...form, image_source: "folder" })}
                    className="flex-1"
                  >
                    From folder
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={form.image_source === "generate" ? "default" : "outline"}
                    onClick={() => setForm({ ...form, image_source: "generate" })}
                    className="flex-1"
                  >
                    AI generate
                  </Button>
                </div>
                {form.image_source === "folder" ? (
                  <Input
                    placeholder="D:/Images/Backgrounds"
                    value={form.image_folder_path}
                    onChange={(e) =>
                      setForm({ ...form, image_folder_path: e.target.value })
                    }
                  />
                ) : (
                  <Textarea
                    placeholder="A cinematic landscape with warm sunset tones…"
                    value={form.image_generation_prompt ?? ""}
                    onChange={(e) =>
                      setForm({
                        ...form,
                        image_generation_prompt: e.target.value,
                      })
                    }
                    rows={2}
                    className="text-xs"
                  />
                )}
              </div>

              <div className="space-y-2">
                <Label>Schedule</Label>
                <div className="flex flex-wrap gap-1.5">
                  {CRON_PRESETS.map((cp) => (
                    <Button
                      key={cp.value || "manual"}
                      type="button"
                      size="sm"
                      variant={form.schedule_cron === cp.value ? "default" : "outline"}
                      onClick={() =>
                        setForm({ ...form, schedule_cron: cp.value })
                      }
                      className="h-7 text-xs"
                    >
                      {cp.label}
                    </Button>
                  ))}
                </div>
                {form.schedule_cron && (
                  <p className="font-mono text-[11px] text-muted-foreground">
                    cron: {form.schedule_cron}
                  </p>
                )}
              </div>

              {/* Primary toggle — surfaces the preset on the Dashboard */}
              <label className="flex items-center gap-2 rounded-md border border-border/50 bg-card/40 p-3 text-sm">
                <Switch
                  checked={form.is_primary}
                  onCheckedChange={(v) => setForm({ ...form, is_primary: v })}
                />
                <div>
                  <p className="font-medium">Set as channel's primary preset</p>
                  <p className="text-xs text-muted-foreground">
                    Powers the "Generate now" button on the Dashboard.
                  </p>
                </div>
              </label>

              <div className="flex justify-end gap-2 pt-2">
                <Button variant="outline" onClick={() => setDialogOpen(false)}>
                  Cancel
                </Button>
                <Button onClick={handleSave} disabled={saving}>
                  {saving && <Loader2 className="size-4 animate-spin" />}
                  {editingId ? "Update" : "Create"}
                </Button>
              </div>
            </div>
          )}

          {/* Advanced mode — original full form */}
          {!quickMode && (
          <div className="space-y-6">
            {/* Basic info */}
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label>Name</Label>
                <Input
                  placeholder="e.g., Daily Lofi Mix"
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                />
              </div>
              <div className="space-y-1">
                <Label>Channel</Label>
                <Select
                  value={String(form.channel_id || "")}
                  onValueChange={(v) =>
                    setForm({ ...form, channel_id: Number(v) })
                  }
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select channel">
                      {channels?.find((c) => c.id === form.channel_id)?.name ??
                        "Select channel"}
                    </SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {channels?.map((c) => (
                      <SelectItem key={c.id} value={String(c.id)}>
                        {c.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <Separator />

            {/* Source folders */}
            <div className="space-y-3">
              <h4 className="flex items-center gap-2 text-sm font-medium">
                <FolderOpen className="size-4" />
                Source Folders
              </h4>
              <div className="space-y-1">
                <Label className="text-xs">Music folder (local path)</Label>
                <div className="flex gap-2">
                  <Input
                    placeholder="D:/Music/Lofi"
                    value={form.music_folder_path}
                    onChange={(e) =>
                      setForm({ ...form, music_folder_path: e.target.value })
                    }
                    className="flex-1"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleScanFolder}
                    disabled={scanning || !form.music_folder_path}
                  >
                    {scanning ? (
                      <Loader2 className="size-4 animate-spin" />
                    ) : (
                      <Music className="size-4" />
                    )}
                    Scan
                  </Button>
                </div>
                {scanResult && (
                  <p className="text-xs text-muted-foreground">
                    Found {scanResult.file_count} audio files (
                    {formatDuration(scanResult.total_duration_seconds)} total)
                  </p>
                )}
              </div>
              <div className="space-y-2">
                <Label className="text-xs">Image source</Label>
                <div className="flex gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant={form.image_source === "folder" ? "default" : "outline"}
                    onClick={() => setForm({ ...form, image_source: "folder" })}
                    className="flex-1"
                  >
                    <FolderOpen className="size-3.5" />
                    From Folder
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={form.image_source === "generate" ? "default" : "outline"}
                    onClick={() => setForm({ ...form, image_source: "generate" })}
                    className="flex-1"
                  >
                    <Sparkles className="size-3.5" />
                    AI Generate
                  </Button>
                </div>
                {form.image_source === "folder" ? (
                  <Input
                    placeholder="D:/Images/Backgrounds"
                    value={form.image_folder_path}
                    onChange={(e) =>
                      setForm({ ...form, image_folder_path: e.target.value })
                    }
                  />
                ) : (
                  <Textarea
                    placeholder="e.g. A serene mountain landscape at sunset with warm tones, cinematic lighting..."
                    value={form.image_generation_prompt ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, image_generation_prompt: e.target.value })
                    }
                    rows={2}
                    className="text-xs"
                  />
                )}
              </div>
              <div className="space-y-1">
                <Label className="text-xs">
                  Target duration: {formatDuration(form.target_duration_seconds)}
                </Label>
                <Slider
                  min={1800}
                  max={7200}
                  step={300}
                  value={[form.target_duration_seconds]}
                  onValueChange={(v) =>
                    setForm({
                      ...form,
                      target_duration_seconds: Array.isArray(v) ? v[0] : v,
                    })
                  }
                />
              </div>
            </div>

            <Separator />

            {/* Visualizer config */}
            <div className="space-y-3">
              <h4 className="flex items-center gap-2 text-sm font-medium">
                <Image className="size-4" />
                Visualizer Settings
              </h4>
              <p className="text-xs text-muted-foreground">
                The visualizer preset and colors are stored in this
                automation's <code>composition_config</code>. Use the
                Compose step of a project to fine-tune the look — each
                run will use the saved config.
              </p>
              <div className="rounded-md border border-border/50 bg-muted/20 p-3 text-xs">
                <div className="font-medium">
                  Preset:{" "}
                  <span className="text-primary">
                    {String(
                      (form.composition_config as Record<string, unknown>)?.presetId ??
                        "trap-nation",
                    )}
                  </span>
                </div>
                <div className="mt-1 text-muted-foreground">
                  {Object.keys(form.composition_config ?? {}).length} config fields saved
                </div>
              </div>
            </div>

            <Separator />

            {/* Metadata */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium">Metadata Templates</h4>
              <p className="text-xs text-muted-foreground">
                Use placeholders: {"{channel_name}"}, {"{date}"}, {"{short_date}"},{" "}
                {"{track_count}"}, {"{total_duration}"}, {"{tracklist}"}, {"{niche}"}
              </p>
              <div className="space-y-1">
                <Label className="text-xs">Title template</Label>
                <Input
                  value={form.title_template ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, title_template: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Description template</Label>
                <Textarea
                  rows={4}
                  value={form.description_template ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, description_template: e.target.value })
                  }
                />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Tags (comma-separated)</Label>
                <Input
                  placeholder="lofi, chill, study, beats"
                  value={form.tags_template ?? ""}
                  onChange={(e) =>
                    setForm({ ...form, tags_template: e.target.value })
                  }
                />
              </div>
            </div>

            <Separator />

            {/* YouTube + Schedule */}
            <div className="space-y-3">
              <h4 className="text-sm font-medium">YouTube & Schedule</h4>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label className="text-xs">Privacy</Label>
                  <Select
                    value={form.youtube_privacy}
                    onValueChange={(v) =>
                      setForm({ ...form, youtube_privacy: v })
                    }
                  >
                    <SelectTrigger>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="private">Private</SelectItem>
                      <SelectItem value="unlisted">Unlisted</SelectItem>
                      <SelectItem value="public">Public</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">
                    Schedule (cron)
                  </Label>
                  <Input
                    placeholder="0 8 * * 1,3,5"
                    value={form.schedule_cron ?? ""}
                    onChange={(e) =>
                      setForm({ ...form, schedule_cron: e.target.value })
                    }
                  />
                  <p className="text-xs text-muted-foreground">
                    e.g. "0 8 * * 1,3,5" = Mon/Wed/Fri at 8am
                  </p>
                </div>
              </div>
              <div className="flex items-center gap-6">
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={form.auto_upload}
                    onCheckedChange={(v) =>
                      setForm({ ...form, auto_upload: v })
                    }
                  />
                  Auto-upload to YouTube
                </label>
                <label className="flex items-center gap-2 text-sm">
                  <Switch
                    checked={!form.made_for_kids}
                    onCheckedChange={(v) =>
                      setForm({ ...form, made_for_kids: !v })
                    }
                  />
                  Not made for kids
                </label>
              </div>
            </div>

            <Separator />

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={() => setDialogOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleSave} disabled={saving}>
                {saving && <Loader2 className="size-4 animate-spin" />}
                {editingId ? "Update" : "Create"}
              </Button>
            </div>
          </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Default export for backwards compat (route now redirects to /channels)
export default AutomationContent;
