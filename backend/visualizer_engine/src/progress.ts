/**
 * NDJSON progress writer. Each line written to stdout is a single JSON
 * object the Python parent parses to update the composition progress bar.
 *
 * Stages:
 *   analysing_audio  — FFmpeg decoding + FFT
 *   loading_assets   — loading logo/background/overlay images
 *   rendering        — per-frame canvas render + encode
 *   encoding         — flushing final JPEG to FFmpeg, finalising MP4
 *   done             — success terminal
 *   error            — failure terminal (non-zero exit follows)
 */

export type ProgressStage =
  | "analysing_audio"
  | "loading_assets"
  | "rendering"
  | "encoding"
  | "done"
  | "error";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface ProgressEvent {
  stage: ProgressStage;
  [key: string]: unknown;
}

/**
 * Write a progress event as a single NDJSON line to stdout.
 * Uses process.stdout.write directly (not console.log) so we don't
 * ever accidentally interleave framing characters.
 */
export function sendProgress(ev: ProgressEvent): void {
  try {
    process.stdout.write(JSON.stringify(ev) + "\n");
  } catch {
    // stdout closed — nothing to do
  }
}
