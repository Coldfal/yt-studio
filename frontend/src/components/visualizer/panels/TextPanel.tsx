

import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { Button } from "@/components/ui/button";
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
import { Plus, Trash2, Move } from "lucide-react";
import type { CustomText } from "@/types/visualizer";

export function TextPanel() {
  const config = useVisualizerEditorStore((s) => s.config);
  const updateConfig = useVisualizerEditorStore((s) => s.updateConfig);

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold">Text</h3>

      <div className="space-y-2">
        <Label htmlFor="artistName">Artist Name</Label>
        <Input
          id="artistName"
          value={config.artistName}
          onChange={(e) => updateConfig({ artistName: e.target.value })}
          placeholder="Artist Name"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="trackName">Track Name</Label>
        <Input
          id="trackName"
          value={config.trackName}
          onChange={(e) => updateConfig({ trackName: e.target.value })}
          placeholder="Track Name"
        />
      </div>

      <div className="space-y-2">
        <Label>Text Position</Label>
        <Select
          value={config.textPosition}
          onValueChange={(v) =>
            v && updateConfig({ textPosition: v as "top" | "bottom" | "center" })
          }
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="top">Top</SelectItem>
            <SelectItem value="center">Center</SelectItem>
            <SelectItem value="bottom">Bottom</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {/* Font family applies to artist/track text AND every custom text
          overlay below. Engine + PreviewCanvas both pull from
          ``config.fontFamily`` — falling back to ``sans-serif`` when
          the named font isn't installed. Trajan Pro 3 needs to be
          installed locally (Adobe Fonts / system) for the engine
          sidecar to render it; otherwise it falls back. */}
      <div className="space-y-2">
        <Label>Font Family</Label>
        <Select
          value={config.fontFamily || "Geist"}
          onValueChange={(v) => v && updateConfig({ fontFamily: v })}
        >
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="Geist">Geist (default)</SelectItem>
            <SelectItem value="Trajan Pro 3">Trajan Pro 3</SelectItem>
            <SelectItem value="Inter">Inter</SelectItem>
            <SelectItem value="Helvetica">Helvetica</SelectItem>
            <SelectItem value="Georgia">Georgia (serif)</SelectItem>
            <SelectItem value="Courier New">Courier New (mono)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label className="text-xs">Font Size: {config.fontSize}px</Label>
        <Slider
          value={[config.fontSize]}
          onValueChange={(v) => updateConfig({ fontSize: Array.isArray(v) ? v[0] : v })}
          min={12}
          max={72}
          step={1}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="textColor">Text Color</Label>
        <div className="flex items-center gap-2">
          <input
            type="color"
            id="textColor"
            value={config.textColor}
            onChange={(e) => updateConfig({ textColor: e.target.value })}
            className="h-8 w-8 cursor-pointer rounded border border-border/50 bg-transparent"
          />
          <Input
            value={config.textColor}
            onChange={(e) => updateConfig({ textColor: e.target.value })}
            className="font-mono text-xs"
          />
        </div>
      </div>

      {/* Custom draggable text overlays */}
      <div className="space-y-3 border-t border-border/40 pt-4">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Text Overlays
            </h4>
            <p className="text-[10px] text-muted-foreground/80">
              Drag directly on the preview to reposition
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-[11px]"
            onClick={() => {
              const id = crypto.randomUUID();
              const existing = config.customTexts.length;
              const next: CustomText = {
                id,
                text: "New Text",
                x: 0.2 + (existing % 3) * 0.3,
                y: 0.15 + Math.floor(existing / 3) * 0.15,
                size: 48,
                color: "#ffffff",
                weight: "bold",
                align: "left",
              };
              updateConfig({ customTexts: [...config.customTexts, next] });
            }}
          >
            <Plus className="mr-1 h-3 w-3" />
            Add Text
          </Button>
        </div>

        {config.customTexts.length === 0 && (
          <p className="text-[11px] text-muted-foreground">
            No overlays yet. Click "Add Text" to place one.
          </p>
        )}

        {config.customTexts.map((txt, idx) => (
          <div
            key={txt.id}
            className="space-y-2 rounded-md border border-border/40 bg-muted/20 p-2"
          >
            <div className="flex items-center gap-1.5">
              <Move className="h-3 w-3 text-muted-foreground" />
              <Input
                value={txt.text}
                onChange={(e) => {
                  const updated = config.customTexts.map((t, i) =>
                    i === idx ? { ...t, text: e.target.value } : t,
                  );
                  updateConfig({ customTexts: updated });
                }}
                className="h-7 text-xs"
                placeholder="Text content"
              />
              <button
                onClick={() => {
                  updateConfig({
                    customTexts: config.customTexts.filter((_, i) => i !== idx),
                  });
                }}
                className="rounded p-1 text-muted-foreground hover:bg-destructive/20 hover:text-destructive"
                aria-label="Delete text"
              >
                <Trash2 className="h-3 w-3" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px]">Size: {txt.size}</Label>
                <Slider
                  value={[txt.size]}
                  onValueChange={(v) => {
                    const size = Array.isArray(v) ? v[0] : v;
                    const updated = config.customTexts.map((t, i) =>
                      i === idx ? { ...t, size } : t,
                    );
                    updateConfig({ customTexts: updated });
                  }}
                  min={16}
                  max={200}
                  step={2}
                />
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Color</Label>
                <div className="flex items-center gap-1">
                  <input
                    type="color"
                    value={txt.color}
                    onChange={(e) => {
                      const updated = config.customTexts.map((t, i) =>
                        i === idx ? { ...t, color: e.target.value } : t,
                      );
                      updateConfig({ customTexts: updated });
                    }}
                    className="h-7 w-8 rounded border border-border/50 bg-transparent"
                  />
                  <Input
                    value={txt.color}
                    onChange={(e) => {
                      const updated = config.customTexts.map((t, i) =>
                        i === idx ? { ...t, color: e.target.value } : t,
                      );
                      updateConfig({ customTexts: updated });
                    }}
                    className="h-7 font-mono text-[10px]"
                  />
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-[10px]">Weight</Label>
                <Select
                  value={txt.weight}
                  onValueChange={(v) => {
                    const updated = config.customTexts.map((t, i) =>
                      i === idx ? { ...t, weight: v as CustomText["weight"] } : t,
                    );
                    updateConfig({ customTexts: updated });
                  }}
                >
                  <SelectTrigger className="h-7 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="normal">Normal</SelectItem>
                    <SelectItem value="bold">Bold</SelectItem>
                    <SelectItem value="black">Black</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1">
                <Label className="text-[10px]">Align</Label>
                <Select
                  value={txt.align}
                  onValueChange={(v) => {
                    const updated = config.customTexts.map((t, i) =>
                      i === idx ? { ...t, align: v as CustomText["align"] } : t,
                    );
                    updateConfig({ customTexts: updated });
                  }}
                >
                  <SelectTrigger className="h-7 text-[11px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="left">Left</SelectItem>
                    <SelectItem value="center">Center</SelectItem>
                    <SelectItem value="right">Right</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
