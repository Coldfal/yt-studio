import { useRef, useState } from "react";
import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Upload, Image as ImageIcon, Film, X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

const SUPPORTED_IMAGE_FORMATS = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const SUPPORTED_VIDEO_FORMATS = ["video/mp4", "video/webm"];
const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB
const MAX_VIDEO_SIZE = 100 * 1024 * 1024; // 100 MB

// Built-in animated "Subscribe" CTA. The WebM has a transparent alpha
// channel (chroma-keyed from the original green-screen MP4) so it
// composites cleanly on top of the visualizer. PreviewCanvas detects the
// .webm extension and uses a hidden <video> element to drive playback;
// for server-side render we fall back to subscribe-animation.png (single
// representative frame) since the napi-rs canvas can't decode video.
export const SUBSCRIBE_OVERLAY_URL = "/subscribe-animation.webm";

/**
 * Images panel — manages the logo, background, and corner overlay.
 *
 * In the embedded editor we use blob URLs for preview. The parent component
 * (Compose step) is responsible for syncing these to actual project assets
 * before the server render runs — uploads happen through the main asset
 * system, not this panel.
 */
export function ImagesPanel() {
  const logoInputRef = useRef<HTMLInputElement>(null);
  const bgInputRef = useRef<HTMLInputElement>(null);
  const overlayInputRef = useRef<HTMLInputElement>(null);

  const config = useVisualizerEditorStore((s) => s.config);
  const updateConfig = useVisualizerEditorStore((s) => s.updateConfig);
  const logoUrl = useVisualizerEditorStore((s) => s.logoUrl);
  const backgroundUrl = useVisualizerEditorStore((s) => s.backgroundUrl);
  const overlayUrl = useVisualizerEditorStore((s) => s.overlayUrl);
  const setLogoUrl = useVisualizerEditorStore((s) => s.setLogoUrl);
  const setBackgroundUrl = useVisualizerEditorStore((s) => s.setBackgroundUrl);
  const setOverlayUrl = useVisualizerEditorStore((s) => s.setOverlayUrl);
  // Channel-aware image library + callbacks. When the parent (Compose step)
  // wires these up, the background picker becomes a thumbnail grid that
  // writes back to the project's image_asset_ids.
  const imageLibrary = useVisualizerEditorStore((s) => s.imageLibrary);
  const selectedBackgroundAssetId = useVisualizerEditorStore(
    (s) => s.selectedBackgroundAssetId,
  );
  const onBackgroundAssetSelect = useVisualizerEditorStore(
    (s) => s.onBackgroundAssetSelect,
  );
  const onBackgroundFileUpload = useVisualizerEditorStore(
    (s) => s.onBackgroundFileUpload,
  );
  const onLogoFileUpload = useVisualizerEditorStore((s) => s.onLogoFileUpload);
  const onOverlayFileUpload = useVisualizerEditorStore(
    (s) => s.onOverlayFileUpload,
  );
  const [bgUploading, setBgUploading] = useState(false);
  const [logoUploading, setLogoUploading] = useState(false);
  const [overlayUploading, setOverlayUploading] = useState(false);

  const hasLibraryMode = imageLibrary.length > 0 || onBackgroundFileUpload != null;

  async function handleFile(
    e: React.ChangeEvent<HTMLInputElement>,
    type: "logo" | "background" | "overlay",
  ) {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset the input so picking the same file again still fires onChange.
    e.target.value = "";

    if (type === "background" && config.backgroundType === "video") {
      if (!SUPPORTED_VIDEO_FORMATS.includes(file.type)) {
        toast.error("Unsupported video format. Use MP4 or WebM.");
        return;
      }
      if (file.size > MAX_VIDEO_SIZE) {
        toast.error("Video too large (max 100MB).");
        return;
      }
    } else {
      if (!SUPPORTED_IMAGE_FORMATS.includes(file.type)) {
        toast.error("Unsupported image format. Use JPEG, PNG, WebP, or GIF.");
        return;
      }
      if (file.size > MAX_IMAGE_SIZE) {
        toast.error("Image too large (max 10MB).");
        return;
      }
    }

    // Logo / overlay: when the parent has wired up an upload callback
    // (Compose step does this), prefer it — the file gets uploaded as a
    // channel asset and the parent writes ``config.logo_filepath`` /
    // ``config.overlay_filepath`` so the offline render can find it.
    // Without the callback we fall back to a local blob: URL (preview-only),
    // which is what standalone uses of the editor get.
    if (type === "logo" && onLogoFileUpload) {
      setLogoUploading(true);
      try {
        const url = await onLogoFileUpload(file);
        if (url) setLogoUrl(url);
      } finally {
        setLogoUploading(false);
      }
      return;
    }
    if (type === "overlay" && onOverlayFileUpload) {
      setOverlayUploading(true);
      try {
        const url = await onOverlayFileUpload(file);
        if (url) setOverlayUrl(url);
      } finally {
        setOverlayUploading(false);
      }
      return;
    }

    const blobUrl = URL.createObjectURL(file);
    if (type === "logo") setLogoUrl(blobUrl);
    else if (type === "background") setBackgroundUrl(blobUrl);
    else setOverlayUrl(blobUrl);
  }

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">Images</h3>

      {/* Logo */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Center Logo</Label>
          <Switch
            checked={config.logoEnabled}
            onCheckedChange={(v) => updateConfig({ logoEnabled: v })}
          />
        </div>
        <input
          ref={logoInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e, "logo")}
        />
        {config.logoEnabled && (
          <>
            {logoUrl ? (
              <div className="relative">
                <img
                  src={logoUrl}
                  alt="Logo"
                  className="h-20 w-20 rounded-lg border border-border/50 object-cover"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute -right-2 -top-2 h-6 w-6 rounded-full bg-destructive/80"
                  onClick={() => {
                    setLogoUrl(null);
                    // Also clear the persisted filepath so the offline render
                    // doesn't pull a stale logo from the previous upload.
                    if (config.logo_filepath) {
                      updateConfig({ logo_filepath: null } as Partial<typeof config>);
                    }
                  }}
                >
                  <X className="h-3 w-3 text-white" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => logoInputRef.current?.click()}
                disabled={logoUploading}
              >
                {logoUploading ? (
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                ) : (
                  <Upload className="mr-2 h-4 w-4" />
                )}
                {logoUploading ? "Uploading…" : "Upload Logo"}
              </Button>
            )}

            <div className="space-y-2">
              <Label className="text-xs">Logo Scale</Label>
              <Slider
                value={[config.logoScale]}
                onValueChange={(v) =>
                  updateConfig({ logoScale: Array.isArray(v) ? v[0] : v })
                }
                min={0.3}
                max={2}
                step={0.1}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Border Radius</Label>
              <Slider
                value={[config.logoBorderRadius]}
                onValueChange={(v) =>
                  updateConfig({ logoBorderRadius: Array.isArray(v) ? v[0] : v })
                }
                min={0}
                max={100}
                step={1}
              />
            </div>
          </>
        )}
      </div>

      {/* Background */}
      <div className="space-y-3">
        <Label>Background</Label>

        {hasLibraryMode ? (
          <>
            <p className="text-xs text-muted-foreground">
              Pick from this channel's image library — your selection becomes
              the background for the rendered video too.
            </p>

            {imageLibrary.length > 0 && (
              <div className="grid max-h-44 grid-cols-3 gap-1 overflow-y-auto rounded-md border border-border/40 p-1">
                {imageLibrary.map((a) => {
                  const selected = selectedBackgroundAssetId === a.id;
                  // Asset can be image OR video. Videos play as a looping
                  // muted preview so the user sees the motion before
                  // picking. The compose backend detects video by file
                  // extension and switches to a chromakey-overlay pipeline.
                  const isVideo = a.asset_type === "video";
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() => {
                        if (onBackgroundAssetSelect) {
                          onBackgroundAssetSelect(selected ? null : a.id);
                        }
                        setBackgroundUrl(selected ? null : a.file_url);
                      }}
                      className={cn(
                        "group relative aspect-video overflow-hidden rounded border bg-muted transition",
                        selected
                          ? "ring-2 ring-primary"
                          : "border-border/50 hover:border-border",
                      )}
                      title={a.title || a.filename}
                    >
                      {isVideo ? (
                        <video
                          src={a.file_url}
                          className="h-full w-full object-cover"
                          autoPlay
                          loop
                          muted
                          playsInline
                          // Don't preload until visible — saves bandwidth
                          // when the user has many video assets.
                          preload="metadata"
                          onError={(e) => {
                            const v = e.currentTarget;
                            v.style.display = "none";
                            const parent = v.parentElement;
                            if (parent) parent.style.display = "none";
                          }}
                        />
                      ) : (
                        <img
                          src={a.file_url}
                          alt={a.title || a.filename}
                          className="h-full w-full object-cover"
                          loading="lazy"
                          onError={(e) => {
                            // Hide tiles whose underlying file is missing on disk
                            const img = e.currentTarget;
                            img.style.display = "none";
                            const parent = img.parentElement;
                            if (parent) {
                              parent.style.display = "none";
                            }
                          }}
                        />
                      )}
                      {isVideo && (
                        <span
                          className="absolute left-1 top-1 rounded bg-black/60 px-1 text-[9px] font-medium uppercase tracking-wide text-white"
                          title="Video — loops as the visualizer background"
                        >
                          ▶ video
                        </span>
                      )}
                      {selected && (
                        <div className="absolute inset-0 bg-primary/15" />
                      )}
                    </button>
                  );
                })}
              </div>
            )}

            <input
              ref={bgInputRef}
              type="file"
              // Accept both images and the supported video mime types — the
              // parent's upload handler routes to the right asset_type by
              // detecting file.type. Compose backend in turn detects video
              // by file extension and switches to a chromakey overlay
              // pipeline; keeping the picker single-purpose ("background")
              // is simpler than two buttons.
              accept="image/*,video/mp4,video/webm"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file || !onBackgroundFileUpload) return;
                const isVideoFile = SUPPORTED_VIDEO_FORMATS.includes(file.type);
                if (isVideoFile) {
                  if (file.size > MAX_VIDEO_SIZE) {
                    toast.error("Video too large (max 100MB).");
                    return;
                  }
                } else {
                  if (file.size > MAX_IMAGE_SIZE) {
                    toast.error("Image too large (max 10MB).");
                    return;
                  }
                }
                setBgUploading(true);
                try {
                  const url = await onBackgroundFileUpload(file);
                  if (url) setBackgroundUrl(url);
                } catch {
                  toast.error("Upload failed");
                } finally {
                  setBgUploading(false);
                  if (e.target) e.target.value = "";
                }
              }}
            />
            <Button
              variant="outline"
              className="w-full"
              onClick={() => bgInputRef.current?.click()}
              disabled={bgUploading || !onBackgroundFileUpload}
            >
              {bgUploading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Upload className="mr-2 h-4 w-4" />
              )}
              {bgUploading ? "Uploading…" : "Upload image or .mp4"}
            </Button>
          </>
        ) : (
          <>
            <p className="text-xs text-muted-foreground">
              Preview-only upload — picks here only show in the preview, the
              rendered video uses the project's selected images.
            </p>
            <input
              ref={bgInputRef}
              type="file"
              accept={config.backgroundType === "video" ? "video/mp4,video/webm" : "image/*"}
              className="hidden"
              onChange={(e) => handleFile(e, "background")}
            />
            {backgroundUrl ? (
              <div className="relative">
                <img
                  src={backgroundUrl}
                  alt="Background"
                  className="h-20 w-full rounded-lg border border-border/50 object-cover"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute -right-2 -top-2 h-6 w-6 rounded-full bg-destructive/80"
                  onClick={() => setBackgroundUrl(null)}
                >
                  <X className="h-3 w-3 text-white" />
                </Button>
              </div>
            ) : (
              <Button
                variant="outline"
                className="w-full"
                onClick={() => bgInputRef.current?.click()}
              >
                <ImageIcon className="mr-2 h-4 w-4" />
                Upload preview background
              </Button>
            )}
          </>
        )}

      </div>

      {/* Corner Overlay */}
      <div className="space-y-3">
        <Label>Corner Overlay</Label>
        <p className="text-xs text-muted-foreground">
          Add a logo, subscribe CTA, or watermark on top of the video.
        </p>

        <input
          ref={overlayInputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(e) => handleFile(e, "overlay")}
        />

        {/* One-click "Subscribe" animation preset. Loads a built-in PNG and
            primes timed visibility + fade so it appears, lingers, and fades
            out. User can still override position/scale/opacity below. */}
        <div className="flex items-center justify-between rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2">
          <div className="flex-1">
            <Label className="text-xs">Subscribe Animation</Label>
            <p className="text-[11px] text-muted-foreground">
              Auto-show a "SUBSCRIBE" CTA at 5–13 s with fade in/out.
            </p>
          </div>
          <Switch
            checked={overlayUrl === SUBSCRIBE_OVERLAY_URL}
            onCheckedChange={(on) => {
              if (on) {
                setOverlayUrl(SUBSCRIBE_OVERLAY_URL);
                updateConfig({
                  overlayEnabled: true,
                  overlayPosition: "bottom-right",
                  // Marker that survives save/restore: the server-side
                  // visualizer engine resolves `overlayBuiltin: "subscribe"`
                  // to the bundled `data/builtin/subscribe-animation.png`,
                  // and the browser preview detects it to load the WebM.
                  overlayBuiltin: "subscribe",
                  // The animation source is 1280×720 with the subscribe
                  // group occupying the center ~50% — we scale up to
                  // compensate so the visible button is readable.
                  overlayScale: 2.5,
                  overlayOpacity: 1.0,
                  overlayStartTime: 2,
                  overlayEndTime: 10,
                  overlayFadeIn: 0.4,
                  overlayFadeOut: 0.8,
                });
              } else {
                setOverlayUrl(null);
                updateConfig({
                  overlayEnabled: false,
                  overlayBuiltin: null,
                  overlayStartTime: null,
                  overlayEndTime: null,
                });
              }
            }}
          />
        </div>

        {overlayUrl ? (
          <div className="relative">
            <img
              src={overlayUrl}
              alt="Overlay"
              className="h-16 w-16 rounded-lg border border-border/50 object-contain bg-black/50"
            />
            <Button
              variant="ghost"
              size="icon"
              className="absolute -right-2 -top-2 h-6 w-6 rounded-full bg-destructive/80"
              onClick={() => {
                setOverlayUrl(null);
                updateConfig({
                  overlayEnabled: false,
                  // Clear both the builtin marker and the custom filepath so
                  // the offline render doesn't pick up a stale overlay.
                  overlayBuiltin: null,
                  overlay_filepath: null,
                } as Partial<typeof config>);
              }}
            >
              <X className="h-3 w-3 text-white" />
            </Button>
          </div>
        ) : (
          <Button
            variant="outline"
            className="w-full"
            onClick={() => {
              overlayInputRef.current?.click();
              updateConfig({ overlayEnabled: true });
            }}
            disabled={overlayUploading}
          >
            {overlayUploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {overlayUploading ? "Uploading…" : "Upload Overlay"}
          </Button>
        )}

        {overlayUrl && (
          <>
            <div className="space-y-2">
              <Label className="text-xs">Position</Label>
              <Select
                value={config.overlayPosition}
                onValueChange={(v) =>
                  v && updateConfig({ overlayPosition: v as typeof config.overlayPosition })
                }
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="top-left">Top Left</SelectItem>
                  <SelectItem value="top-right">Top Right</SelectItem>
                  <SelectItem value="bottom-left">Bottom Left</SelectItem>
                  <SelectItem value="bottom-right">Bottom Right</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Scale</Label>
              <Slider
                value={[config.overlayScale]}
                onValueChange={(v) =>
                  updateConfig({ overlayScale: Array.isArray(v) ? v[0] : v })
                }
                min={0.2}
                max={3}
                step={0.05}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Opacity</Label>
              <Slider
                value={[config.overlayOpacity]}
                onValueChange={(v) =>
                  updateConfig({ overlayOpacity: Array.isArray(v) ? v[0] : v })
                }
                min={0.1}
                max={1}
                step={0.05}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Offset X</Label>
              <Slider
                value={[config.overlayOffsetX]}
                onValueChange={(v) =>
                  updateConfig({ overlayOffsetX: Array.isArray(v) ? v[0] : v })
                }
                min={-50}
                max={50}
                step={1}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Offset Y</Label>
              <Slider
                value={[config.overlayOffsetY]}
                onValueChange={(v) =>
                  updateConfig({ overlayOffsetY: Array.isArray(v) ? v[0] : v })
                }
                min={-50}
                max={50}
                step={1}
              />
            </div>

            {/* Timed overlay */}
            <div className="space-y-2 pt-1">
              <div className="flex items-center justify-between">
                <Label className="text-xs">Timed Visibility</Label>
                <Switch
                  checked={config.overlayEndTime !== null}
                  onCheckedChange={(on) =>
                    updateConfig({
                      overlayStartTime: on ? 5 : null,
                      overlayEndTime: on ? 10 : null,
                    })
                  }
                />
              </div>
              <p className="text-[11px] text-muted-foreground">
                Show overlay only between two time points (e.g. a subscribe CTA for 5 s).
              </p>
            </div>

            {config.overlayEndTime !== null && (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">Start (s)</Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {config.overlayStartTime ?? 0}s
                    </span>
                  </div>
                  <Slider
                    value={[config.overlayStartTime ?? 0]}
                    onValueChange={(value) => {
                      const start = Array.isArray(value) ? value[0] : value;
                      const end = config.overlayEndTime ?? start + 5;
                      updateConfig({
                        overlayStartTime: start,
                        overlayEndTime: Math.max(end, start + 1),
                      });
                    }}
                    min={0}
                    max={300}
                    step={1}
                  />
                </div>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs">End (s)</Label>
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {config.overlayEndTime}s
                      {" · "}
                      {(config.overlayEndTime ?? 0) - (config.overlayStartTime ?? 0)}s shown
                    </span>
                  </div>
                  <Slider
                    value={[config.overlayEndTime ?? 10]}
                    onValueChange={(value) => {
                      const end = Array.isArray(value) ? value[0] : value;
                      updateConfig({
                        overlayEndTime: Math.max(end, (config.overlayStartTime ?? 0) + 1),
                      });
                    }}
                    min={1}
                    max={300}
                    step={1}
                  />
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <div className="space-y-1.5">
                    <Label className="text-xs">Fade In (s)</Label>
                    <Slider
                      value={[config.overlayFadeIn ?? 0.5]}
                      onValueChange={(v) => updateConfig({ overlayFadeIn: v })}
                      min={0}
                      max={3}
                      step={0.1}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Fade Out (s)</Label>
                    <Slider
                      value={[config.overlayFadeOut ?? 0.5]}
                      onValueChange={(v) => updateConfig({ overlayFadeOut: v })}
                      min={0}
                      max={3}
                      step={0.1}
                    />
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}
