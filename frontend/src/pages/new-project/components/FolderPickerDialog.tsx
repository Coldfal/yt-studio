import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  ArrowLeft,
  Folder,
  HardDrive,
  Loader2,
  Music,
} from "lucide-react";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * Folder picker for the "music from folder" flow.
 *
 * Why this exists: pasting a long Windows path by hand is error-prone
 * and the New Project wizard's Music step had no native browse
 * affordance. Browser security blocks reading absolute paths via
 * ``<input type="file" webkitdirectory>``, so we drive a small
 * filesystem-list endpoint on the backend (``/api/fs/list-dirs``)
 * and render the navigation tree in this dialog. The host is the
 * operator's own PC, so exposing the local FS is fine.
 *
 * UX choices:
 *  - The CURRENT folder gets a "Use this folder" button — picking
 *    happens at the level you're standing in, not by clicking a
 *    final entry. Mirrors the typical native folder-picker pattern.
 *  - Each subfolder shows the count of audio files it contains
 *    (capped at 200 for performance) so the user can spot music
 *    folders at a glance without drilling in.
 *  - "..", drive list, and an editable path input cover keyboard
 *    users who want to type a path directly.
 */
interface FsEntry {
  name: string;
  path: string;
  audio_file_count: number;
}
interface FsListResponse {
  path: string;
  parent: string | null;
  entries: FsEntry[];
  is_root: boolean;
}

export function FolderPickerDialog({
  open,
  onOpenChange,
  initialPath,
  onPick,
}: {
  open: boolean;
  onOpenChange: (next: boolean) => void;
  /** Starting path; when empty, opens at the FS root (drive list on
   *  Windows, "/" on Unix). The user can also type a path into the
   *  input at the top. */
  initialPath?: string;
  /** Called with the selected absolute path when the user clicks
   *  "Use this folder". Dialog closes automatically. */
  onPick: (path: string) => void;
}) {
  const [path, setPath] = useState<string>(initialPath ?? "");
  const [pathInput, setPathInput] = useState<string>(initialPath ?? "");

  // Reset to the initial path each time the dialog opens. Without
  // this the dialog would remember the user's last navigation across
  // unrelated open/close cycles, which feels stale.
  useEffect(() => {
    if (open) {
      setPath(initialPath ?? "");
      setPathInput(initialPath ?? "");
    }
  }, [open, initialPath]);

  const { data, isLoading, isError, error } = useQuery<FsListResponse>({
    queryKey: ["fs-list", path],
    queryFn: async () => {
      const { data } = await api.get("/fs/list-dirs", {
        params: { path },
      });
      return data;
    },
    enabled: open,
    // We're hitting localhost; no need to debounce or throttle.
    staleTime: 5_000,
  });

  // Keep the editable input in sync with the navigation state, so
  // typing a path also updates the breadcrumb-style header.
  useEffect(() => {
    if (data?.path !== undefined && data.path !== pathInput) {
      setPathInput(data.path);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.path]);

  const navigate = (next: string) => setPath(next);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Folder className="size-4" />
            Browse for music folder
          </DialogTitle>
        </DialogHeader>

        {/* Path input + Up button */}
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="icon-sm"
            variant="outline"
            disabled={data?.parent == null}
            onClick={() => data?.parent != null && navigate(data.parent)}
            title="Up one level"
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <Input
            value={pathInput}
            onChange={(e) => setPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") navigate(pathInput);
            }}
            placeholder="Type a path or click below"
            className="font-mono text-xs"
          />
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => navigate(pathInput)}
          >
            Go
          </Button>
        </div>

        {/* Listing */}
        <div className="max-h-[50vh] min-h-[200px] overflow-y-auto rounded-md border border-border/40 bg-muted/20">
          {isLoading && (
            <div className="flex items-center justify-center gap-2 py-8 text-xs text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading…
            </div>
          )}
          {isError && (
            <div className="px-3 py-4 text-xs text-destructive">
              {(error as { response?: { data?: { detail?: string } } })?.response
                ?.data?.detail ??
                (error as Error)?.message ??
                "Failed to list folder"}
            </div>
          )}
          {!isLoading && !isError && data && (
            <ul className="divide-y divide-border/30">
              {data.is_root && (
                <li className="px-3 py-1.5 text-[10px] text-muted-foreground">
                  Pick a drive to start browsing.
                </li>
              )}
              {data.entries.length === 0 && !data.is_root && (
                <li className="px-3 py-4 text-center text-xs text-muted-foreground">
                  No subfolders here. Use this folder, or type a path above.
                </li>
              )}
              {data.entries.map((entry) => (
                <li
                  key={entry.path}
                  className="flex items-center justify-between gap-2 px-3 py-1.5 hover:bg-accent/30"
                >
                  <button
                    type="button"
                    onClick={() => navigate(entry.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 text-left text-xs"
                    title={entry.path}
                  >
                    {data.is_root ? (
                      <HardDrive className="size-3.5 shrink-0 text-muted-foreground" />
                    ) : (
                      <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    )}
                    <span className="truncate">{entry.name}</span>
                  </button>
                  {entry.audio_file_count > 0 && (
                    <span
                      className={cn(
                        "flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-mono",
                        entry.audio_file_count >= 200
                          ? "bg-primary/15 text-primary"
                          : "bg-muted text-muted-foreground",
                      )}
                      title={
                        entry.audio_file_count >= 200
                          ? "200+ audio files (count capped)"
                          : `${entry.audio_file_count} audio files`
                      }
                    >
                      <Music className="size-3" />
                      {entry.audio_file_count >= 200 ? "200+" : entry.audio_file_count}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>

        <DialogFooter className="flex flex-row items-center justify-between gap-2">
          <span className="text-[11px] text-muted-foreground">
            {data?.is_root
              ? "Click a drive to browse it"
              : "Navigate into a subfolder, or pick the current one."}
          </span>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={!data?.path || data?.is_root}
              onClick={() => {
                if (data?.path) {
                  onPick(data.path);
                  onOpenChange(false);
                }
              }}
            >
              Use this folder
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
