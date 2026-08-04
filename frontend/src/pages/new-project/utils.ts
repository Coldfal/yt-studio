/**
 * Pure helpers used by the new-project wizard. Kept out of the React
 * components so they can be unit-tested without rendering anything.
 */
import type { VideoProject } from "@/types/index";

/** Format seconds as ``Xh Ym`` (drops parts that are zero). */
export function fmtHM(sec: number): string {
  const total = Math.max(0, Math.round(sec));
  const h = Math.floor(total / 3600);
  const m = Math.round((total % 3600) / 60);
  if (h > 0 && m > 0) return `${h}h ${m}m`;
  if (h > 0) return `${h}h`;
  return `${m}m`;
}

/** Format seconds as HH:MM:SS or MM:SS, YouTube-style timestamp. */
export function formatTimestamp(total: number): string {
  const sec = Math.max(0, Math.floor(total));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }
  return `${m}:${String(s).padStart(2, "0")}`;
}

/** Format seconds as Mm:SS or Hh:MM:SS — used by the music library. */
export function formatDuration(secs: number): string {
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Clean a track name for display in a video description:
 *  - drop the file extension (.mp3, .wav, .flac, etc.)
 *  - strip any text inside parentheses or square brackets, e.g.
 *    "Midnight Corner (Remastered) [2024]" → "Midnight Corner"
 *  - collapse repeated whitespace and trim
 *  - replace underscores with spaces.
 */
export function cleanTrackName(raw: string): string {
  return raw
    .replace(/\.[a-z0-9]{2,5}$/i, "")        // trailing extension
    .replace(/\s*\([^)]*\)\s*/g, " ")        // (…)
    .replace(/\s*\[[^\]]*\]\s*/g, " ")       // […]
    .replace(/_+/g, " ")                      // underscores → spaces
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Build a tracklist block for the video description given the ordered
 * list of tracks (name + duration in seconds). Each line is one track,
 * with its cumulative start timestamp. We deliberately don't append an
 * artist — channels typically own all the tracks, so adding "— Channel
 * Name" to every line is just noise.
 */
export function buildTracklist(
  tracks: Array<{ name: string; duration: number }>,
): string {
  if (!tracks || tracks.length === 0) return "";
  const lines: string[] = [];
  let offset = 0;
  for (const t of tracks) {
    lines.push(`${formatTimestamp(offset)} ${cleanTrackName(t.name)}`);
    offset += Math.max(0, Number(t.duration) || 0);
  }
  return lines.join("\n");
}

/**
 * Decide which wizard step to land on when editing an existing project.
 * Steps: 0=Setup, 1=Music, 2=Compose, 3=Thumbnail (optional), 4=Publish.
 *
 * The Thumbnail step is OPTIONAL — we only park there when the project
 * has been composed but hasn't been to Thumbnail yet. Once the user has
 * either saved a thumbnail OR jumped to Publish at least once, returning
 * to a finished project lands directly on Publish so they don't have to
 * step past Thumbnail every time.
 *
 * Heuristic: presence of ``thumbnail_editor_state`` means the user has
 * been to the Thumbnail step at least once (even if they cleared layers
 * before saving, the column is set). Otherwise we land them there once.
 */
export function getSmartStep(project: VideoProject): number {
  const hasMusic =
    !!project.music_asset_id ||
    (project.music_asset_ids && project.music_asset_ids.length > 0);
  if (!hasMusic) return 1;
  if (!project.composed_asset_id) return 2;
  if (!project.thumbnail_editor_state) return 3; // first visit → Thumbnail
  return 4; // Publish (metadata + upload)
}
