/**
 * Wizard step for designing the per-video thumbnail.
 *
 * Flow:
 *   1. Pick a background (channel library / upload new / use the video's
 *      first composition background).
 *   2. Add and arrange text layers. Drag on canvas to position.
 *   3. Pick font, size, color, effect preset per layer.
 *   4. Click Save → browser renders the canvas to a JPEG, POSTs to
 *      `/api/projects/:id/thumbnail` along with the editor state JSON.
 *      Backend saves the JPEG as an `asset_type='image'` asset and links
 *      it via `project.thumbnail_asset_id`. The existing upload pipeline
 *      uses that ID — no other backend change needed.
 *
 * Optional step. The user can advance to Publish without saving; YouTube
 * will pick a frame from the video instead.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Image as ImageIcon, Plus, Save, Trash2, Type, Upload } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { ensureFontsLoaded, type FontInfo } from "@/lib/fonts";
import { useAssets, useUploadAsset } from "@/hooks/use-assets";
import {
  ThumbnailCanvas,
  type ThumbnailCanvasHandle,
  CANVAS_W,
  CANVAS_H,
} from "@/components/thumbnail/ThumbnailCanvas";
import {
  PRESET_OPTIONS,
  type EffectPreset,
  type TextLayer,
} from "@/components/thumbnail/effects";
import type { Asset, VideoProject } from "@/types/index";

type BgKind = "asset" | "upload" | "video_bg";

interface EditorState {
  bg: { kind: BgKind; asset_id: number | null };
  layers: TextLayer[];
}

const DEFAULT_LAYER: TextLayer = {
  text: "Your Title",
  x: 0.5,
  y: 0.82,
  font: "Cinzel",
  size: 96,
  color: "#fff6d0",
  weight: "bold",
  align: "center",
  effect_preset: "bloom",
};

function defaultState(initialText: string): EditorState {
  return {
    bg: { kind: "video_bg", asset_id: null },
    layers: [{ ...DEFAULT_LAYER, text: initialText || DEFAULT_LAYER.text }],
  };
}

export function ThumbnailStep({ project }: { project: VideoProject }) {
  const queryClient = useQueryClient();
  const uploadAsset = useUploadAsset();

  // ── State ────────────────────────────────────────────────────────
  const initialState = useMemo<EditorState>(() => {
    const persisted = project.thumbnail_editor_state;
    if (persisted && persisted.layers?.length) {
      return {
        bg: persisted.bg ?? { kind: "video_bg", asset_id: null },
        layers: persisted.layers as TextLayer[],
      };
    }
    return defaultState(project.youtube_title || project.title);
  }, [project]);

  const [state, setState] = useState<EditorState>(initialState);
  const [selectedIndex, setSelectedIndex] = useState<number>(0);
  const [saving, setSaving] = useState(false);
  const [fonts, setFonts] = useState<FontInfo[]>([]);
  const [fontsReady, setFontsReady] = useState(false);
  const canvasRef = useRef<ThumbnailCanvasHandle | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [containerWidth, setContainerWidth] = useState(960);

  // ── Track container width for responsive canvas sizing ──────────
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width ?? 960;
      setContainerWidth(Math.max(320, Math.floor(w)));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Load fonts once ──────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    ensureFontsLoaded().then((list) => {
      if (cancelled) return;
      setFonts(list);
      setFontsReady(true);
    }).catch((err) => {
      // eslint-disable-next-line no-console
      console.warn("Font registry failed to load:", err);
      setFontsReady(true); // unblock the UI; falls back to default sans
    });
    return () => { cancelled = true; };
  }, []);

  // ── Resolve background URL ───────────────────────────────────────
  const { data: channelImages } = useAssets({
    channel_id: project.channel_id,
    asset_type: "image",
  });
  const imageLibrary = (channelImages ?? []).filter(
    (a) => a.file_exists !== false,
  );

  // For video_bg: resolve to the first composition image asset id.
  const videoBgAssetId: number | null = useMemo(() => {
    const ids = (project.image_asset_ids ?? []) as number[];
    return ids.length ? Number(ids[0]) : null;
  }, [project.image_asset_ids]);

  const bgAsset: Asset | null = useMemo(() => {
    if (state.bg.kind === "video_bg") {
      if (!videoBgAssetId) return null;
      return imageLibrary.find((a) => a.id === videoBgAssetId) ?? null;
    }
    if (state.bg.asset_id == null) return null;
    return imageLibrary.find((a) => a.id === state.bg.asset_id) ?? null;
  }, [state.bg, videoBgAssetId, imageLibrary]);

  const bgUrl = bgAsset?.file_url ?? null;

  // ── Layer mutations ──────────────────────────────────────────────
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
        // Stagger so the new layer doesn't sit on top of an existing one.
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

  // ── Background switching ────────────────────────────────────────
  const setBgKind = (kind: BgKind, asset_id: number | null = null) => {
    setState((s) => ({ ...s, bg: { kind, asset_id } }));
  };

  const onUploadBg = async (file: File) => {
    const formData = new FormData();
    formData.append("file", file);
    formData.append("channel_id", String(project.channel_id));
    formData.append("asset_type", "image");
    try {
      const asset = await uploadAsset.mutateAsync(formData);
      setBgKind("asset", asset.id);
      toast.success("Background uploaded");
    } catch {
      toast.error("Background upload failed");
    }
  };

  // ── Save ────────────────────────────────────────────────────────
  const onSave = useCallback(async () => {
    const blob = await canvasRef.current?.getJpegBlob(0.92);
    if (!blob) {
      toast.error("Couldn't render thumbnail. Try changing the background.");
      return;
    }
    setSaving(true);
    try {
      const formData = new FormData();
      formData.append("file", blob, `thumb_p${project.id}.jpg`);
      formData.append("editor_state", JSON.stringify(state));
      const { data } = await api.post(
        `/projects/${project.id}/thumbnail`,
        formData,
        { headers: { "Content-Type": "multipart/form-data" } },
      );
      toast.success(`Thumbnail saved (${Math.round(data.file_size / 1024)} KB)`);
      // Refresh the project so other steps (Publish) see the new thumbnail_asset_id.
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["project", project.id] });
      queryClient.invalidateQueries({ queryKey: ["assets"] });
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Save failed.");
    } finally {
      setSaving(false);
    }
  }, [project.id, state, queryClient]);

  // ── Render ──────────────────────────────────────────────────────
  const selected = state.layers[selectedIndex];

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
      {/* Canvas */}
      <div ref={containerRef} className="space-y-3">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center gap-2 text-base">
              <ImageIcon className="size-4" />
              Thumbnail preview
              <span className="ml-auto text-xs font-normal text-muted-foreground">
                {CANVAS_W}×{CANVAS_H} · click + drag to move text
              </span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex justify-center">
            {!fontsReady ? (
              <div
                className="flex items-center justify-center bg-muted/30 text-muted-foreground"
                style={{ width: containerWidth, height: (containerWidth * CANVAS_H) / CANVAS_W }}
              >
                Loading fonts…
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
          </CardContent>
        </Card>

        <div className="flex items-center justify-between gap-3">
          <div className="text-xs text-muted-foreground">
            Optional. Skip with Next → YouTube will pick a frame from the video.
          </div>
          <Button onClick={onSave} disabled={saving || !bgUrl}>
            <Save className="size-4" />
            {saving ? "Saving…" : "Save thumbnail"}
          </Button>
        </div>
      </div>

      {/* Sidebar */}
      <div className="space-y-4">
        {/* Background */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Background</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-3 gap-1">
              <button
                type="button"
                onClick={() => setBgKind("video_bg")}
                className={cn(
                  "rounded border px-2 py-1.5 text-xs",
                  state.bg.kind === "video_bg"
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted",
                )}
              >
                Video bg
              </button>
              <button
                type="button"
                onClick={() => setBgKind("asset", state.bg.asset_id)}
                className={cn(
                  "rounded border px-2 py-1.5 text-xs",
                  state.bg.kind === "asset"
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted",
                )}
              >
                Library
              </button>
              <label
                className={cn(
                  "cursor-pointer rounded border px-2 py-1.5 text-center text-xs",
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
                Upload
              </label>
            </div>

            {state.bg.kind === "video_bg" && !videoBgAssetId && (
              <div className="rounded border border-amber-500/40 bg-amber-500/10 p-2 text-xs text-amber-300">
                This project doesn't have a video background yet. Compose the
                video first, or pick from the channel library / upload.
              </div>
            )}

            {state.bg.kind === "asset" && (
              <div className="max-h-56 overflow-y-auto">
                <div className="grid grid-cols-3 gap-2">
                  {imageLibrary.map((a) => (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => setBgKind("asset", a.id)}
                      className={cn(
                        "aspect-video overflow-hidden rounded border",
                        state.bg.asset_id === a.id
                          ? "border-primary ring-2 ring-primary/50"
                          : "border-border hover:border-foreground/40",
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
                  {imageLibrary.length === 0 && (
                    <div className="col-span-3 py-4 text-center text-xs text-muted-foreground">
                      No images in this channel's library yet.
                    </div>
                  )}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        {/* Layers */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="flex items-center justify-between text-sm">
              <span className="flex items-center gap-2">
                <Type className="size-4" />
                Text layers ({state.layers.length})
              </span>
              <Button size="sm" variant="outline" onClick={addLayer}>
                <Plus className="size-3" />
                Add text layer
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {state.layers.map((layer, i) => (
              <button
                type="button"
                key={i}
                onClick={() => setSelectedIndex(i)}
                className={cn(
                  "flex w-full items-center gap-2 rounded border px-2 py-1.5 text-left text-xs",
                  selectedIndex === i
                    ? "border-primary bg-primary/10"
                    : "border-border hover:bg-muted",
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
              <div className="text-xs text-muted-foreground">
                No layers. Click "Add" to start.
              </div>
            )}
          </CardContent>
        </Card>

        {/* Selected-layer editor */}
        {selected && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm">Layer settings</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="space-y-1">
                <Label htmlFor="layer-text" className="text-xs">Text</Label>
                <Input
                  id="layer-text"
                  value={selected.text}
                  onChange={(e) => updateLayer(selectedIndex, { text: e.target.value })}
                />
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Font</Label>
                <Select
                  value={selected.font}
                  onValueChange={(v) => updateLayer(selectedIndex, { font: v })}
                >
                  <SelectTrigger>
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
              </div>

              <div className="space-y-1">
                <Label className="text-xs">Effect preset</Label>
                <Select
                  value={selected.effect_preset}
                  onValueChange={(v) =>
                    updateLayer(selectedIndex, { effect_preset: v as EffectPreset })
                  }
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PRESET_OPTIONS.map((p) => (
                      <SelectItem key={p.value} value={p.value}>
                        <div className="flex flex-col">
                          <span>{p.label}</span>
                          <span className="text-[10px] text-muted-foreground">
                            {p.description}
                          </span>
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Size · {selected.size}px</Label>
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
                <div className="space-y-1">
                  <Label className="text-xs">Color</Label>
                  <Input
                    type="color"
                    value={selected.color}
                    onChange={(e) =>
                      updateLayer(selectedIndex, { color: e.target.value })
                    }
                    className="h-9 cursor-pointer p-1"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-xs">Weight</Label>
                  <Select
                    value={selected.weight}
                    onValueChange={(v) =>
                      updateLayer(selectedIndex, {
                        weight: v as "normal" | "bold",
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="normal">Normal</SelectItem>
                      <SelectItem value="bold">Bold</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Align</Label>
                  <Select
                    value={selected.align}
                    onValueChange={(v) =>
                      updateLayer(selectedIndex, {
                        align: v as "left" | "center" | "right",
                      })
                    }
                  >
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="left">Left</SelectItem>
                      <SelectItem value="center">Center</SelectItem>
                      <SelectItem value="right">Right</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
