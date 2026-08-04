/**
 * Font registry loader for the thumbnail editor.
 *
 * Backend `GET /api/fonts` lists every .ttf/.otf in
 * `backend/visualizer_engine/fonts/` (deduped by family). We fetch the
 * list once, then use the browser's FontFace API to register each font
 * with `document.fonts` so canvas-side `ctx.font = '... "Family Name"'`
 * works for rendering AND `ctx.measureText` returns accurate bounds.
 *
 * Cached at module scope so it runs once per session. Subsequent calls
 * return the cached list immediately.
 *
 * Why FontFace not CSS @font-face: the canvas API can't see CSS
 * @font-face rules at all on its own — the font has to be in
 * `document.fonts` for `measureText` to return non-zero widths. FontFace
 * does both: loads the font AND registers it in `document.fonts`.
 */
import api from "@/lib/api";

export interface FontInfo {
  family: string;
  filename: string;
  url: string;
}

let cache: FontInfo[] | null = null;
let inflight: Promise<FontInfo[]> | null = null;

export async function ensureFontsLoaded(): Promise<FontInfo[]> {
  if (cache) return cache;
  if (inflight) return inflight;

  inflight = (async () => {
    const { data } = await api.get<FontInfo[]>("/fonts/");
    // FontFace constructor wants a URL string; the backend serves
    // /api/fonts/file/<name>. The url field already includes the /api
    // prefix because the JSON came back through axios's /api baseURL
    // wrapping. Strip /api so we go through the same vite proxy.
    await Promise.all(
      data.map(async (f) => {
        // Already-registered? Skip — adding twice throws InvalidModificationError.
        for (const existing of document.fonts) {
          if (existing.family === f.family) return;
        }
        try {
          const face = new FontFace(f.family, `url(${f.url})`);
          const loaded = await face.load();
          document.fonts.add(loaded);
        } catch (err) {
          // Swallow per-font errors — a broken font in the pack
          // shouldn't take down the editor. Surface it once in console
          // so the user can see which one failed.
          // eslint-disable-next-line no-console
          console.warn(`Failed to load font "${f.family}":`, err);
        }
      }),
    );
    await document.fonts.ready;
    cache = data;
    return data;
  })();

  return inflight;
}

/**
 * Best-effort "is this font ready to render text" check used by canvas
 * draw paths. Returns true when `document.fonts.check()` says the family
 * is loaded at the requested size, OR when we haven't loaded the font
 * registry yet (in which case the canvas will fall back to its default,
 * which is still better than nothing).
 */
export function isFontReady(family: string, size: number): boolean {
  if (typeof document === "undefined" || !document.fonts) return true;
  try {
    return document.fonts.check(`${size}px "${family}"`);
  } catch {
    return true;
  }
}
