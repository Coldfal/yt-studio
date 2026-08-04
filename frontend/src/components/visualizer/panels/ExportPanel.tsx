import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { Label } from "@/components/ui/label";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/**
 * Export panel — exposes render-time output settings (FPS, CRF, resolution)
 * stored on the project's composition_config. The actual render is triggered
 * by the parent Compose step's "Compose" button, which POSTs to /compose/start.
 */
export function ExportPanel() {
  const config = useVisualizerEditorStore((s) => s.config);
  const updateConfig = useVisualizerEditorStore((s) => s.updateConfig);

  // These fields live at the top level of composition_config (not inside
  // ProjectConfig proper). updateConfig merges into the same state dict.
  // Cast to any for the extension fields.
  const extConfig = config as typeof config & {
    output_fps?: number;
    output_width?: number;
    output_height?: number;
    crf?: number;
  };

  const fps = extConfig.output_fps ?? 30;
  const crf = extConfig.crf ?? 23;
  const resolution = `${extConfig.output_width ?? 1920}x${extConfig.output_height ?? 1080}`;

  const handleResolution = (value: string) => {
    const [wStr, hStr] = value.split("x");
    const w = Number(wStr);
    const h = Number(hStr);
    if (w && h) {
      updateConfig({
        output_width: w,
        output_height: h,
      } as Partial<typeof config>);
    }
  };

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold">Export Settings</h3>

      <div className="space-y-2">
        <Label className="text-xs">Resolution</Label>
        <Select value={resolution} onValueChange={handleResolution}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="1280x720">720p (1280×720)</SelectItem>
            <SelectItem value="1920x1080">1080p (1920×1080)</SelectItem>
            <SelectItem value="2560x1440">1440p (2560×1440)</SelectItem>
            <SelectItem value="3840x2160">4K (3840×2160)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Frame rate</Label>
        <Select
          value={String(fps)}
          onValueChange={(v) =>
            updateConfig({ output_fps: Number(v) } as Partial<typeof config>)
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="24">24 fps (cinematic)</SelectItem>
            <SelectItem value="30">30 fps (default)</SelectItem>
            <SelectItem value="60">60 fps (smooth)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">
          Quality (CRF): {crf}{" "}
          <span className="text-[10px] text-muted-foreground">
            (lower = better, 18–28 recommended)
          </span>
        </Label>
        <Slider
          value={[crf]}
          onValueChange={(v) =>
            updateConfig({ crf: Array.isArray(v) ? v[0] : v } as Partial<typeof config>)
          }
          min={14}
          max={35}
          step={1}
        />
      </div>

      <p className="rounded-md border border-border/40 bg-muted/20 p-2 text-[11px] text-muted-foreground">
        Click <strong>Compose Video</strong> below to start the render. A
        typical 3-minute visualizer takes 1–3 minutes depending on preset
        complexity.
      </p>
    </div>
  );
}
