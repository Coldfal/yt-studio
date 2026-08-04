/**
 * Re-export of the canonical preset renderers from the engine sidecar.
 *
 * The actual implementation lives in
 * ``backend/visualizer_engine/src/preset-renderers.ts``. This alias
 * keeps existing relative imports (``./preset-renderers``) working
 * from PreviewCanvas / frame-renderer.ts.
 */
export * from "@visualizer/preset-renderers";
