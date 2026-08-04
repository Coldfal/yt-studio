/**
 * Cinematic text-effect presets for the thumbnail editor.
 *
 * Each preset is a single function `(ctx, layer, opts) => void` that
 * draws the layer's text at its current `(x, y)` position. They all
 * leave the canvas in a clean state afterwards (shadow off, fillStyle
 * neutral) so the next layer's draw doesn't inherit anything.
 *
 * Why named presets instead of raw effect knobs: the user explicitly
 * rejected Word-Art-style "rich text" controls — they want polished,
 * cinematic looks that work out of the box. Each preset is a curated
 * combination of standard Canvas 2D primitives (shadowBlur, gradients,
 * stacked fillText) with tuned constants. Add a new preset, never
 * expose a "glow radius" slider in the UI.
 *
 * All coordinates are in canvas-space pixels (1280×720 logical). The
 * caller in ThumbnailCanvas is responsible for translating normalized
 * (0..1) layer positions into pixel coordinates before invoking.
 */

export type EffectPreset =
  | "none"
  | "bloom"
  | "embossed"
  | "long_shadow"
  | "chromatic"
  | "gradient"
  | "glass";

export interface TextLayer {
  text: string;
  /** Normalized 0..1 in canvas coordinates. */
  x: number;
  y: number;
  font: string;
  size: number;
  color: string;
  weight: "normal" | "bold";
  align: CanvasTextAlign;
  effect_preset: EffectPreset;
}

export interface DrawOpts {
  /** Pixel position derived from normalized x/y. */
  px: number;
  py: number;
  /** The full canvas width / height in pixels (1280×720 by default). */
  canvasW: number;
  canvasH: number;
  /** Background canvas used by the Glass preset to sample blur underneath. */
  bgCanvas?: HTMLCanvasElement | null;
}

/**
 * The ordered list of presets the UI dropdown shows. "none" first so the
 * default render path is the cheapest one.
 */
export const PRESET_OPTIONS: { value: EffectPreset; label: string; description: string }[] = [
  { value: "none", label: "None", description: "Plain fill, no effect." },
  { value: "bloom", label: "Bloom", description: "Soft warm halo — Apple/Marvel title feel." },
  { value: "embossed", label: "Embossed", description: "Dark + light dual stroke for a fantasy-poster metal feel." },
  { value: "long_shadow", label: "Long Shadow", description: "Extruded 45° depth for modern flat-design posters." },
  { value: "chromatic", label: "Chromatic", description: "Subtle cyan/red split for cinematic title aberration." },
  { value: "gradient", label: "Gradient Fill", description: "Vertical gradient fill — gold→bronze editorial look." },
  { value: "glass", label: "Glass", description: "Frosted-glass backdrop panel behind crisp text." },
];

/** Configure ctx.font from a layer, including weight. Reuses the canvas font shorthand. */
function applyFont(ctx: CanvasRenderingContext2D, layer: TextLayer): void {
  // Quote the family in case it has spaces (e.g. "Playfair Display").
  ctx.font = `${layer.weight} ${layer.size}px "${layer.font}", sans-serif`;
  ctx.textAlign = layer.align;
  ctx.textBaseline = "middle";
}

function resetShadow(ctx: CanvasRenderingContext2D): void {
  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

// ─── Preset: None ─────────────────────────────────────────────────────
function drawNone(ctx: CanvasRenderingContext2D, layer: TextLayer, o: DrawOpts): void {
  applyFont(ctx, layer);
  ctx.fillStyle = layer.color;
  ctx.fillText(layer.text, o.px, o.py);
}

// ─── Preset: Bloom ────────────────────────────────────────────────────
// Three shadowBlur passes at decreasing radius/alpha so the halo is soft
// near the text and falls off gradually. Final pass with no shadow keeps
// the text glyphs crisp.
function drawBloom(ctx: CanvasRenderingContext2D, layer: TextLayer, o: DrawOpts): void {
  applyFont(ctx, layer);
  // Halo color: a warm-tinted version of the text color works well for
  // most palettes. We default to the text color itself; if user wants a
  // different glow tint that's a per-preset knob we add later.
  const halo = layer.color;
  ctx.save();
  for (const [blur, alpha] of [[48, 0.35], [24, 0.45], [10, 0.6]]) {
    ctx.shadowColor = halo;
    ctx.shadowBlur = blur;
    ctx.fillStyle = halo;
    ctx.globalAlpha = alpha;
    ctx.fillText(layer.text, o.px, o.py);
  }
  ctx.restore();
  // Crisp final pass on top of the halo
  resetShadow(ctx);
  ctx.fillStyle = layer.color;
  ctx.fillText(layer.text, o.px, o.py);
}

// ─── Preset: Embossed ─────────────────────────────────────────────────
// Thick dark outline + thin lighter inner stroke + solid fill = metal feel.
// Used in fantasy-poster typography (LOTR, GoT). Looks particularly good
// with Cinzel.
function drawEmbossed(ctx: CanvasRenderingContext2D, layer: TextLayer, o: DrawOpts): void {
  applyFont(ctx, layer);
  // Scale stroke widths with font size so the look is consistent across
  // 40px and 200px layers.
  const outerW = Math.max(4, layer.size * 0.08);
  const innerW = Math.max(1, layer.size * 0.018);

  // Outer dark stroke
  ctx.lineJoin = "round";
  ctx.strokeStyle = "#1a1208";
  ctx.lineWidth = outerW;
  ctx.strokeText(layer.text, o.px, o.py);

  // Thin inner stroke for highlight edge
  ctx.strokeStyle = "rgba(255, 240, 200, 0.9)";
  ctx.lineWidth = innerW;
  ctx.strokeText(layer.text, o.px, o.py);

  // Solid fill on top
  ctx.fillStyle = layer.color;
  ctx.fillText(layer.text, o.px, o.py);
}

// ─── Preset: Long Shadow ──────────────────────────────────────────────
// Extruded stack of N copies at 45° offset, each darker than the last,
// no blur — flat-design poster aesthetic. Strict order: shadows behind,
// crisp text on top.
function drawLongShadow(ctx: CanvasRenderingContext2D, layer: TextLayer, o: DrawOpts): void {
  applyFont(ctx, layer);
  const steps = 24;
  const stepPx = Math.max(1, layer.size * 0.02);
  ctx.save();
  // Render shadow stack from far to near so near layers overpaint farther.
  for (let i = steps; i >= 1; i--) {
    const t = i / steps;
    ctx.globalAlpha = 0.5 * (1 - t);
    ctx.fillStyle = "#1a1a1a";
    ctx.fillText(layer.text, o.px + i * stepPx, o.py + i * stepPx);
  }
  ctx.restore();
  resetShadow(ctx);
  ctx.fillStyle = layer.color;
  ctx.fillText(layer.text, o.px, o.py);
}

// ─── Preset: Chromatic ────────────────────────────────────────────────
// Cyan + red offset, white core. The classic "cinematic title aberration"
// look — popularized by film posters and high-end title cards. Offset
// scaled to font size so it stays subtle.
function drawChromatic(ctx: CanvasRenderingContext2D, layer: TextLayer, o: DrawOpts): void {
  applyFont(ctx, layer);
  const offset = Math.max(2, layer.size * 0.018);
  ctx.save();
  // Use lighter blend so the channels add into white where they overlap.
  ctx.globalCompositeOperation = "lighter";
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "#ff2238";
  ctx.fillText(layer.text, o.px - offset, o.py);
  ctx.fillStyle = "#22ccff";
  ctx.fillText(layer.text, o.px + offset, o.py);
  ctx.restore();
  ctx.fillStyle = layer.color;
  ctx.fillText(layer.text, o.px, o.py);
}

// ─── Preset: Gradient Fill ────────────────────────────────────────────
// Linear vertical gradient using the layer color as a midpoint, with a
// lighter top stop and darker bottom stop derived from it. Editorial /
// award-poster aesthetic.
function drawGradient(ctx: CanvasRenderingContext2D, layer: TextLayer, o: DrawOpts): void {
  applyFont(ctx, layer);
  // Approximate text height = font size (close enough for the gradient
  // bounds; measureText doesn't give height reliably across browsers).
  const top = o.py - layer.size * 0.5;
  const bottom = o.py + layer.size * 0.5;
  const grad = ctx.createLinearGradient(0, top, 0, bottom);
  grad.addColorStop(0, lightenColor(layer.color, 0.35));
  grad.addColorStop(0.55, layer.color);
  grad.addColorStop(1, darkenColor(layer.color, 0.4));
  ctx.fillStyle = grad;
  ctx.fillText(layer.text, o.px, o.py);

  // Subtle dark stroke to define the gradient edges so it doesn't blend
  // into busy backgrounds.
  ctx.lineWidth = Math.max(1, layer.size * 0.012);
  ctx.strokeStyle = "rgba(0,0,0,0.4)";
  ctx.strokeText(layer.text, o.px, o.py);
}

// ─── Preset: Glass ────────────────────────────────────────────────────
// Frosted-glass backdrop panel under the text. Sample the background,
// blur it, composite as a semi-transparent panel sized to the text
// bounds + padding. Crisp white text on top.
function drawGlass(ctx: CanvasRenderingContext2D, layer: TextLayer, o: DrawOpts): void {
  applyFont(ctx, layer);
  const metrics = ctx.measureText(layer.text);
  const w = metrics.width;
  const h = layer.size * 1.1;
  // Compute the panel bounding box accounting for textAlign.
  let bx: number;
  if (layer.align === "center") bx = o.px - w / 2;
  else if (layer.align === "right") bx = o.px - w;
  else bx = o.px;
  const padX = layer.size * 0.5;
  const padY = layer.size * 0.25;
  const panelX = Math.max(0, bx - padX);
  const panelY = Math.max(0, o.py - h / 2 - padY);
  const panelW = Math.min(o.canvasW - panelX, w + padX * 2);
  const panelH = Math.min(o.canvasH - panelY, h + padY * 2);

  if (o.bgCanvas && panelW > 1 && panelH > 1) {
    // Sample the background, blur it into a small off-screen canvas,
    // then draw scaled back at the panel rect. Cheap CSS-style frost.
    const off = document.createElement("canvas");
    off.width = Math.max(1, Math.round(panelW));
    off.height = Math.max(1, Math.round(panelH));
    const offCtx = off.getContext("2d");
    if (offCtx) {
      offCtx.filter = "blur(18px) brightness(0.55) saturate(1.2)";
      offCtx.drawImage(
        o.bgCanvas,
        panelX, panelY, panelW, panelH,
        0, 0, off.width, off.height,
      );
      ctx.save();
      ctx.globalAlpha = 0.85;
      // Rounded panel
      const r = Math.min(24, panelH * 0.25);
      roundRectPath(ctx, panelX, panelY, panelW, panelH, r);
      ctx.clip();
      ctx.drawImage(off, panelX, panelY, panelW, panelH);
      ctx.restore();
      // Subtle highlight border
      ctx.save();
      roundRectPath(ctx, panelX, panelY, panelW, panelH, r);
      ctx.strokeStyle = "rgba(255,255,255,0.18)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.restore();
    }
  }

  // Crisp text. Default to the layer color but white reads best on
  // frosted glass — if the user picked a dark color, keep it.
  ctx.fillStyle = layer.color;
  ctx.fillText(layer.text, o.px, o.py);
}

function roundRectPath(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Color helpers ────────────────────────────────────────────────────
// Plain hex-only utilities — the editor only emits #rrggbb so we don't
// need to deal with rgba()/hsl() parsing.
function parseHex(c: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(c);
  if (!m) return [255, 255, 255];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function toHex(r: number, g: number, b: number): string {
  const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
  return `#${[r, g, b].map(v => clamp(v).toString(16).padStart(2, "0")).join("")}`;
}
function lightenColor(c: string, amt: number): string {
  const [r, g, b] = parseHex(c);
  return toHex(r + (255 - r) * amt, g + (255 - g) * amt, b + (255 - b) * amt);
}
function darkenColor(c: string, amt: number): string {
  const [r, g, b] = parseHex(c);
  return toHex(r * (1 - amt), g * (1 - amt), b * (1 - amt));
}

// ─── Dispatch ─────────────────────────────────────────────────────────
export function drawTextLayer(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  opts: DrawOpts,
): void {
  // Snapshot the canvas state so a preset that forgets to reset
  // doesn't leak into the next layer.
  ctx.save();
  resetShadow(ctx);
  try {
    switch (layer.effect_preset) {
      case "bloom": drawBloom(ctx, layer, opts); break;
      case "embossed": drawEmbossed(ctx, layer, opts); break;
      case "long_shadow": drawLongShadow(ctx, layer, opts); break;
      case "chromatic": drawChromatic(ctx, layer, opts); break;
      case "gradient": drawGradient(ctx, layer, opts); break;
      case "glass": drawGlass(ctx, layer, opts); break;
      case "none":
      default:
        drawNone(ctx, layer, opts);
    }
  } finally {
    ctx.restore();
  }
}

/**
 * Measure a layer's bounding box for hit-testing during drag.
 * Returns {x, y, w, h} in canvas-space pixels accounting for textAlign.
 * Height is approximated as 1.2 × size — good enough for click detection.
 */
export function measureLayerBounds(
  ctx: CanvasRenderingContext2D,
  layer: TextLayer,
  opts: { px: number; py: number },
): { x: number; y: number; w: number; h: number } {
  ctx.font = `${layer.weight} ${layer.size}px "${layer.font}", sans-serif`;
  ctx.textAlign = layer.align;
  ctx.textBaseline = "middle";
  const metrics = ctx.measureText(layer.text);
  const w = metrics.width;
  const h = layer.size * 1.2;
  let x: number;
  if (layer.align === "center") x = opts.px - w / 2;
  else if (layer.align === "right") x = opts.px - w;
  else x = opts.px;
  const y = opts.py - h / 2;
  return { x, y, w, h };
}
