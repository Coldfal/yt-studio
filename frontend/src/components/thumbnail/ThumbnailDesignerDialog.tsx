/**
 * Dashboard sticky-thumbnail designer.
 *
 * Lighter-weight sibling to the wizard's ThumbnailStep — same
 * ThumbnailCanvas + effect presets, but tuned for "design a TEMPLATE
 * once, reuse on every quick-generated video" instead of "design ONE
 * thumbnail for ONE specific project". Lives inside a Dialog so it
 * doesn't take over the dashboard layout.
 *
 * The wizard's ThumbnailStep stays as-is — extracting a shared editor
 * abstraction was overkill given the two use cases diverge on what the
 * Save button does (POST to /projects/{id}/thumbnail vs
 * /automation/presets/{id}/thumbnail). The shared piece is the canvas
 * itself + the effect renderers, which both already import from
 * @/components/thumbnail/{ThumbnailCanvas,effects}.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Image as ImageIcon,
  Plus,
  Save,
  Sparkles,
  Trash2,
  Type,
  Upload,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { ensureFontsLoaded, type FontInfo } from "@/lib/fonts";
import { useAssets, useUploadAsset } from "@/hooks/use-assets";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import {
  ThumbnailCanvas,
  type ThumbnailCanvasHandle,
} from "@/components/thumbnail/ThumbnailCanvas";
import {
  PRESET_OPTIONS,
  type EffectPreset,
  type TextLayer,
} from "@/components/thumbnail/effects";

export interface ThumbnailEditorState {
  bg: { kind: "asset" | "upload"; asset_id: number | null };
  layers: TextLayer[];
}

const DEFAULT_LAYER: TextLayer = {
  text: "Your title here",
  x: 0.5,
  y: 0.82,
  font: "Cinzel",
  size: 96,
  color: "#fff6d0",
  weight: "bold",
  align: "center",
  effect_preset: "bloom",
};

function defaultState(): ThumbnailEditorState {
  return {
    bg: { kind: "asset", asset_id: null },
    layers: [{ ...DEFAULT_LAYER }],
  };
}

export interface ThumbnailDesignerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: number;
  presetId: number;
  /** Existing state to seed the editor with (from preset.default_thumbnail_editor_state). */
  initialState: ThumbnailEditorState | null;
  /** Fires after a successful Save so the parent can refresh its sticky preview. */
  onSaved?: (assetId: number) => void;
}

export function ThumbnailDesignerDialog({
  open,
  onOpenChange,
  channelId,
  presetId,
  initialState,
  onSaved,
}: ThumbnailDesignerDialogProps) {
  const queryClient = useQueryClient();
  const uploadAsset = useUploadAsset();

  const [state, setState] = useState<ThumbnailEditorState>(
    () => initialState ?? defaultState(),
  );
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [fontsReady, setFontsReady] = useState(false);
  const canvasRef = useRef<ThumbnailCanvasHandle | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(720);

  // Reseed when reopening with new initialState (e.g. operator picks a
  // different channel's card).
  useEffect(() => {
    if (open) {
      setState(initialState ?? defaultState());
      setSelectedIndex(0);
    }
  }, [open, initialState]);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 720;
      setContainerWidth(Math.max(320, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [open]);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    ensureFontsLoaded()
      .then((list) => {
        if (cancelled) return;
        setFonts(list);
        setFontsReady(true);
      })
      .catch(() => setFontsReady(true));
    return () => {
      cancelled = true;
    };
  }, [open]);

  const { data: channelImages } = useAssets({
    channel_id: channelId,
    asset_type: "image",
  });
  const imageLibrary = useMemo(
    () => (channelImages ?? []).filter((a) => a.file_exists !== false),
    [channelImages],
  );
  const bgAsset = useMemo(() => {
    if (state.bg.asset_id == null) return null;
    return imageLibrary.find((a) => a.id === state.bg.asset_id) ?? null;
  }, [state.bg.asset_id, imageLibrary]);
  const bgUrl = bgAsset?.file_url ?? null;

  // ── Layer mutations ────────────────────────────────────────────
  const setLayers = (next: TextLayer[]) =>
    setState((s) => ({ ...s, layers: next }));

  const addLayer = () => {
    if (state.layers.length >= 4) {
      toast.error("Max 4 layers. Delete one first.");
      return;
    }
    const next = [
      ...state.layers,
      {
        ...DEFAULT_LAYER,
        text: "New text",
        y: Math.min(0.95, 0.3 + state.layers.length * 0.18),
      },
    ];
    setLayers(next);
    setSelectedIndex(next.length - 1);
  };

  const removeLayer = (i: number) => {
    const next = state.layers.filter((_, idx) => idx !== i);
    setLayers(next);
    setSelectedIndex(Math.min(selectedIndex, next.length - 1));
  };

  const updateLayer = (i: number, patch: Partial<TextLayer>) => {
    const next = state.layers.map((l, idx) =>
      idx === i ? { ...l, ...patch } : l,
    );
    setLayers(next);
  };

  // ── Background ─────────────────────────────────────────────────
  const onUploadBg = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("channel_id", String(channelId));
    formData.append("asset_type", "image");
    try {
      const asset = await uploadAsset.mutateAsync(formData);
      setState((s) => ({ ...s, bg: { kind: "asset", asset_id: asset.id } }));
      toast.success("Background uploaded");
    } catch {
      toast.error("Background upload failed");
    }
  };

  // ── Save ───────────────────────────────────────────────────────
  const onSave = useCallback(async () => {
    const blob = await canvasRef.current?.getJpegBlob(0.92);
    if (!blob) {
      toast.error("Couldn't render. Pick a background first.");
      return;
    }
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append("file", blob, `sticky_preset${presetId}.jpg`);
      formData.append("editor_state", JSON.stringify(state));
      const { data } = await api.post(
        `/automation/presets/${presetId}/thumbnail`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      toast.success(
        `Sticky thumbnail saved (${Math.round(data.file_size / 1024)} KB)`,
      );
      queryClient.invalidateQueries({ queryKey: ["channel-primary-preset"] });
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      onSaved?.(data.asset_id);
      onOpenChange(false);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [presetId, state, queryClient, onSaved, onOpenChange]);

  const selected = state.layers[selectedIndex];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[95vw] sm:max-w-[1400px] max-h-[92vh] overflow-y-auto p-5">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-sm">
            <ImageIcon className="size-4" />
            Design sticky thumbnail
          </DialogTitle>
          <DialogDescription className="text-xs">
            This design ships with every quick-generated video on the channel.
            Per-video override is still available in the wizard's Thumbnail step.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 lg:grid-cols-[minmax(0,1fr)_360px]">
          {/* Canvas */}
          <div ref={containerRef} className="flex justify-center">
            {!fontsReady || !bgUrl ? (
              <div
                className="flex items-center justify-center rounded bg-muted/30 text-xs text-muted-foreground"
                style={{
                  width: containerWidth,
                  height: (containerWidth * 720) / 1280,
                }}
              >
                {!fontsReady
                  ? "Loading fonts…"
                  : "Pick a background to start."}
              </div>
            ) : (
              <ThumbnailCanvas
                ref={canvasRef}
                bgUrl={bgUrl}
                layers={state.layers}
                selectedIndex={selectedIndex}
                containerWidth={containerWidth}
                onLayersChange={setLayers}
                onSelect={setSelectedIndex}
              />
            )}
          </div>

          {/* Sidebar */}
          <div className="space-y-3">
            {/* Background */}
            <div className="rounded border border-border/50 p-2">
              <Label className="mb-1.5 block text-[11px]">Background</Label>
              <div className="grid grid-cols-2 gap-1">
                <label
                  className={cn(
                    "cursor-pointer rounded border px-2 py-1 text-center text-[10px]",
                    state.bg.kind === "upload"
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-muted",
                  )}
                >
                  <input
                    type="file"
                    accept="image/jpeg,image/png,image/webp"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) onUploadBg(f);
                      e.target.value = "";
                    }}
                  />
                  <Upload className="mr-1 inline size-3" />
                  Upload new
                </label>
                <div className="rounded border border-border bg-muted/30 px-2 py-1 text-center text-[10px] text-muted-foreground">
                  or pick below
                </div>
              </div>
              <div className="mt-2 max-h-40 overflow-y-auto rounded border border-border/30 p-1">
                {imageLibrary.length === 0 ? (
                  <div className="py-3 text-center text-[10px] text-muted-foreground">
                    No images in library yet.
                  </div>
                ) : (
                  <div className="grid grid-cols-3 gap-1">
                    {imageLibrary.map((a) => (
                      <button
                        key={a.id}
                        type="button"
                        onClick={() =>
                          setState((s) => ({
                            ...s,
                            bg: { kind: "asset", asset_id: a.id },
                          }))
                        }
                        className={cn(
                          "aspect-video overflow-hidden rounded border",
                          state.bg.asset_id === a.id
                            ? "border-primary ring-2 ring-primary/50"
                            : "border-border/40 hover:border-foreground/40",
                        )}
                        title={a.filename}
                      >
                        <img
                          src={a.file_url}
                          alt=""
                          className="size-full object-cover"
                          loading="lazy"
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Layers */}
            <div className="rounded border border-border/50 p-2">
              <div className="mb-1.5 flex items-center justify-between">
                <Label className="flex items-center gap-1 text-[11px]">
                  <Type className="size-3" /> Text layers ({state.layers.length})
                </Label>
                <Button size="sm" variant="outline" onClick={addLayer} className="h-6 px-2 text-[10px]">
                  <Plus className="size-3" />
                  Add text layer
                </Button>
              </div>
              <div className="space-y-1">
                {state.layers.map((layer, i) => (
                  <button
                    type="button"
                    key={i}
                    onClick={() => setSelectedIndex(i)}
                    className={cn(
                      "flex w-full items-center gap-1.5 rounded border px-1.5 py-1 text-left text-[10px]",
                      selectedIndex === i
                        ? "border-primary bg-primary/10"
                        : "border-border/40 hover:bg-muted",
                    )}
                  >
                    <span className="flex-1 truncate">{layer.text || "(empty)"}</span>
                    <span className="text-muted-foreground">{layer.font}</span>
                    <Trash2
                      className="size-3 text-muted-foreground hover:text-destructive"
                      onClick={(e) => {
                        e.stopPropagation();
                        removeLayer(i);
                      }}
                    />
                  </button>
                ))}
                {state.layers.length === 0 && (
                  <div className="py-2 text-center text-[10px] text-muted-foreground">
                    No layers. Click Add.
                  </div>
                )}
              </div>
            </div>

            {/* Selected-layer settings */}
            {selected && (
              <div className="rounded border border-border/50 p-2">
                <Label className="mb-1.5 block text-[11px]">
                  <Sparkles className="mr-1 inline size-3" />
                  Layer settings
                </Label>
                <div className="space-y-2">
                  <Input
                    value={selected.text}
                    onChange={(e) =>
                      updateLayer(selectedIndex, { text: e.target.value })
                    }
                    className="h-7 text-[11px]"
                    placeholder="Text"
                  />
                  <Select
                    value={selected.font}
                    onValueChange={(v) => updateLayer(selectedIndex, { font: v })}
                  >
                    <SelectTrigger className="h-7 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {fonts.map((f) => (
                        <SelectItem key={f.family} value={f.family}>
                          <span style={{ fontFamily: `"${f.family}"` }}>{f.family}</span>
                        </SelectItem>
                      ))}
                      {fonts.length === 0 && (
                        <SelectItem value="sans-serif">sans-serif</SelectItem>
                      )}
                    </SelectContent>
                  </Select>
                  <Select
                    value={selected.effect_preset}
                    onValueChange={(v) =>
                      updateLayer(selectedIndex, {
                        effect_preset: v as EffectPreset,
                      })
                    }
                  >
                    <SelectTrigger className="h-7 text-[11px]">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PRESET_OPTIONS.map((p) => (
                        <SelectItem key={p.value} value={p.value}>
                          {p.label}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="space-y-1">
                    <Label className="text-[10px]">Size · {selected.size}px</Label>
                    <Slider
                      min={32}
                      max={220}
                      step={2}
                      value={[selected.size]}
                      onValueChange={(value) => {
                        const size = Array.isArray(value) ? value[0] : value;
                        updateLayer(selectedIndex, { size });
                      }}
                    />
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className="space-y-1">
                      <Label className="text-[10px]">Color</Label>
                      <Input
                        type="color"
                        value={selected.color}
                        onChange={(e) =>
                          updateLayer(selectedIndex, { color: e.target.value })
                        }
                        className="h-7 cursor-pointer p-1"
                      />
                    </div>
                    <div className="space-y-1">
                      <Label className="text-[10px]">Align</Label>
                      <Select
                        value={selected.align}
                        onValueChange={(v) =>
                          updateLayer(selectedIndex, {
                            align: v as "left" | "center" | "right",
                          })
                        }
                      >
                        <SelectTrigger className="h-7 text-[11px]"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          <SelectItem value="left">Left</SelectItem>
                          <SelectItem value="center">Center</SelectItem>
                          <SelectItem value="right">Right</SelectItem>
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                </div>
              </div>
            )}

            <Button
              onClick={onSave}
              disabled={saving || !bgUrl}
              className="w-full"
              size="sm"
            >
              <Save className="size-3" />
              {saving ? "Saving…" : "Save sticky thumbnail"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
