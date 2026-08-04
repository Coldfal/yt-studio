/**
 * Phase 7 — Thumbnail template editor.
 *
 * Lets the operator define the template (wordmark + stamp + corner-tag
 * pools + color pool) once per channel. Quick Generate's preview drawer
 * then renders fresh JPEGs per video using this template.
 *
 * Layout: form on the left (essentials only), three side-by-side live
 * preview tiles on the right showing rotated variants so the operator
 * sees what the color/text rotation looks like before saving.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Loader2, RotateCw, Save, Sparkles, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  DEFAULT_TEMPLATE,
  renderThumbnailTemplate,
  type ThumbnailTemplate,
} from "./renderTemplate";
import { PRESET_OPTIONS } from "./effects";
import api from "@/lib/api";

interface Props {
  /** Preset id whose ``thumbnail_template`` we read/write. */
  presetId: number | null;
  /** Initial template — null/undefined means "not configured yet". */
  value: ThumbnailTemplate | null | undefined;
  /** A real channel asset URL to use as the preview background. The
   *  current Quick Generate preview image is a great pick. */
  sampleBgUrl: string | null;
  /** Called after a successful PUT — parent invalidates queries etc. */
  onSaved?: (next: ThumbnailTemplate) => void;
}

export function ThumbnailTemplateEditor({
  presetId,
  value,
  sampleBgUrl,
  onSaved,
}: Props) {
  const [tpl, setTpl] = useState<ThumbnailTemplate>(value ?? DEFAULT_TEMPLATE);
  const [saving, setSaving] = useState(false);
  const [previewSeed, setPreviewSeed] = useState<number>(() =>
    Math.floor(Math.random() * 1_000_000),
  );
  useEffect(() => {
    if (value) setTpl(value);
  }, [value]);

  // Convenience accessors — we only edit a handful of fields in the
  // simple editor. Full layer editing happens later via JSON.
  const wordmark = tpl.layers.find((l) => l.kind === "wordmark");
  const stamp = tpl.layers.find((l) => l.kind === "stamp");
  const tagTL = tpl.layers.find((l) => l.kind === "tag_top_left");
  const tagTR = tpl.layers.find((l) => l.kind === "tag_top_right");

  const patchLayer = (kind: string, patch: Record<string, unknown>) => {
    setTpl((cur) => ({
      ...cur,
      layers: cur.layers.map((l) =>
        l.kind === kind ? { ...l, ...patch } : l,
      ),
    }));
  };

  const handleSave = async () => {
    if (!presetId) {
      toast.error("Save the preset first");
      return;
    }
    setSaving(true);
    try {
      await api.put(`/automation/presets/${presetId}`, {
        thumbnail_template: tpl,
      });
      toast.success("Thumbnail template saved");
      onSaved?.(tpl);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleClear = async () => {
    if (!presetId) return;
    if (!window.confirm("Clear the template? Quick Generate will fall back to the sticky thumbnail.")) {
      return;
    }
    setSaving(true);
    try {
      await api.put(`/automation/presets/${presetId}`, {
        thumbnail_template: null,
      });
      toast.success("Template cleared");
      onSaved?.(DEFAULT_TEMPLATE);
    } catch {
      toast.error("Clear failed");
    } finally {
      setSaving(false);
    }
  };

  // Three side-by-side preview seeds — varied so the operator sees a
  // representative spread of color/text picks before saving.
  const previewSeeds = useMemo(
    () => [previewSeed, previewSeed + 31, previewSeed + 97],
    [previewSeed],
  );

  return (
    <div className="space-y-3 rounded-md border border-border/40 bg-muted/10 p-3">
      <div className="flex items-center justify-between gap-2">
        <Label className="flex items-center gap-1.5 text-xs font-medium">
          <Sparkles className="size-3 text-primary" /> Thumbnail template
        </Label>
        <div className="flex gap-1">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => setPreviewSeed(Math.floor(Math.random() * 1_000_000))}
            title="Reshuffle preview"
          >
            <RotateCw className="size-3" />
            Shuffle
          </Button>
          {value && (
            <Button size="xs" variant="ghost" onClick={handleClear} disabled={saving}>
              <Trash2 className="size-3" />
              Clear
            </Button>
          )}
          <Button size="xs" onClick={handleSave} disabled={saving || !presetId}>
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
            Save
          </Button>
        </div>
      </div>
      <p className="text-[10px] text-muted-foreground">
        Every Quick Generate render builds a fresh thumbnail from this template
        (wordmark + bottom stamp + 2 corner tags), rotating colour + tag text
        per video. Empty = falls back to the sticky thumbnail asset.
      </p>

      <Separator />

      <div className="grid gap-3 lg:grid-cols-[1fr_1.3fr]">
        {/* LEFT — minimal form */}
        <div className="space-y-2.5 text-xs">
          {/* Wordmark */}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Wordmark (large top text)
            </Label>
            <Input
              value={wordmark?.text ?? ""}
              onChange={(e) => patchLayer("wordmark", { text: e.target.value })}
              placeholder="TOKYO"
              className="h-7 font-mono"
            />
            <Label className="text-[10px] text-muted-foreground">Colour pool (one per chip)</Label>
            <Input
              value={(wordmark?.color_pool ?? []).join(", ")}
              onChange={(e) =>
                patchLayer("wordmark", {
                  color_pool: e.target.value
                    .split(/[,\s]+/)
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              placeholder="#ff3b3b, #ff7a18, #ffcc00"
              className="h-7 font-mono"
            />
            <Select
              value={wordmark?.effect_preset ?? "long_shadow"}
              onValueChange={(v) => patchLayer("wordmark", { effect_preset: v })}
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
          </div>

          {/* Stamp */}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Bottom stamp
            </Label>
            <Input
              value={stamp?.text ?? ""}
              onChange={(e) => patchLayer("stamp", { text: e.target.value })}
              placeholder="CHILL RAP"
              className="h-7 font-mono"
            />
            <Select
              value={stamp?.effect_preset ?? "embossed"}
              onValueChange={(v) => patchLayer("stamp", { effect_preset: v })}
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
          </div>

          {/* Corner tag pools */}
          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Top-left tag pool (one per line)
            </Label>
            <Textarea
              rows={3}
              value={(tagTL?.text_pool ?? []).join("\n")}
              onChange={(e) =>
                patchLayer("tag_top_left", {
                  text_pool: e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className="font-mono text-[10px]"
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
              Top-right tag pool (one per line)
            </Label>
            <Textarea
              rows={3}
              value={(tagTR?.text_pool ?? []).join("\n")}
              onChange={(e) =>
                patchLayer("tag_top_right", {
                  text_pool: e.target.value
                    .split("\n")
                    .map((s) => s.trim())
                    .filter(Boolean),
                })
              }
              className="font-mono text-[10px]"
            />
          </div>
        </div>

        {/* RIGHT — three rotated previews */}
        <div className="space-y-1.5">
          <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Rotated previews
          </Label>
          {sampleBgUrl ? (
            <div className="grid grid-cols-1 gap-2">
              {previewSeeds.map((s) => (
                <PreviewTile key={s} template={tpl} bgUrl={sampleBgUrl} seed={s} />
              ))}
            </div>
          ) : (
            <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-[10px] text-muted-foreground">
              Pick a background in Quick Generate first so the preview has
              an image to layer the template over.
            </div>
          )}
          {sampleBgUrl && (
            <p className="text-[10px] text-muted-foreground">
              Colour pool: {(wordmark?.color_pool ?? []).map((c, i) => (
                <Badge
                  key={i}
                  variant="outline"
                  className="ml-1 text-[9px] py-0"
                  style={{ borderColor: c, color: c }}
                >
                  {c}
                </Badge>
              ))}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function PreviewTile({
  template,
  bgUrl,
  seed,
}: {
  template: ThumbnailTemplate;
  bgUrl: string;
  seed: number;
}) {
  const [url, setUrl] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const lastBlobUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setErr(null);
    renderThumbnailTemplate({ template, bgUrl, seed })
      .then((blob) => {
        if (cancelled) return;
        const u = URL.createObjectURL(blob);
        setUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return u;
        });
        lastBlobUrlRef.current = u;
      })
      .catch((e) => {
        if (cancelled) return;
        setErr(String(e?.message ?? e));
      });
    return () => {
      cancelled = true;
    };
  }, [template, bgUrl, seed]);

  // Free the blob URL on unmount
  useEffect(() => {
    return () => {
      if (lastBlobUrlRef.current) URL.revokeObjectURL(lastBlobUrlRef.current);
    };
  }, []);

  return (
    <div
      className="overflow-hidden rounded-md border border-border/40 bg-black"
      style={{ aspectRatio: "16/9" }}
    >
      {err ? (
        <div className="flex h-full items-center justify-center p-2 text-[10px] text-destructive">
          {err}
        </div>
      ) : url ? (
        <img src={url} alt="preview" className="h-full w-full object-cover" />
      ) : (
        <div className="flex h-full items-center justify-center">
          <Loader2 className="size-4 animate-spin text-muted-foreground" />
        </div>
      )}
    </div>
  );
}
