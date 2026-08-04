/**
 * Re-export of the canonical frame renderer from the engine sidecar.
 *
 * The actual implementation lives in
 * ``backend/visualizer_engine/src/frame-renderer.ts`` so the offline
 * render (Node sidecar) and the in-browser preview share the same
 * draw sequence pixel-for-pixel. This alias keeps existing relative
 * imports (``./frame-renderer``) working from PreviewCanvas et al.
 */
export * from "@visualizer/frame-renderer";
