import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { cn } from "@/lib/utils";
import {
  AudioWaveform,
  Image,
  Type,
  Palette,
  Sparkles,
  Download,
} from "lucide-react";
import { AudioPanel } from "./panels/AudioPanel";
import { ImagesPanel } from "./panels/ImagesPanel";
import { TextPanel } from "./panels/TextPanel";
import { ColorsPanel } from "./panels/ColorsPanel";
import { ElementsPanel } from "./panels/ElementsPanel";
import { ExportPanel } from "./panels/ExportPanel";

// Preset picker is intentionally hidden — we only ship the Linear Dots
// visualizer style. Other presets still exist in preset-renderers.ts for
// legacy projects but the user never needs to choose between them.
const panels = [
  { id: "audio", label: "Audio", icon: AudioWaveform },
  { id: "images", label: "Images", icon: Image },
  { id: "text", label: "Text", icon: Type },
  { id: "colors", label: "Colors", icon: Palette },
  { id: "elements", label: "Elements", icon: Sparkles },
  { id: "export", label: "Export", icon: Download },
] as const;

const panelComponents: Record<string, React.ComponentType> = {
  audio: AudioPanel,
  images: ImagesPanel,
  text: TextPanel,
  colors: ColorsPanel,
  elements: ElementsPanel,
  export: ExportPanel,
};

export function VisualizerSidebar() {
  const activePanel = useVisualizerEditorStore((s) => s.activePanel);
  const setActivePanel = useVisualizerEditorStore((s) => s.setActivePanel);
  // Default to the audio panel when an old saved state pointed at "preset"
  const effectiveActive =
    activePanel === "preset" ? "audio" : activePanel;
  const ActivePanelComponent = panelComponents[effectiveActive];

  return (
    <div className="flex h-full">
      {/* Icon tabs */}
      <div className="flex w-16 flex-col items-center gap-1 border-r border-border/50 bg-card/30 py-2">
        {panels.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActivePanel(id)}
            className={cn(
              "flex w-14 flex-col items-center gap-0.5 rounded-md p-2 text-xs transition-colors",
              activePanel === id
                ? "bg-primary/10 text-primary"
                : "text-muted-foreground hover:bg-muted hover:text-foreground"
            )}
          >
            <Icon className="h-5 w-5" />
            <span className="text-[10px]">{label}</span>
          </button>
        ))}
      </div>

      {/* Panel content */}
      <div className="w-72 overflow-y-auto border-r border-border/50 bg-card/20 p-4">
        {ActivePanelComponent && <ActivePanelComponent />}
      </div>
    </div>
  );
}
