/**
 * Re-export of the canonical visualizer types from the engine sidecar.
 *
 * The actual definitions live in ``backend/visualizer_engine/src/types.ts``
 * — that file IS the source of truth for both the offline render
 * (Node sidecar) and the in-browser preview. This alias keeps existing
 * frontend imports (``@/types/visualizer``) working unchanged.
 */
export * from "@visualizer/types";
