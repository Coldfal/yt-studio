/**
 * Thumbnail editor canvas — 1280×720 logical, CSS-scaled to fit container.
 *
 * Responsibilities:
 *   - Draw background image with "cover" semantics (filling the canvas
 *     while preserving aspect ratio).
 *   - Draw each text layer via the dispatch in `effects.ts`.
 *   - Hit-test on pointerdown, drag-update layer x/y on pointermove,
 *     commit via `onLayersChange` callback on pointerup.
 *   - Render a dashed selection box around the active layer.
 *   - Expose an imperative `getJpegBlob()` via ref for the Save step.
 *
 * Not a fork of PreviewCanvas: PreviewCanvas is bound to the visualizer
 * editor's audio playhead + RAF rendering. The thumbnail canvas is
 * static, redraws only on state change, and saves on demand.
 */
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";

import {
  drawTextLayer,
  measureLayerBounds,
  type TextLayer,
} from "./effects";

export interface ThumbnailCanvasHandle {
  /** Render the current state and return a JPEG blob (or null on failure). */
  getJpegBlob: (quality?: number) => Promise<Blob | null>;
}

export interface ThumbnailCanvasProps {
  /** Background image URL (already resolved — relative paths fine). */
  bgUrl: string | null;
  layers: TextLayer[];
  /** Index into `layers` of the currently-selected layer (or -1). */
  selectedIndex: number;
  /** Width in CSS pixels the canvas should size to. The logical size is
   *  always 1280×720. */
  containerWidth: number;
  onLayersChange: (next: TextLayer[]) => void;
  onSelect: (index: number) => void;
}

export const CANVAS_W = 1280;
export const CANVAS_H = 720;

export const ThumbnailCanvas = forwardRef<ThumbnailCanvasHandle, ThumbnailCanvasProps>(
  function ThumbnailCanvas(
    { bgUrl, layers, selectedIndex, containerWidth, onLayersChange, onSelect },
    ref,
  ) {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const bgCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const [bgImage, setBgImage] = useState<HTMLImageElement | null>(null);
    const dragRef = useRef<{ index: number; offsetX: number; offsetY: number } | null>(null);

    // Display size derived from container width; preserve 16:9.
    const displayW = Math.max(320, Math.min(containerWidth, 1280));
    const displayH = (displayW * CANVAS_H) / CANVAS_W;
    // Scale factor between display CSS pixels and logical canvas pixels.
    const scale = CANVAS_W / displayW;

    // ── Background image loader ──────────────────────────────────────
    useEffect(() => {
      if (!bgUrl) {
        setBgImage(null);
        return;
      }
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => setBgImage(img);
      img.onerror = () => setBgImage(null);
      img.src = bgUrl;
    }, [bgUrl]);

    // ── Redraw on any state change ───────────────────────────────────
    // ``showSelection``: pass false to omit the dashed selection
    // rectangle. The screen render passes true (so the operator can see
    // what's picked); ``getJpegBlob`` passes false so the saved
    // thumbnail doesn't have a stray blue dashed box baked in.
    const redraw = useCallback((showSelection: boolean = true) => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;

      // Clear + background fill
      ctx.fillStyle = "#0a0a0a";
      ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

      // Cover-fit background
      if (bgImage) {
        const iw = bgImage.naturalWidth;
        const ih = bgImage.naturalHeight;
        const ar = iw / ih;
        const targetAr = CANVAS_W / CANVAS_H;
        let sx = 0, sy = 0, sw = iw, sh = ih;
        if (ar > targetAr) {
          // Image wider than canvas: crop left/right
          sw = ih * targetAr;
          sx = (iw - sw) / 2;
        } else {
          // Image taller: crop top/bottom
          sh = iw / targetAr;
          sy = (ih - sh) / 2;
        }
        ctx.drawImage(bgImage, sx, sy, sw, sh, 0, 0, CANVAS_W, CANVAS_H);
      }

      // Snapshot the background-only state into a side canvas so the
      // Glass preset can sample blur from it without re-rendering bg.
      if (!bgCanvasRef.current) {
        bgCanvasRef.current = document.createElement("canvas");
        bgCanvasRef.current.width = CANVAS_W;
        bgCanvasRef.current.height = CANVAS_H;
      }
      const bgCtx = bgCanvasRef.current.getContext("2d");
      if (bgCtx) {
        bgCtx.clearRect(0, 0, CANVAS_W, CANVAS_H);
        bgCtx.drawImage(canvas, 0, 0);
      }

      // Layers
      layers.forEach((layer, i) => {
        const px = layer.x * CANVAS_W;
        const py = layer.y * CANVAS_H;
        drawTextLayer(ctx, layer, {
          px, py, canvasW: CANVAS_W, canvasH: CANVAS_H,
          bgCanvas: bgCanvasRef.current,
        });

        // Subtle selection outline — only the four CORNER marks, not a
        // full dashed rectangle. Cleaner visual, won't compete with
        // text styling, won't read as "part of the design". Skipped
        // entirely when ``showSelection=false`` so it never lands in
        // the saved JPEG.
        if (showSelection && i === selectedIndex) {
          const b = measureLayerBounds(ctx, layer, { px, py });
          const pad = 10;
          const tickLen = 14;
          const x1 = b.x - pad;
          const y1 = b.y - pad;
          const x2 = b.x + b.w + pad;
          const y2 = b.y + b.h + pad;
          ctx.save();
          ctx.strokeStyle = "rgba(80, 180, 255, 0.75)";
          ctx.lineWidth = 2;
          ctx.beginPath();
          // Top-left
          ctx.moveTo(x1, y1 + tickLen); ctx.lineTo(x1, y1); ctx.lineTo(x1 + tickLen, y1);
          // Top-right
          ctx.moveTo(x2 - tickLen, y1); ctx.lineTo(x2, y1); ctx.lineTo(x2, y1 + tickLen);
          // Bottom-left
          ctx.moveTo(x1, y2 - tickLen); ctx.lineTo(x1, y2); ctx.lineTo(x1 + tickLen, y2);
          // Bottom-right
          ctx.moveTo(x2 - tickLen, y2); ctx.lineTo(x2, y2); ctx.lineTo(x2, y2 - tickLen);
          ctx.stroke();
          ctx.restore();
        }
      });
    }, [bgImage, layers, selectedIndex]);

    useEffect(() => {
      redraw();
    }, [redraw]);

    // Repaint when fonts finish loading so glyphs aren't drawn with the
    // fallback sans-serif metrics on first paint.
    useEffect(() => {
      if (typeof document === "undefined" || !document.fonts) return;
      const handler = () => redraw();
      document.fonts.addEventListener("loadingdone", handler);
      return () => document.fonts.removeEventListener("loadingdone", handler);
    }, [redraw]);

    // ── Drag interactions ────────────────────────────────────────────
    // Convert DOM event coords to logical canvas pixel coords.
    const clientToCanvas = (clientX: number, clientY: number) => {
      const canvas = canvasRef.current;
      if (!canvas) return { x: 0, y: 0 };
      const rect = canvas.getBoundingClientRect();
      return {
        x: (clientX - rect.left) * (CANVAS_W / rect.width),
        y: (clientY - rect.top) * (CANVAS_H / rect.height),
      };
    };

    const hitTest = (cx: number, cy: number): number => {
      const canvas = canvasRef.current;
      const ctx = canvas?.getContext("2d");
      if (!ctx) return -1;
      // Iterate top-down so the top-most layer wins.
      for (let i = layers.length - 1; i >= 0; i--) {
        const layer = layers[i];
        const px = layer.x * CANVAS_W;
        const py = layer.y * CANVAS_H;
        const b = measureLayerBounds(ctx, layer, { px, py });
        if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
          return i;
        }
      }
      return -1;
    };

    const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
      const { x, y } = clientToCanvas(e.clientX, e.clientY);
      const hit = hitTest(x, y);
      if (hit === -1) {
        onSelect(-1);
        return;
      }
      onSelect(hit);
      const layer = layers[hit];
      dragRef.current = {
        index: hit,
        offsetX: x - layer.x * CANVAS_W,
        offsetY: y - layer.y * CANVAS_H,
      };
      (e.target as HTMLCanvasElement).setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
      if (!dragRef.current) return;
      const { x, y } = clientToCanvas(e.clientX, e.clientY);
      const { index, offsetX, offsetY } = dragRef.current;
      const newX = Math.max(0, Math.min(1, (x - offsetX) / CANVAS_W));
      const newY = Math.max(0, Math.min(1, (y - offsetY) / CANVAS_H));
      const next = layers.map((l, i) =>
        i === index ? { ...l, x: newX, y: newY } : l,
      );
      onLayersChange(next);
    };

    const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
      dragRef.current = null;
      try { (e.target as HTMLCanvasElement).releasePointerCapture(e.pointerId); } catch { /* noop */ }
    };

    // ── Imperative JPEG export ───────────────────────────────────────
    useImperativeHandle(ref, () => ({
      getJpegBlob: async (quality = 0.92) => {
        const canvas = canvasRef.current;
        if (!canvas) return null;
        // Force a synchronous redraw WITHOUT the selection chrome so
        // the saved JPEG is pure (no stray blue corner ticks baked in).
        // We restore the on-screen render (with selection) after toBlob
        // returns so the editor UI stays interactive.
        redraw(false);
        const blob = await new Promise<Blob | null>((resolve) => {
          canvas.toBlob((b) => resolve(b), "image/jpeg", quality);
        });
        redraw(true);
        return blob;
      },
    }), [redraw]);

    void scale; // silence unused warning if React strict-mode dev only

    return (
      <canvas
        ref={canvasRef}
        width={CANVAS_W}
        height={CANVAS_H}
        style={{
          width: displayW,
          height: displayH,
          touchAction: "none",
          cursor: dragRef.current ? "grabbing" : selectedIndex !== -1 ? "grab" : "default",
          borderRadius: 6,
          background: "#0a0a0a",
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      />
    );
  },
);
