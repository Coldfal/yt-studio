/**
 * Phase 7 — Thumbnail template auto-generator.
 *
 * Renders a per-video JPEG from a stored TEMPLATE (layers + value pools)
 * by picking deterministic entries from each pool based on a seed, then
 * driving the same Canvas pipeline ThumbnailCanvas already uses. The
 * result is a fresh JPEG with the same visual signature on every render,
 * only the background image / colour / corner-tag text rotating.
 *
 * Re-uses the pure ``drawTextLayer`` function from effects.ts — no new
 * effect code, no fork of the rendering pipeline. The React canvas
 * component stays as-is for the live editor; this helper renders
 * headlessly via an offscreen canvas for the Quick Generate preview
 * drawer.
 */
import {
  drawTextLayer,
  type EffectPreset,
  type TextLayer,
} from "./effects";

// ── Template shape (matches the DB column on AutomationPreset) ───────

export type BgSource =
  | "picked_background" // use the bg image Quick Generate already picked
  | "asset_set" // use the AssetSet's background
  | "channel_background"; // pick any role=background asset on the channel

export interface TemplateLayer {
  /** Operator-friendly slot label. Lets the editor render the right
   *  form fields per slot. The renderer doesn't actually branch on it —
   *  every layer goes through ``drawTextLayer`` regardless. */
  kind: "wordmark" | "stamp" | "tag_top_left" | "tag_top_right" | "tag_bottom_left" | "tag_bottom_right" | "free";
  /** Either a single literal text OR a pool to pick from. */
  text?: string;
  text_pool?: string[];
  /** Normalised 0..1 in canvas coordinates. */
  x: number;
  y: number;
  font: string;
  size: number;
  weight: "normal" | "bold";
  align: CanvasTextAlign;
  /** Either a single literal colour OR a pool to pick from, OR
   *  ``color_from`` to reuse the picked colour from another layer. */
  color?: string;
  color_pool?: string[];
  /** Reuses the picked colour from an earlier layer's pool by slot kind.
   *  Useful for a "stamp" that should match the wordmark. */
  color_from?: TemplateLayer["kind"];
  effect_preset: EffectPreset;
}

export interface ThumbnailTemplate {
  version: 1;
  bg_source: BgSource;
  layers: TemplateLayer[];
  /** Reserved — currently "per_video" only. Future "per_day" / "fixed"
   *  modes could land here. */
  rotation_seed?: "per_video";
}

// ── Output dimensions (matches ThumbnailCanvas default) ─────────────

const CANVAS_W = 1280;
const CANVAS_H = 720;
const JPEG_QUALITY = 0.92;

// ── Seeded picker (deterministic) ────────────────────────────────────

/** Hash a small integer/string seed into a 0..(pool-1) index. Stable
 *  across renders so a re-render of the same video picks the same
 *  values. */
function pickIndex(seed: number, poolLen: number): number {
  if (poolLen <= 0) return 0;
  // Mix the seed lightly so adjacent video ids don't collide on the
  // same modulo result (which would make consecutive videos look
  // identical). xorshift-ish.
  let x = (seed | 0) ^ 0x9e3779b9;
  x ^= x << 13;
  x ^= x >>> 17;
  x ^= x << 5;
  return Math.abs(x) % poolLen;
}

// ── Pool resolution ──────────────────────────────────────────────────

/** Resolve each layer's text + colour from pools / direct values /
 *  cross-layer references. Returns a flat list of concrete TextLayers
 *  ready for ``drawTextLayer``. */
function resolveLayers(
  template: ThumbnailTemplate,
  seed: number,
): TextLayer[] {
  // First pass: per-layer text + own colour pool resolution.
  const picked: { layer: TemplateLayer; text: string; color: string }[] = [];
  for (let i = 0; i < template.layers.length; i++) {
    const layer = template.layers[i];
    const textValue =
      layer.text !== undefined && layer.text !== null
        ? layer.text
        : layer.text_pool && layer.text_pool.length > 0
          ? layer.text_pool[pickIndex(seed + i, layer.text_pool.length)]
          : "";
    const ownColor =
      layer.color !== undefined && layer.color !== null
        ? layer.color
        : layer.color_pool && layer.color_pool.length > 0
          ? layer.color_pool[pickIndex(seed + i * 7, layer.color_pool.length)]
          : "#ffffff";
    picked.push({ layer, text: textValue, color: ownColor });
  }
  // Second pass: resolve ``color_from`` cross-references.
  return picked.map(({ layer, text, color }) => {
    let finalColor = color;
    if (layer.color_from) {
      const ref = picked.find((p) => p.layer.kind === layer.color_from);
      if (ref) finalColor = ref.color;
    }
    return {
      text,
      x: layer.x,
      y: layer.y,
      font: layer.font,
      size: layer.size,
      color: finalColor,
      weight: layer.weight,
      align: layer.align,
      effect_preset: layer.effect_preset,
    };
  });
}

// ── Image loading (handles cross-origin) ─────────────────────────────

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // Same-origin local server, so crossOrigin is a no-op but doesn't
    // hurt. If a future CDN serves assets, set this to "anonymous".
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(new Error(`Failed to load image: ${url}: ${String(e)}`));
    img.src = url;
  });
}

// ── Background rendering (cover-fit, same as ThumbnailCanvas) ────────

function drawBackgroundCover(
  ctx: CanvasRenderingContext2D,
  img: HTMLImageElement,
): void {
  // Cover-fit: scale so the image fills the canvas, cropping overflow.
  const scale = Math.max(CANVAS_W / img.width, CANVAS_H / img.height);
  const sw = img.width * scale;
  const sh = img.height * scale;
  const sx = (CANVAS_W - sw) / 2;
  const sy = (CANVAS_H - sh) / 2;
  ctx.drawImage(img, sx, sy, sw, sh);
}

// ── Public render entrypoint ────────────────────────────────────────

export interface RenderTemplateOpts {
  template: ThumbnailTemplate;
  /** URL the renderer fetches as the background. The Quick Generate
   *  preview drawer passes the picked bg's ``file_url``. */
  bgUrl: string;
  /** Stable integer per video — typically VideoProject.id or
   *  picked-image asset id during preview. Drives pool index picks. */
  seed: number;
}

/**
 * Render a thumbnail JPEG headlessly. Returns a Blob ready to upload
 * via the existing /projects/{id}/thumbnail or
 * /automation/presets/{id}/thumbnail endpoint.
 */
export async function renderThumbnailTemplate({
  template,
  bgUrl,
  seed,
}: RenderTemplateOpts): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not acquire 2D context");

  // Background
  try {
    const img = await loadImage(bgUrl);
    drawBackgroundCover(ctx, img);
  } catch (err) {
    // Fail soft: paint a dark gradient if the bg fails to load. The
    // template's text layers will still render on top so the operator
    // sees SOMETHING and can debug.
    const grad = ctx.createLinearGradient(0, 0, 0, CANVAS_H);
    grad.addColorStop(0, "#1a1a2e");
    grad.addColorStop(1, "#0f0f14");
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);
    console.warn("[renderTemplate] background load failed:", err);
  }

  // Resolve pools + draw each layer
  const layers = resolveLayers(template, seed);
  for (const layer of layers) {
    drawTextLayer(ctx, layer, {
      px: layer.x * CANVAS_W,
      py: layer.y * CANVAS_H,
      canvasW: CANVAS_W,
      canvasH: CANVAS_H,
      bgCanvas: null,
    });
  }

  // Export to JPEG blob
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (b) => {
        if (b) resolve(b);
        else reject(new Error("canvas.toBlob returned null"));
      },
      "image/jpeg",
      JPEG_QUALITY,
    );
  });
}

// ── Helper: a sensible default template for new channels ────────────

/** The "TOKYO + CHILL RAP + 2 corner tags" template seeded with
 *  ChillGirlVibes-style defaults. The operator edits from here. */
export const DEFAULT_TEMPLATE: ThumbnailTemplate = {
  version: 1,
  bg_source: "picked_background",
  layers: [
    {
      kind: "wordmark",
      text: "TOKYO",
      x: 0.5,
      y: 0.18,
      font: "Anton",
      size: 240,
      weight: "bold",
      align: "center",
      color_pool: [
        "#ff3b3b",
        "#ff7a18",
        "#ffcc00",
        "#22c55e",
        "#22d3ee",
        "#e879f9",
      ],
      effect_preset: "long_shadow",
    },
    {
      kind: "stamp",
      text: "CHILL RAP",
      x: 0.5,
      y: 0.9,
      font: "Anton",
      size: 80,
      weight: "bold",
      align: "center",
      color_from: "wordmark",
      effect_preset: "embossed",
    },
    {
      kind: "tag_top_left",
      text_pool: [
        "SLOW JAZZY RAP",
        "JAPAN HIPHOP",
        "TOKYO GIRL",
        "DIDN'T WANNA HANG UP",
        "RAINY SHIBUYA",
      ],
      x: 0.04,
      y: 0.05,
      font: "Inter",
      size: 28,
      weight: "bold",
      align: "left",
      color: "#ffffff",
      effect_preset: "none",
    },
    {
      kind: "tag_top_right",
      text_pool: [
        "JAZZY BEAT",
        "JAPANESE SONGS",
        "WORK & FOCUS",
        "LATE NIGHT MIX",
      ],
      x: 0.96,
      y: 0.05,
      font: "Inter",
      size: 28,
      weight: "bold",
      align: "right",
      color: "#ffffff",
      effect_preset: "none",
    },
  ],
  rotation_seed: "per_video",
};
