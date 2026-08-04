

import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

function ColorPicker({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-2">
      <Label className="text-xs">{label}</Label>
      <div className="flex items-center gap-2">
        <input
          type="color"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="h-8 w-8 cursor-pointer rounded border border-border/50 bg-transparent"
        />
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="font-mono text-xs"
        />
      </div>
    </div>
  );
}

export function ColorsPanel() {
  const config = useVisualizerEditorStore((s) => s.config);
  const updateConfig = useVisualizerEditorStore((s) => s.updateConfig);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Colors</h3>

      <ColorPicker
        label="Wave Color 1"
        value={config.waveColor1}
        onChange={(v) => updateConfig({ waveColor1: v })}
      />
      <ColorPicker
        label="Wave Color 2"
        value={config.waveColor2}
        onChange={(v) => updateConfig({ waveColor2: v })}
      />
      <ColorPicker
        label="Background Color"
        value={config.backgroundColor}
        onChange={(v) => updateConfig({ backgroundColor: v })}
      />
      <ColorPicker
        label="Accent Color"
        value={config.accentColor}
        onChange={(v) => updateConfig({ accentColor: v })}
      />
    </div>
  );
}
