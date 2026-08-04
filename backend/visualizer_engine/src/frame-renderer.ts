/**
 * Per-frame canvas rendering, extracted so it can run both in the
 * interactive preview (RAF-driven, live analyser) and in the offline
 * server render (headless Chrome, pre-computed spectrum).
 *
 * The caller owns: canvas/ctx, image refs, beat state, and the
 * frequency arrays for the current frame. This module owns the
 * sequence of draw operations.
 */

import { renderPreset, type RendererConfig } from "./preset-renderers";
import type { ProjectConfig, CustomText } from "./types";

// ─── Beat detection ────────────────────────────────────────────────

export interface BeatState {
  prevBass: number;
  shakeX: number;
  shakeY: number;
  zoom: number;
  energy: number;
}

export function createBeatState(): BeatState {
  return { prevBass: 0, shakeX: 0, shakeY: 0, zoom: 1, energy: 0 };
}

function detectBeat(
  freq: number[],
  state: BeatState,
  dt: number,
  config: {
    beatShake: boolean;
    beatZoom: boolean;
    beatShakeIntensity: number;
    beatZoomIntensity: number;
  },
) {
  const bassSlice = freq.slice(0, 15);
  const bass = bassSlice.reduce((s, v) => s + v, 0) / bassSlice.length;
  const threshold = 0.1;
  const isBeat = bass - state.prevBass > threshold && bass > 0.25;
  state.prevBass = bass;
  if (isBeat) state.energy = Math.min(1, state.energy + 0.8);
  state.energy *= Math.pow(0.04, dt);
  if (config.beatShake && state.energy > 0.05) {
    const intensity = state.energy * config.beatShakeIntensity * 12;
    state.shakeX = (Math.random() - 0.5) * intensity;
    state.shakeY = (Math.random() - 0.5) * intensity;
  } else {
    state.shakeX *= 0.8;
    state.shakeY *= 0.8;
  }
  state.zoom = config.beatZoom ? 1 + state.energy * config.beatZoomIntensity * 0.08 : 1;
  return { bass, isBeat };
}

// ─── Main frame renderer ─────────────────────────────────────────

// DrawableImage is whatever ctx.drawImage accepts and exposes width/height
// — HTMLImageElement in the browser, @napi-rs/canvas Image in Node.
export interface DrawableImage {
  width: number;
  height: number;
}
export interface DrawableVideo {
  videoWidth: number;
  videoHeight: number;
  readyState: number;
}

// ctx / canvas are the browser DOM types in the preview and the
// @napi-rs/canvas equivalents in the Node render path. Both expose the
// same 2D API, so we type via the DOM definitions and the Node types
// structurally match at call sites.
export interface FrameArgs {
  ctx: CanvasRenderingContext2D;
  canvas: HTMLCanvasElement;
  W: number;
  H: number;
  t: number;
  /** Time used for overlay visibility/fade — usually == audio currentTime in
   *  the preview so the user sees the timed CTA at the same playhead it
   *  will appear at in the rendered video. Defaults to ``t`` when omitted
   *  (server render uses absolute frame time). */
  overlayTime?: number;
  dt: number;
  freq: number[];
  beatFreq: number[];
  beatState: BeatState;
  config: ProjectConfig;
  presetId: string | null | undefined;
  logoImg: DrawableImage | null;
  bgImg: DrawableImage | null;
  bgVideo: DrawableVideo | null;
  overlayImg: DrawableImage | null;
  /** Optional animated overlay (e.g. transparent WebM for the Subscribe
   *  CTA). When provided AND ready, takes precedence over ``overlayImg``
   *  inside drawCornerOverlay. The server render leaves this null and
   *  uses the still ``overlayImg`` instead, which is filled by the
   *  compose service from a PNG fallback when the user picked a WebM. */
  overlayVideo?: DrawableVideo | null;
}

export function renderFrame(args: FrameArgs): void {
  const { ctx, canvas, W, H, t, dt, freq, beatFreq, beatState, config, presetId, logoImg, bgImg, bgVideo, overlayImg } = args;
  const overlayTime = args.overlayTime ?? t;
  const cx = W / 2;
  const cy = H / 2;

  const beat = detectBeat(beatFreq, beatState, dt, config);
  const bs = beatState;

  // Solid background colour
  ctx.fillStyle = config.backgroundColor;
  ctx.fillRect(0, 0, W, H);

  // Background image / video
  const hasBg =
    (config.backgroundType === "video" && bgVideo && bgVideo.readyState >= 2) ||
    bgImg;

  if (hasBg) {
    ctx.save();
    let driftPadX = 0;
    let driftPadY = 0;
    if (config.backgroundDrift) {
      ctx.translate(Math.sin(t * 0.15) * W * 0.03, Math.cos(t * 0.11) * H * 0.02);
      driftPadX = Math.max(driftPadX, W * 0.03);
      driftPadY = Math.max(driftPadY, H * 0.02);
    }
    if (config.backgroundRumble) {
      const bassAvg = freq.slice(0, 10).reduce((s, v) => s + v, 0) / 10;
      const rumbleAmt = bassAvg * 6;
      ctx.translate((Math.random() - 0.5) * rumbleAmt, (Math.random() - 0.5) * rumbleAmt);
      driftPadX += rumbleAmt / 2;
      driftPadY += rumbleAmt / 2;
    }
    const bgSource =
      config.backgroundType === "video" && bgVideo && bgVideo.readyState >= 2
        ? bgVideo
        : bgImg!;
    if (config.backgroundFilter) {
      const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
      const hue = Math.round(t * 20 + avg * 60) % 360;
      ctx.filter = `saturate(1.4) hue-rotate(${hue}deg)`;
    }
    drawBackgroundSource(ctx, W, H, bgSource, {} as Record<string, never>, driftPadX, driftPadY);
    if (config.backgroundFilter) ctx.filter = "none";
    ctx.restore();
  }

  // Camera shake + zoom wrap
  ctx.save();
  ctx.translate(cx, cy);
  ctx.scale(bs.zoom, bs.zoom);
  ctx.translate(-cx + bs.shakeX, -cy + bs.shakeY);

  const rendererConfig: RendererConfig = {
    waveColor1: config.waveColor1,
    waveColor2: config.waveColor2,
    accentColor: config.accentColor,
    backgroundColor: config.backgroundColor,
    reactivity: config.reactivity,
    waveformScale: config.waveformScale,
    spectrumFill: config.spectrumFill,
    particles: config.particles,
    particleDensity: config.particleDensity,
    particleColor: config.particleColor,
    linearPosition: config.linearPosition,
    linearRepeat: config.linearRepeat,
    linearBarColor: config.linearBarColor,
    linearYOffset: config.linearYOffset,
    linearWidth: config.linearWidth,
    linearCenterText:
      config.linearCenterTextSource === "artist"
        ? config.artistName
        : config.linearCenterTextSource === "track"
        ? config.trackName
        : config.linearCenterTextSource === "custom"
        ? config.linearCenterText
        : "",
    linearCenterTextSize: config.linearCenterTextSize,
    linearCenterTextOffsetY: config.linearCenterTextOffsetY,
  };

  // ``visualizer_disabled`` (set by the "Audio-reactive visualizer" toggle)
  // skips only the spectrum bars — particles + background + overlay still
  // render so users can pick a calm visual without losing effects.
  const skipSpectrum = Boolean(
    (config as ProjectConfig & { visualizer_disabled?: boolean }).visualizer_disabled,
  );
  if (!skipSpectrum) {
    renderPreset(presetId, { ctx, W, H, cx, cy, freq, config: rendererConfig, t });
  }

  if (config.particles && !["particle-storm", "glitter-storm"].includes(presetId || "")) {
    drawParticlesOverlay(ctx, W, H, cx, cy, freq, config, t);
  }

  if (config.logoEnabled) {
    drawCenterLogo(ctx, cx, cy, W, H, config, logoImg, beat.bass, bs.energy);
  }
  drawTitleText(ctx, W, H, config);

  ctx.restore(); // end camera shake/zoom

  // Reflection (mirrors the canvas onto itself)
  if (config.reflection !== "none") {
    ctx.save();
    ctx.globalAlpha = 0.35;
    ctx.translate(W, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(canvas, 0, 0);
    if (config.reflection === "4-way") {
      ctx.translate(0, H);
      ctx.scale(1, -1);
      ctx.drawImage(canvas, 0, 0);
      ctx.setTransform(1, 0, 0, -1, 0, H);
      ctx.drawImage(canvas, 0, 0);
    }
    ctx.restore();
  }

  // Prefer animated video overlay if loaded; fall back to still image.
  // Browser preview supplies a WebM via overlayVideo; server render leaves
  // overlayVideo null and uses overlayImg (a PNG fallback resolved by the
  // compose service when the user picked a WebM).
  const overlaySource = (args.overlayVideo &&
    "videoWidth" in args.overlayVideo &&
    args.overlayVideo.videoWidth > 0)
    ? args.overlayVideo as unknown as DrawableImage
    : overlayImg;
  if (config.overlayEnabled && overlaySource) {
    drawCornerOverlay(ctx, W, H, overlayTime, overlaySource, config);
  }

  for (const txt of config.customTexts) {
    drawCustomText(ctx, W, H, txt, config.fontFamily);
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function drawBackgroundSource(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  source: DrawableImage | DrawableVideo,
  _config: Record<string, never>,
  extraPadX: number = 0,
  extraPadY: number = 0,
) {
  ctx.save();
  // Duck-typing so this module works in both browser and Node
  // (HTMLVideoElement only exists in the browser).
  const isVideo = "videoWidth" in source;
  const srcW = isVideo ? (source as DrawableVideo).videoWidth : (source as DrawableImage).width;
  const srcH = isVideo ? (source as DrawableVideo).videoHeight : (source as DrawableImage).height;
  if (srcW === 0 || srcH === 0) {
    ctx.restore();
    return;
  }
  const imgAspect = srcW / srcH;
  const canvasAspect = W / H;
  let sx = 0, sy = 0, sw = srcW, sh = srcH;
  if (imgAspect > canvasAspect) {
    sw = srcH * canvasAspect;
    sx = (srcW - sw) / 2;
  } else {
    sh = srcW / canvasAspect;
    sy = (srcH - sh) / 2;
  }
  const padX = extraPadX;
  const padY = extraPadY;
  ctx.drawImage(source as CanvasImageSource, sx, sy, sw, sh, -padX, -padY, W + padX * 2, H + padY * 2);
  ctx.restore();
}

function drawCenterLogo(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  W: number,
  H: number,
  config: { logoScale: number; logoBorderRadius: number; waveColor1: string; waveColor2: string },
  logoImg: DrawableImage | null,
  _bass: number,
  beatEnergy: number,
) {
  const baseSize = Math.min(W, H) * 0.28 * config.logoScale;
  const pulse = 1 + beatEnergy * 0.04;
  const size = baseSize * pulse;
  const radius = (config.logoBorderRadius / 100) * (size / 2);
  const x = cx - size / 2;
  const y = cy - size / 2;
  ctx.save();
  const glowSize = size * 1.3;
  const glow = ctx.createRadialGradient(cx, cy, size * 0.3, cx, cy, glowSize);
  glow.addColorStop(0, hexToRgba(config.waveColor2, 0.15 + beatEnergy * 0.15));
  glow.addColorStop(0.5, hexToRgba(config.waveColor1, 0.05));
  glow.addColorStop(1, "transparent");
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(cx, cy, glowSize, 0, Math.PI * 2);
  ctx.fill();
  if (logoImg) {
    ctx.beginPath();
    roundedRect(ctx, x, y, size, size, radius);
    ctx.closePath();
    ctx.clip();
    const imgAspect = logoImg.width / logoImg.height;
    let sx = 0, sy = 0, sw = logoImg.width, sh = logoImg.height;
    if (imgAspect > 1) {
      sw = logoImg.height;
      sx = (logoImg.width - sw) / 2;
    } else {
      sh = logoImg.width;
      sy = (logoImg.height - sh) / 2;
    }
    ctx.drawImage(logoImg as CanvasImageSource, sx, sy, sw, sh, x, y, size, size);
    ctx.restore();
    ctx.save();
  } else {
    ctx.beginPath();
    roundedRect(ctx, x, y, size, size, radius);
    ctx.closePath();
    ctx.fillStyle = hexToRgba(config.waveColor1, 0.06);
    ctx.fill();
    ctx.strokeStyle = hexToRgba(config.waveColor1, 0.15);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.strokeStyle = hexToRgba(config.waveColor1, 0.35);
    ctx.lineWidth = 2;
    ctx.lineCap = "round";
    const iconBars = [0.3, 0.6, 1.0, 0.6, 0.3];
    const barW = size * 0.06;
    const totalBarW = iconBars.length * barW + (iconBars.length - 1) * barW * 0.8;
    let bx = cx - totalBarW / 2;
    for (const bh of iconBars) {
      const h = size * 0.25 * bh;
      ctx.beginPath();
      ctx.moveTo(bx + barW / 2, cy - h / 2);
      ctx.lineTo(bx + barW / 2, cy + h / 2);
      ctx.stroke();
      bx += barW * 1.8;
    }
  }
  ctx.restore();
}

function drawParticlesOverlay(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  cx: number,
  cy: number,
  freq: number[],
  config: { particleStyle: string; particleDensity: number; particleColor: string },
  t: number,
) {
  const style = config.particleStyle || "floating";
  switch (style) {
    case "snow":
      return drawSnow(ctx, W, H, config, t);
    case "fireflies":
      return drawFireflies(ctx, W, H, cx, cy, freq, config, t);
    case "rain":
      return drawRain(ctx, W, H, config, t);
    case "stars":
      return drawStars(ctx, W, H, freq, config, t);
    case "smoke":
      return drawSmoke(ctx, W, H, cx, cy, freq, config, t);
    default:
      return drawFloating(ctx, W, H, cx, cy, freq, config, t);
  }
}

function drawFloating(
  ctx: CanvasRenderingContext2D, W: number, H: number, cx: number, cy: number,
  freq: number[], config: { particleDensity: number; particleColor: string }, t: number,
) {
  const count = Math.floor(config.particleDensity * 0.4);
  const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
  const c = hexToRgb(config.particleColor);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const seed = i * 137.508;
    const px = cx + Math.sin(seed + t * 0.3) * W * 0.45;
    const py = cy + Math.cos(seed * 0.7 + t * 0.2) * H * 0.45;
    const alpha = (Math.sin(t + seed) * 0.5 + 0.5) * 0.25 * (0.5 + avg);
    const size = 1 + Math.sin(seed) * 0.5;
    ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawSnow(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  config: { particleDensity: number; particleColor: string }, t: number,
) {
  const count = Math.floor(config.particleDensity * 0.6);
  const c = hexToRgb(config.particleColor);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const seed = i * 97.31;
    const speed = 0.3 + (seed % 1) * 0.4;
    const px = ((seed * 73.17) % W + Math.sin(t * 0.5 + seed) * 30) % W;
    const py = ((t * speed * 40 + seed * 53.71) % (H + 20)) - 10;
    const size = 1.5 + (seed % 3) * 0.5;
    const alpha = 0.3 + Math.sin(seed + t * 0.3) * 0.15;
    ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawFireflies(
  ctx: CanvasRenderingContext2D, W: number, H: number, cx: number, cy: number,
  freq: number[], config: { particleDensity: number; particleColor: string }, t: number,
) {
  const count = Math.floor(config.particleDensity * 0.3);
  const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
  const c = hexToRgb(config.particleColor);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const seed = i * 211.13;
    const orbit = 0.15 + (seed % 1) * 0.35;
    const px = cx + Math.sin(seed * 0.3 + t * (0.2 + (seed % 0.3))) * W * orbit;
    const py = cy + Math.cos(seed * 0.7 + t * (0.15 + (seed % 0.2))) * H * orbit;
    const pulse = Math.sin(t * 2 + seed) * 0.5 + 0.5;
    const alpha = pulse * 0.5 * (0.5 + avg);
    const size = 2 + pulse * 2;
    const grad = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
    grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${alpha})`);
    grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, size * 3, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha * 1.5})`;
    ctx.beginPath();
    ctx.arc(px, py, size * 0.4, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawRain(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  config: { particleDensity: number; particleColor: string }, t: number,
) {
  const count = Math.floor(config.particleDensity * 0.8);
  const c = hexToRgb(config.particleColor);
  ctx.save();
  ctx.lineWidth = 1;
  for (let i = 0; i < count; i++) {
    const seed = i * 61.73;
    const speed = 1.5 + (seed % 1) * 2;
    const px = (seed * 37.19) % W;
    const py = ((t * speed * 120 + seed * 47.91) % (H + 40)) - 20;
    const len = 8 + (seed % 10);
    const alpha = 0.15 + (seed % 0.15);
    ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.lineTo(px - 1, py + len);
    ctx.stroke();
  }
  ctx.restore();
}

function drawStars(
  ctx: CanvasRenderingContext2D, W: number, H: number,
  freq: number[], config: { particleDensity: number; particleColor: string }, t: number,
) {
  const count = Math.floor(config.particleDensity * 0.5);
  const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
  const c = hexToRgb(config.particleColor);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const seed = i * 173.29;
    const px = (seed * 83.41) % W;
    const py = (seed * 47.63) % H;
    const twinkle = Math.sin(t * (2 + seed % 3) + seed) * 0.5 + 0.5;
    const alpha = twinkle * 0.4 * (0.6 + avg * 0.8);
    const size = 0.8 + twinkle * 1.2;
    ctx.fillStyle = `rgba(${c.r},${c.g},${c.b},${alpha})`;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
    if (twinkle > 0.7) {
      ctx.strokeStyle = `rgba(${c.r},${c.g},${c.b},${alpha * 0.4})`;
      ctx.lineWidth = 0.5;
      const fl = size * 4;
      ctx.beginPath();
      ctx.moveTo(px - fl, py); ctx.lineTo(px + fl, py);
      ctx.moveTo(px, py - fl); ctx.lineTo(px, py + fl);
      ctx.stroke();
    }
  }
  ctx.restore();
}

function drawSmoke(
  ctx: CanvasRenderingContext2D, W: number, H: number, cx: number, cy: number,
  freq: number[], config: { particleDensity: number; particleColor: string }, t: number,
) {
  const count = Math.floor(config.particleDensity * 0.2);
  const avg = freq.reduce((s, v) => s + v, 0) / freq.length;
  const c = hexToRgb(config.particleColor);
  ctx.save();
  for (let i = 0; i < count; i++) {
    const seed = i * 251.07;
    const life = ((t * 0.3 + seed * 0.01) % 1);
    const px = cx + Math.sin(seed) * W * 0.3 + Math.sin(t * 0.2 + seed) * 40;
    const py = cy + (1 - life) * H * 0.5 - H * 0.1;
    const size = 15 + life * 30 + avg * 20;
    const alpha = (1 - life) * 0.06 * (0.5 + avg);
    const grad = ctx.createRadialGradient(px, py, 0, px, py, size);
    grad.addColorStop(0, `rgba(${c.r},${c.g},${c.b},${alpha})`);
    grad.addColorStop(1, `rgba(${c.r},${c.g},${c.b},0)`);
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

// Build a CSS font shorthand string. Multi-word family names (e.g.
// "Trajan Pro 3") MUST be quoted in CSS or the parser breaks them up
// at whitespace and falls through to the fallback. Always append
// ``sans-serif`` as the ultimate fallback — keeps text legible if the
// chosen font isn't installed on the engine sidecar's host.
function fontStack(family: string | undefined): string {
  const f = (family || "").trim() || "Geist";
  const quoted = /\s/.test(f) ? `"${f}"` : f;
  return `${quoted}, sans-serif`;
}

function drawTitleText(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  config: {
    artistName: string;
    trackName: string;
    textColor: string;
    fontSize: number;
    fontFamily?: string;
    textPosition: string;
    linearCenterTextSource: "none" | "custom" | "artist" | "track";
  },
) {
  const skipArtist = config.linearCenterTextSource === "artist";
  const skipTrack = config.linearCenterTextSource === "track";
  ctx.save();
  ctx.textAlign = "center";
  ctx.fillStyle = config.textColor;
  let baseY: number;
  switch (config.textPosition) {
    case "top":
      baseY = 60;
      break;
    case "center":
      baseY = H / 2 + H * 0.25;
      break;
    default:
      baseY = H - 80;
  }
  const fam = fontStack(config.fontFamily);
  if (!skipArtist) {
    ctx.font = `bold ${config.fontSize}px ${fam}`;
    ctx.globalAlpha = 0.95;
    ctx.fillText(config.artistName, W / 2, baseY);
  }
  if (!skipTrack) {
    ctx.font = `${config.fontSize * 0.65}px ${fam}`;
    ctx.globalAlpha = 0.6;
    const trackY = skipArtist ? baseY : baseY + config.fontSize * 0.85;
    ctx.fillText(config.trackName, W / 2, trackY);
  }
  ctx.restore();
}

function drawCornerOverlay(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  t: number,
  img: DrawableImage,
  config: {
    overlayPosition: string;
    overlayScale: number;
    overlayOpacity: number;
    overlayOffsetX: number;
    overlayOffsetY: number;
    overlayStartTime?: number | null;
    overlayEndTime?: number | null;
    overlayFadeIn?: number;
    overlayFadeOut?: number;
  },
) {
  // ── Timed visibility with smooth fade ──────────────────────────────
  const start = config.overlayStartTime ?? 0;
  const end = config.overlayEndTime ?? Infinity;
  const fadeIn = config.overlayFadeIn ?? 0;
  const fadeOut = config.overlayFadeOut ?? 0;

  // Outside active window → skip entirely
  if (t < start || t > end) return;

  // Compute fade multiplier (0-1)
  let fadeMul = 1;
  if (fadeIn > 0 && t < start + fadeIn) {
    fadeMul = (t - start) / fadeIn;
  } else if (fadeOut > 0 && end !== Infinity && t > end - fadeOut) {
    fadeMul = (end - t) / fadeOut;
  }
  fadeMul = Math.max(0, Math.min(1, fadeMul));

  ctx.save();
  const maxSize = Math.min(W, H) * 0.12 * config.overlayScale;
  // Support both DrawableImage (width/height) and HTMLVideoElement
  // (videoWidth/videoHeight). The video element is upcast to DrawableImage
  // at the call site, so check both.
  const srcW = ("videoWidth" in (img as object) && (img as unknown as { videoWidth: number }).videoWidth)
    || img.width;
  const srcH = ("videoHeight" in (img as object) && (img as unknown as { videoHeight: number }).videoHeight)
    || img.height;
  if (!srcW || !srcH) {
    ctx.restore();
    return;
  }
  const aspect = srcW / srcH;
  let drawW: number, drawH: number;
  if (aspect >= 1) {
    drawW = maxSize;
    drawH = maxSize / aspect;
  } else {
    drawH = maxSize;
    drawW = maxSize * aspect;
  }
  const margin = W * 0.03;
  let x: number, y: number;
  switch (config.overlayPosition) {
    case "top-left":
      x = margin;
      y = margin;
      break;
    case "top-right":
      x = W - drawW - margin;
      y = margin;
      break;
    case "bottom-left":
      x = margin;
      y = H - drawH - margin;
      break;
    case "custom":
      // Absolute mode: offsets are direct % of canvas, anchoring the
      // overlay's TOP-LEFT corner. No safe-area margin applied.
      x = (config.overlayOffsetX / 100) * W;
      y = (config.overlayOffsetY / 100) * H;
      break;
    default:
      x = W - drawW - margin;
      y = H - drawH - margin;
  }
  // The corner anchors take the offset as a NUDGE (-50 to 50% of canvas)
  // — useful for tweaking inside the safe-area frame. Custom mode set
  // x/y absolutely above and skips this so the user's typed numbers
  // mean what they say.
  if (config.overlayPosition !== "custom") {
    x += (config.overlayOffsetX / 100) * W;
    y += (config.overlayOffsetY / 100) * H;
  }
  ctx.globalAlpha = config.overlayOpacity * fadeMul;
  ctx.drawImage(img as CanvasImageSource, x, y, drawW, drawH);
  ctx.globalAlpha = 1;
  ctx.restore();
}

function customTextFont(
  size: number,
  weight: CustomText["weight"],
  W: number,
  family?: string,
) {
  const px = size * (W / 1920);
  const w = weight === "black" ? 900 : weight === "bold" ? 700 : 400;
  return `${w} ${px}px ${fontStack(family)}`;
}

function drawCustomText(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  txt: CustomText,
  fontFamily?: string,
) {
  if (!txt.text.trim()) return;
  ctx.save();
  ctx.font = customTextFont(txt.size, txt.weight, W, fontFamily);
  ctx.fillStyle = txt.color;
  ctx.textAlign = txt.align;
  ctx.textBaseline = "middle";
  ctx.fillText(txt.text, txt.x * W, txt.y * H);
  ctx.restore();
}

export function hitTestCustomText(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  txt: CustomText,
  px: number,
  py: number,
  fontFamily?: string,
): boolean {
  if (!txt.text.trim()) return false;
  ctx.save();
  ctx.font = customTextFont(txt.size, txt.weight, W, fontFamily);
  const metrics = ctx.measureText(txt.text);
  const textW = metrics.width;
  const renderedPx = txt.size * (W / 1920);
  const textH = renderedPx * 1.2;
  ctx.restore();
  const anchorX = txt.x * W;
  const anchorY = txt.y * H;
  let x0 = anchorX;
  if (txt.align === "center") x0 = anchorX - textW / 2;
  else if (txt.align === "right") x0 = anchorX - textW;
  const y0 = anchorY - textH / 2;
  return px >= x0 && px <= x0 + textW && py >= y0 && py <= y0 + textH;
}

// ─── Shared color helpers ─────────────────────────────────────────

function roundedRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
) {
  r = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
}

function hexToRgba(hex: string, a: number) {
  const c = hex.replace("#", "");
  const r = parseInt(c.substring(0, 2), 16) || 128;
  const g = parseInt(c.substring(2, 4), 16) || 128;
  const b = parseInt(c.substring(4, 6), 16) || 128;
  return `rgba(${r},${g},${b},${a})`;
}

function hexToRgb(hex: string) {
  const c = hex.replace("#", "");
  return {
    r: parseInt(c.substring(0, 2), 16) || 255,
    g: parseInt(c.substring(2, 4), 16) || 255,
    b: parseInt(c.substring(4, 6), 16) || 255,
  };
}
