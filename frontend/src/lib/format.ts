/**
 * Tiny formatting helpers that previously lived as duplicates inside
 * individual pages. Centralised so callers don't drift on edge-case
 * handling (zero duration, hours, etc.) and so the dialog extractions
 * stop carrying their own copies.
 */

/** Format seconds as ``[H:]MM:SS``, e.g. 75 → "1:15", 4500 → "1:15:00". */
export function formatDuration(s: number): string {
  if (!Number.isFinite(s) || s <= 0) return "0:00";
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, "0")}:${sec.toString().padStart(2, "0")}`;
  }
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

/** Format a byte count as ``"X.X MB"``/``"X.X KB"``/``"X B"``. */
export function formatFileSize(bytes: number | null | undefined): string {
  if (!bytes) return "";
  if (bytes >= 1_048_576) return `${(bytes / 1_048_576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Format a byte count for storage summaries — same idea as
 * ``formatFileSize`` but goes up to GB / TB. Used on the dashboard
 * channel cards to show "24.5 GB" without making the operator think
 * about per-asset sizes.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (!bytes || bytes < 0) return "0 B";
  const TB = 1024 ** 4;
  const GB = 1024 ** 3;
  const MB = 1024 ** 2;
  const KB = 1024;
  if (bytes >= TB) return `${(bytes / TB).toFixed(2)} TB`;
  if (bytes >= GB) return `${(bytes / GB).toFixed(1)} GB`;
  if (bytes >= MB) return `${(bytes / MB).toFixed(1)} MB`;
  if (bytes >= KB) return `${(bytes / KB).toFixed(1)} KB`;
  return `${bytes} B`;
}
