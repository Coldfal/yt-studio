import {
  AlertTriangle,
  FolderOpen,
  Loader2,
  Merge,
  RefreshCw,
  Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { YtIcon } from "@/components/icons/YtIcon";

/**
 * Header bar above the asset grid. Shows a breadcrumb + asset count on
 * the left, three primary actions on the right (Merge Audio, YouTube
 * MP3, Upload). Each action just toggles a dialog open in the shell.
 *
 * The breadcrumb already encodes the current scope ("ZenTaoSounds /
 * Music / Asian Instrumental"), so we don't need a separate channel
 * badge — the channel is the first segment.
 *
 * When the current view contains rows whose underlying file is missing
 * on disk (``file_exists === false``), surface a count + a "Clean up"
 * button right there. Clicking the button calls reconcile scoped to
 * the current view — only the visible missing rows get deleted.
 */
export function AssetsToolbar({
  breadcrumb,
  count,
  missingCount,
  cleanupPending,
  scanPending,
  scanDiskAvailable,
  isLoading,
  onCleanupMissing,
  onScanDisk,
  onMergeOpen,
  onYouTubeOpen,
  onUploadOpen,
}: {
  breadcrumb: string;
  count: number;
  /** Number of rows in the current view with ``file_exists === false``. */
  missingCount: number;
  /** True while a reconcile is in flight. */
  cleanupPending: boolean;
  /** True while a scan-disk call is in flight. */
  scanPending: boolean;
  /**
   * False when the current view is "all channels" — scan-disk requires
   * a channel scope so we never walk every channel at once.
   */
  scanDiskAvailable: boolean;
  isLoading: boolean;
  /** Triggered by the "Clean up X" button next to the missing badge. */
  onCleanupMissing: () => void;
  /** Triggered by the "Scan disk" button — adopts manually-dropped files. */
  onScanDisk: () => void;
  onMergeOpen: () => void;
  onYouTubeOpen: () => void;
  onUploadOpen: () => void;
}) {
  return (
    <div className="flex items-center justify-between border-b border-border bg-card px-4 py-3">
      <div className="flex items-center gap-2 text-sm">
        <FolderOpen className="size-4 text-muted-foreground" />
        <span className="font-medium text-foreground">{breadcrumb}</span>
        {!isLoading && count > 0 && (
          <Badge variant="outline" className="ml-1 text-xs">
            {count}
          </Badge>
        )}
        {!isLoading && missingCount > 0 && (
          <>
            <Badge
              variant="outline"
              className="ml-1 gap-1 border-destructive/50 text-xs text-destructive"
              title="These rows point at files that no longer exist on disk. Asset files are not touched — only the dangling DB rows are deleted."
            >
              <AlertTriangle className="size-3" />
              {missingCount} missing
            </Badge>
            <Button
              size="xs"
              variant="outline"
              onClick={onCleanupMissing}
              disabled={cleanupPending}
              className="border-destructive/50 text-destructive hover:bg-destructive/10"
              title={`Delete the ${missingCount} dangling rows from the database. Asset files on disk are NOT touched (they're already gone — that's why these are missing).`}
            >
              {cleanupPending ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <AlertTriangle className="size-3" />
              )}
              Clean up {missingCount}
            </Button>
          </>
        )}
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onMergeOpen}
          className="text-purple-400 border-purple-400/30 hover:bg-purple-400/10"
        >
          <Merge className="size-4" />
          Merge Audio
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onYouTubeOpen}
          className="text-red-400 border-red-400/30 hover:bg-red-400/10"
        >
          <YtIcon className="size-4" />
          YouTube MP3
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onScanDisk}
          disabled={scanPending || !scanDiskAvailable}
          title={
            scanDiskAvailable
              ? "Walk this channel's folder and adopt any files that don't have a row yet (e.g. files dropped via Windows Explorer). Idempotent — already-known files are skipped."
              : "Pick a channel first — scan-disk doesn't span channels."
          }
        >
          {scanPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <RefreshCw className="size-4" />
          )}
          Scan disk
        </Button>
        <Button size="sm" onClick={onUploadOpen}>
          <Upload className="size-4" />
          Upload
        </Button>
      </div>
    </div>
  );
}
