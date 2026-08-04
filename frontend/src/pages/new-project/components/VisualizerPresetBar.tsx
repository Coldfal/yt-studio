import { useState } from "react";
import { RefreshCw, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useCreateVisualizerPreset,
  useDeleteVisualizerPreset,
  useUpdateVisualizerPreset,
  useUploadPresetThumbnail,
  useVisualizerPresets,
} from "@/hooks/use-visualizer-presets";
import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";

/**
 * Toolbar above the VisualizerEditor — save the current config as a named
 * preset, or load an existing one. Presets are scoped to the channel.
 * The first is_default preset is auto-applied on mount if the project has
 * an empty composition_config.
 */
export function VisualizerPresetBar({
  channelId,
  config,
  presetId,
  onApply,
}: {
  channelId: number;
  config: Record<string, unknown>;
  presetId: string;
  onApply: (config: Record<string, unknown>, presetId: string) => void;
}) {
  const { data: presets } = useVisualizerPresets(channelId);
  const createPreset = useCreateVisualizerPreset();
  const updatePreset = useUpdateVisualizerPreset();
  const deletePreset = useDeleteVisualizerPreset();
  const uploadThumbnail = useUploadPresetThumbnail();
  const captureSnapshot = useVisualizerEditorStore((s) => s.captureSnapshot);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [makeDefault, setMakeDefault] = useState(false);

  // Wait for the canvas to draw a fresh frame before capturing. The render
  // loop runs on rAF, so 2 rAFs guarantees we've seen at least one full
  // frame after the latest config change.
  const waitForFreshFrame = () =>
    new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });

  const captureAndUploadThumb = async (id: number) => {
    await waitForFreshFrame();
    const snapshot = captureSnapshot();
    if (!snapshot) {
      toast.warning("Couldn't capture preview — try again from the editor");
      return false;
    }
    try {
      await uploadThumbnail.mutateAsync({ id, dataUrl: snapshot });
      return true;
    } catch {
      return false;
    }
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    try {
      const saved = await createPreset.mutateAsync({
        channel_id: channelId,
        name: trimmed,
        preset_id: presetId,
        config,
        is_default: makeDefault,
      });
      await captureAndUploadThumb(saved.id);
      toast.success(`Saved "${trimmed}"`);
      setSaveOpen(false);
      setName("");
      setMakeDefault(false);
    } catch {
      toast.error("Failed to save preset");
    }
  };

  const refreshThumbnail = async () => {
    // Refresh the thumbnail of the most recently saved/default preset using
    // the current canvas frame. Useful when the original auto-capture was
    // empty (e.g. canvas hadn't drawn yet) or the look has been tweaked.
    const target =
      presets?.find((p) => p.is_default) ?? presets?.[0] ?? null;
    if (!target) {
      toast.error("No saved preset to refresh");
      return;
    }
    const ok = await captureAndUploadThumb(target.id);
    if (ok) toast.success(`Updated thumbnail for "${target.name}"`);
  };

  const apply = (id: string) => {
    const p = presets?.find((x) => String(x.id) === id);
    if (!p) return;
    onApply(p.config as Record<string, unknown>, p.preset_id);
    toast.success(`Loaded "${p.name}"`);
  };

  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border/50 bg-card/40 p-3">
      <Sparkles className="size-4 text-primary" />
      <span className="text-sm font-medium">Saved looks</span>
      {presets && presets.length > 0 ? (
        <Select onValueChange={apply}>
          <SelectTrigger className="h-8 w-56">
            <SelectValue placeholder="Load a saved preset…" />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => {
              // Surface what extras a saved look carries so the picker
              // is more than a name list — overlays + subscribe CTA are
              // included automatically when you "Save current".
              const cfg = (p.config ?? {}) as Record<string, unknown>;
              const hasSubscribe = cfg.overlayBuiltin === "subscribe";
              const hasOverlay = !hasSubscribe && cfg.overlayEnabled === true;
              return (
                <SelectItem key={p.id} value={String(p.id)}>
                  {p.is_default ? "★ " : ""}
                  {p.name}
                  <span className="ml-1 text-xs text-muted-foreground">
                    ({p.preset_id})
                    {hasSubscribe ? " · ▶ subscribe" : ""}
                    {hasOverlay ? " · overlay" : ""}
                  </span>
                </SelectItem>
              );
            })}
          </SelectContent>
        </Select>
      ) : (
        <span className="text-xs text-muted-foreground">No saved presets yet</span>
      )}
      <div className="flex-1" />
      {presets && presets.length > 0 && (
        <Select
          onValueChange={async (v) => {
            const p = presets.find((x) => String(x.id) === v);
            if (!p) return;
            if (!confirm(`Delete preset "${p.name}"?`)) return;
            try {
              await deletePreset.mutateAsync(p.id);
              toast.success("Deleted");
            } catch {
              toast.error("Failed to delete");
            }
          }}
        >
          <SelectTrigger className="h-8 w-32">
            <SelectValue placeholder="Delete…" />
          </SelectTrigger>
          <SelectContent>
            {presets.map((p) => (
              <SelectItem key={p.id} value={String(p.id)}>
                {p.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      {presets && presets.length > 0 && (
        <Button
          size="sm"
          variant="ghost"
          onClick={refreshThumbnail}
          title="Recapture thumbnail from current preview frame"
        >
          <RefreshCw className="size-3.5" />
          Refresh thumb
        </Button>
      )}
      <Button
        size="sm"
        variant="outline"
        onClick={async () => {
          const existing = presets?.find((p) => p.preset_id === presetId);
          if (existing) {
            // Overwrite the matching preset in place
            await updatePreset.mutateAsync({
              id: existing.id,
              body: { config, preset_id: presetId },
            });
            // Also refresh thumbnail so the dashboard reflects the new look
            await captureAndUploadThumb(existing.id);
            toast.success(`Updated "${existing.name}"`);
          } else {
            setSaveOpen((v) => !v);
          }
        }}
      >
        Save current
      </Button>
      {saveOpen && (
        <div className="flex w-full items-center gap-2 pt-1">
          <Input
            autoFocus
            placeholder="Preset name (e.g. My lofi purple)"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              if (e.key === "Escape") {
                setSaveOpen(false);
                setName("");
              }
            }}
            className="h-8 flex-1"
          />
          <label className="flex items-center gap-1 text-xs">
            <input
              type="checkbox"
              checked={makeDefault}
              onChange={(e) => setMakeDefault(e.target.checked)}
            />
            Set as default
          </label>
          <Button size="sm" onClick={save} disabled={!name.trim()}>
            Save
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setSaveOpen(false);
              setName("");
            }}
          >
            Cancel
          </Button>
        </div>
      )}
    </div>
  );
}
