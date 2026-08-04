/**
 * Confirmation + small picker dialogs for the asset library
 * (Phase 2 extract from ``AssetsPage.tsx``).
 *
 * Each is a thin presentational shell — state + side effects live in
 * the consumer (AssetsPageInner). Co-located here so the host page
 * doesn't carry six near-identical Dialog scaffolds.
 *
 * - ``DeleteAssetConfirmDialog``  — confirm "delete this asset" prompt.
 * - ``MoveToFolderDialog``        — assign asset to a folder (or clear).
 * - ``ReassignChannelDialog``     — move asset to a different channel.
 * - ``NewFolderDialog``           — create a folder under an asset type.
 * - ``RenameFolderDialog``        — rename an existing folder.
 * - ``DeleteFolderConfirmDialog`` — confirm "delete this folder" prompt.
 */
import { useEffect, useState } from "react";
import { Folder, FolderOpen, Tv } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { cn } from "@/lib/utils";
import type { Asset, AssetFolder } from "@/types/index";

// ────────────────────────────────────────────────────────────────────────
// Delete asset confirm
// ────────────────────────────────────────────────────────────────────────

export function DeleteAssetConfirmDialog({
  open,
  onOpenChange,
  asset,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: Asset | null;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Asset</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete &quot;{asset?.filename}&quot;? This action
            cannot be undone.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Deleting..." : "Delete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Move asset → folder
// ────────────────────────────────────────────────────────────────────────

export function MoveToFolderDialog({
  open,
  onOpenChange,
  asset,
  folders,
  onMove,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: Asset | null;
  folders: AssetFolder[];
  onMove: (folderId: number | null) => void;
  isPending: boolean;
}) {
  if (!asset) return null;
  // Folders are scoped to (channel_id, asset_type) — the user can only
  // move into a folder owned by THIS asset's channel and matching its
  // type. Server enforces this too (400 on mismatch); this filter just
  // hides the impossible options.
  const matchingFolders = folders.filter(
    (f) =>
      f.asset_type === asset.asset_type && f.channel_id === asset.channel_id,
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Move to Folder</DialogTitle>
          <DialogDescription>
            Choose a folder for &quot;{asset.title || asset.filename}&quot;.
            Only folders on this asset&apos;s channel and type are listed.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 py-2">
          <button
            className={cn(
              "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
              asset.folder_id === null && "bg-accent text-accent-foreground",
            )}
            onClick={() => onMove(null)}
            disabled={isPending}
          >
            <FolderOpen className="size-4 text-muted-foreground" />
            (No folder)
          </button>
          {matchingFolders.map((folder) => (
            <button
              key={folder.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
                asset.folder_id === folder.id && "bg-accent text-accent-foreground",
              )}
              onClick={() => onMove(folder.id)}
              disabled={isPending}
            >
              <Folder className="size-4 text-muted-foreground" />
              {folder.name}
              <span className="ml-auto text-xs text-muted-foreground">
                {folder.asset_count}
              </span>
            </button>
          ))}
          {matchingFolders.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">
              No folders for this asset type yet.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Reassign asset → channel
// ────────────────────────────────────────────────────────────────────────

/**
 * Asset.channel_id is set at upload/download time. The YouTube
 * download flow used to allow "channel OR folder" — picking only a
 * folder defaulted the channel and put files on the wrong one. This
 * dialog is the user-facing fix: pick the right channel, click; the
 * backend moves the file on disk and updates the row.
 */
export function ReassignChannelDialog({
  open,
  onOpenChange,
  asset,
  channels,
  onReassign,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  asset: Asset | null;
  channels: { id: number; name: string }[];
  onReassign: (channelId: number) => void;
  isPending: boolean;
}) {
  if (!asset) return null;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Reassign to channel</DialogTitle>
          <DialogDescription>
            Move &quot;{asset.title || asset.filename}&quot; to a different channel.
            The file is moved on disk and the asset row is updated to match.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1 py-2">
          {channels.map((ch) => (
            <button
              key={ch.id}
              className={cn(
                "flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors hover:bg-accent",
                asset.channel_id === ch.id && "bg-accent text-accent-foreground",
              )}
              onClick={() => onReassign(ch.id)}
              disabled={isPending || asset.channel_id === ch.id}
            >
              <Tv className="size-4 text-muted-foreground" />
              {ch.name}
              {asset.channel_id === ch.id && (
                <span className="ml-auto text-xs text-muted-foreground">
                  (current)
                </span>
              )}
            </button>
          ))}
          {channels.length === 0 && (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">
              No channels yet — create one first.
            </p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────
// New folder
// ────────────────────────────────────────────────────────────────────────

export function NewFolderDialog({
  open,
  onOpenChange,
  channelName,
  assetTypeLabel,
  onCreate,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Owning channel's name — folders are per-channel post-redesign. */
  channelName: string;
  /** Human-readable label of the asset type the folder will live under
   *  (e.g. "Music", "Image"). Just for display. */
  assetTypeLabel: string;
  onCreate: (name: string) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    onCreate(name.trim());
    setName("");
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setName("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>New Folder</DialogTitle>
            <DialogDescription>
              Create a new folder for {assetTypeLabel} assets
              {channelName ? ` under ${channelName}` : ""}.
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-2">
            <Label htmlFor="folder-name">Folder Name</Label>
            <Input
              id="folder-name"
              placeholder="e.g. Lofi Beats"
              value={name}
              onChange={(e) => setName(e.target.value)}
              autoFocus
            />
          </div>
          <DialogFooter className="mt-6">
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isPending}>
              {isPending ? "Creating..." : "Create"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Rename folder
// ────────────────────────────────────────────────────────────────────────

export function RenameFolderDialog({
  open,
  onOpenChange,
  folder,
  onRename,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder: AssetFolder | null;
  onRename: (vars: { name: string; pair_group: string | null }) => void;
  isPending: boolean;
}) {
  const [name, setName] = useState("");

  useEffect(() => {
    if (folder) {
      setName(folder.name);
    }
  }, [folder]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    // Folder pairing was removed in Phase 0 of the farm redesign; we
    // still submit ``pair_group: null`` to keep the API contract
    // intact, but no UI for it.
    onRename({
      name: name.trim(),
      pair_group: null,
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) setName("");
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>Edit Folder</DialogTitle>
          </DialogHeader>
          <div className="mt-4 space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="rename-folder">Folder name</Label>
              <Input
                id="rename-folder"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoFocus
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button variant="outline" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!name.trim() || isPending}>
              {isPending ? "Saving..." : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

// ────────────────────────────────────────────────────────────────────────
// Delete folder confirm
// ────────────────────────────────────────────────────────────────────────

export function DeleteFolderConfirmDialog({
  open,
  onOpenChange,
  folder,
  onConfirm,
  isPending,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  folder: AssetFolder | null;
  onConfirm: () => void;
  isPending: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete Folder</DialogTitle>
          <DialogDescription>
            Are you sure you want to delete the folder &quot;{folder?.name}&quot;?
            Assets inside will be moved out of the folder, not deleted.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={onConfirm} disabled={isPending}>
            {isPending ? "Deleting..." : "Delete Folder"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
