

import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { ProjectConfig } from "@/types/visualizer";

export function ElementsPanel() {
  const config = useVisualizerEditorStore((s) => s.config);
  const updateConfig = useVisualizerEditorStore((s) => s.updateConfig);
  const presetId = useVisualizerEditorStore((s) => s.presetId);
  const isLinearPreset = presetId === "linear-bars" || presetId === "linear-dots";

  return (
    <div className="space-y-6">
      <h3 className="text-sm font-semibold">Elements & Effects</h3>

      {/* Linear Layout — only for linear presets */}
      {isLinearPreset && (
        <div className="space-y-3">
          <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Linear Layout
          </h4>
          <div className="space-y-2">
            <Label className="text-xs">Position</Label>
            <div className="grid grid-cols-2 gap-1.5">
              {([
                { id: "center", label: "Center" },
                { id: "bottom", label: "Bottom" },
              ] as const).map((p) => (
                <button
                  key={p.id}
                  onClick={() => updateConfig({ linearPosition: p.id })}
                  className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                    config.linearPosition === p.id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                  }`}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">
              Repeat across screen: {config.linearRepeat}
            </Label>
            <Slider
              value={[config.linearRepeat]}
              onValueChange={(v) => updateConfig({ linearRepeat: Array.isArray(v) ? v[0] : v })}
              min={1}
              max={10}
              step={1}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">
              Width: {Math.round(config.linearWidth * 100)}%
            </Label>
            <Slider
              value={[config.linearWidth]}
              onValueChange={(v) => updateConfig({ linearWidth: Array.isArray(v) ? v[0] : v })}
              min={0.3}
              max={1.0}
              step={0.01}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">
              Vertical Offset: {(config.linearYOffset * 100).toFixed(0)}%
            </Label>
            <Slider
              value={[config.linearYOffset]}
              onValueChange={(v) => updateConfig({ linearYOffset: Array.isArray(v) ? v[0] : v })}
              min={-0.4}
              max={0.4}
              step={0.01}
            />
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Bar/Dot Color</Label>
            <div className="flex items-center gap-2">
              <input
                type="color"
                value={config.linearBarColor}
                onChange={(e) => updateConfig({ linearBarColor: e.target.value })}
                className="h-8 w-12 rounded border border-border/50 bg-transparent"
              />
              <Input
                value={config.linearBarColor}
                onChange={(e) => updateConfig({ linearBarColor: e.target.value })}
                className="h-8 text-xs"
              />
            </div>
          </div>
          <div className="space-y-2">
            <Label className="text-xs">Center Text (splits visualizer)</Label>
            <Select
              value={config.linearCenterTextSource}
              onValueChange={(v) =>
                updateConfig({
                  linearCenterTextSource: v as ProjectConfig["linearCenterTextSource"],
                })
              }
            >
              <SelectTrigger className="h-8 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">None</SelectItem>
                <SelectItem value="artist">Artist Name</SelectItem>
                <SelectItem value="track">Track Name</SelectItem>
                <SelectItem value="custom">Custom text</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {config.linearCenterTextSource === "custom" && (
            <div className="space-y-2">
              <Input
                value={config.linearCenterText}
                onChange={(e) => updateConfig({ linearCenterText: e.target.value })}
                placeholder="e.g. CHILLRAP"
                className="h-8 text-xs"
              />
            </div>
          )}
          {config.linearCenterTextSource !== "none" && (
            <>
              <div className="space-y-2">
                <Label className="text-xs">
                  Center Text Size: {config.linearCenterTextSize}
                </Label>
                <Slider
                  value={[config.linearCenterTextSize]}
                  onValueChange={(v) => updateConfig({ linearCenterTextSize: Array.isArray(v) ? v[0] : v })}
                  min={40}
                  max={320}
                  step={4}
                />
              </div>
              <div className="space-y-2">
                <Label className="text-xs">
                  Center Text Vertical: {Math.round((config.linearCenterTextOffsetY ?? 0) * 100)}%
                </Label>
                <Slider
                  value={[(config.linearCenterTextOffsetY ?? 0) * 100]}
                  onValueChange={(v) => updateConfig({ linearCenterTextOffsetY: (Array.isArray(v) ? v[0] : v) / 100 })}
                  min={-50}
                  max={50}
                  step={1}
                />
              </div>
            </>
          )}
        </div>
      )}

      {/* Particles */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Label>Particles</Label>
          <Switch
            checked={config.particles}
            onCheckedChange={(v) => updateConfig({ particles: v })}
          />
        </div>
        {config.particles && (
          <>
            <div className="space-y-2">
              <Label className="text-xs">Style</Label>
              <div className="grid grid-cols-3 gap-1.5">
                {(
                  [
                    { id: "floating", label: "Floating", icon: "~" },
                    { id: "snow", label: "Snow", icon: "*" },
                    { id: "fireflies", label: "Fireflies", icon: "o" },
                    { id: "rain", label: "Rain", icon: "|" },
                    { id: "stars", label: "Stars", icon: "+" },
                    { id: "smoke", label: "Smoke", icon: "%" },
                  ] as const
                ).map((s) => (
                  <button
                    key={s.id}
                    onClick={() => updateConfig({ particleStyle: s.id })}
                    className={`flex flex-col items-center gap-0.5 rounded-md border p-2 text-[10px] transition-colors ${
                      config.particleStyle === s.id
                        ? "border-primary bg-primary/10 text-primary"
                        : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                    }`}
                  >
                    <span className="text-base font-mono">{s.icon}</span>
                    <span>{s.label}</span>
                  </button>
                ))}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="text-xs">
                Density: {config.particleDensity}
              </Label>
              <Slider
                value={[config.particleDensity]}
                onValueChange={(v) => updateConfig({ particleDensity: Array.isArray(v) ? v[0] : v })}
                min={10}
                max={200}
                step={5}
              />
            </div>
            <div className="space-y-2">
              <Label className="text-xs">Particle Color</Label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={config.particleColor}
                  onChange={(e) =>
                    updateConfig({ particleColor: e.target.value })
                  }
                  className="h-8 w-8 cursor-pointer rounded border border-border/50 bg-transparent"
                />
                <Input
                  value={config.particleColor}
                  onChange={(e) =>
                    updateConfig({ particleColor: e.target.value })
                  }
                  className="font-mono text-xs"
                />
              </div>
            </div>
          </>
        )}
      </div>

      {/* Backdrop effects */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Backdrop
        </h4>

        <div className="space-y-2">
          <Label className="text-xs">Reflection</Label>
          <Select
            value={config.reflection}
            onValueChange={(v) =>
              v && updateConfig({
                reflection: v as "none" | "2-way" | "4-way",
              })
            }
          >
            <SelectTrigger className="h-8">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="2-way">2-Way</SelectItem>
              <SelectItem value="4-way">4-Way</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="flex items-center justify-between">
          <Label className="text-xs">Filter</Label>
          <Switch
            checked={config.backgroundFilter}
            onCheckedChange={(v) => updateConfig({ backgroundFilter: v })}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">Drift</Label>
          <Switch
            checked={config.backgroundDrift}
            onCheckedChange={(v) => updateConfig({ backgroundDrift: v })}
          />
        </div>
        <div className="flex items-center justify-between">
          <Label className="text-xs">Rumble</Label>
          <Switch
            checked={config.backgroundRumble}
            onCheckedChange={(v) => updateConfig({ backgroundRumble: v })}
          />
        </div>
      </div>

      {/* Beat effects */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Beat Effects
        </h4>
        <div className="flex items-center justify-between">
          <Label className="text-xs">Screen Shake</Label>
          <Switch
            checked={config.beatShake}
            onCheckedChange={(v) => updateConfig({ beatShake: v })}
          />
        </div>
        {config.beatShake && (
          <div className="space-y-2">
            <Label className="text-xs">
              Shake Intensity: {config.beatShakeIntensity.toFixed(1)}
            </Label>
            <Slider
              value={[config.beatShakeIntensity]}
              onValueChange={(v) => updateConfig({ beatShakeIntensity: Array.isArray(v) ? v[0] : v })}
              min={0.1}
              max={1.5}
              step={0.1}
            />
          </div>
        )}
        <div className="flex items-center justify-between">
          <Label className="text-xs">Beat Zoom</Label>
          <Switch
            checked={config.beatZoom}
            onCheckedChange={(v) => updateConfig({ beatZoom: v })}
          />
        </div>
        {config.beatZoom && (
          <div className="space-y-2">
            <Label className="text-xs">
              Zoom Intensity: {config.beatZoomIntensity.toFixed(1)}
            </Label>
            <Slider
              value={[config.beatZoomIntensity]}
              onValueChange={(v) => updateConfig({ beatZoomIntensity: Array.isArray(v) ? v[0] : v })}
              min={0.1}
              max={1.5}
              step={0.1}
            />
          </div>
        )}
      </div>

      {/* Visualizer tuning */}
      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Visualizer
        </h4>
        <div className="space-y-2">
          <Label className="text-xs">Spectrum Fill</Label>
          <div className="grid grid-cols-2 gap-1.5">
            {([
              { id: "filled", label: "Filled" },
              { id: "outline", label: "Outline" },
            ] as const).map((s) => (
              <button
                key={s.id}
                onClick={() => updateConfig({ spectrumFill: s.id })}
                className={`rounded-md border px-3 py-1.5 text-xs transition-colors ${
                  config.spectrumFill === s.id
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/50 text-muted-foreground hover:border-border hover:text-foreground"
                }`}
              >
                {s.label}
              </button>
            ))}
          </div>
        </div>
        <div className="space-y-2">
          <Label className="text-xs">
            Reactivity: {config.reactivity.toFixed(1)}
          </Label>
          <Slider
            value={[config.reactivity]}
            onValueChange={(v) => updateConfig({ reactivity: Array.isArray(v) ? v[0] : v })}
            min={0.1}
            max={3}
            step={0.1}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">
            Smoothing: {config.waveformSmoothing.toFixed(1)}
          </Label>
          <Slider
            value={[config.waveformSmoothing]}
            onValueChange={(v) => updateConfig({ waveformSmoothing: Array.isArray(v) ? v[0] : v })}
            min={0}
            max={1}
            step={0.05}
          />
        </div>
        <div className="space-y-2">
          <Label className="text-xs">
            Scale: {config.waveformScale.toFixed(1)}
          </Label>
          <Slider
            value={[config.waveformScale]}
            onValueChange={(v) => updateConfig({ waveformScale: Array.isArray(v) ? v[0] : v })}
            min={0.3}
            max={2}
            step={0.1}
          />
        </div>
      </div>
    </div>
  );
}
