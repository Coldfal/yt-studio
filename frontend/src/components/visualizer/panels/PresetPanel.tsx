import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { cn } from "@/lib/utils";

interface PresetEntry {
  id: string;
  name: string;
  category: string;
}

// Only the visualizer style we want users to see and pick. Other presets
// (trap-nation, radial-waveform, etc.) are still supported by the renderer
// for legacy projects but hidden from the picker — see ALL_PRESETS below if
// you need to expose them again later.
const VISIBLE_PRESETS: PresetEntry[] = [
  { id: "linear-dots", name: "Linear Dots", category: "waveform" },
];

// Kept for reference; do not delete. To re-enable any preset, copy its entry
// into VISIBLE_PRESETS above.
// const ALL_PRESETS: PresetEntry[] = [
//   { id: "trap-nation", name: "Trap Nation", category: "waveform" },
//   { id: "radial-waveform", name: "Radial Waveform", category: "waveform" },
//   { id: "linear-bars", name: "Linear Bars", category: "waveform" },
//   { id: "linear-dots", name: "Linear Dots", category: "waveform" },
//   { id: "particle-storm", name: "Particle Storm", category: "particles" },
//   { id: "neon-ring", name: "Neon Ring", category: "waveform" },
//   { id: "minimal-wave", name: "Minimal Wave", category: "minimal" },
//   { id: "skyline", name: "Skyline", category: "waveform" },
//   { id: "sphere-3d", name: "3D Sphere", category: "3d" },
//   { id: "crossing-bolts", name: "Crossing Bolts", category: "particles" },
//   { id: "glitter-storm", name: "Glitter Storm", category: "particles" },
//   { id: "forest-lights", name: "Forest Lights", category: "particles" },
//   { id: "magma-flow", name: "Magma Flow", category: "retro" },
//   { id: "neon-tunnel", name: "Neon Tunnel", category: "3d" },
// ];

export function PresetPanel() {
  const presetId = useVisualizerEditorStore((s) => s.presetId);
  const setPresetId = useVisualizerEditorStore((s) => s.setPresetId);

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold">Visualizer Style</h3>
      <p className="text-xs text-muted-foreground">
        Audio-reactive dots running across the canvas. The width, color, and
        position are configurable in the panels below.
      </p>

      <div className="space-y-2">
        <div className="grid grid-cols-1 gap-2">
          {VISIBLE_PRESETS.map((preset) => (
            <button
              key={preset.id}
              onClick={() => setPresetId(preset.id)}
              className={cn(
                "relative flex items-center gap-3 rounded-lg border p-3 text-left transition-all",
                presetId === preset.id
                  ? "border-primary bg-primary/10"
                  : "border-border/30 hover:border-border/60 hover:bg-muted/50"
              )}
            >
              <div className="flex h-12 w-16 shrink-0 items-center justify-center rounded bg-gradient-to-br from-primary/20 to-accent/20 font-mono text-sm">
                ⠂⠂⠂⠂
              </div>
              <span className="text-sm font-medium">{preset.name}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
