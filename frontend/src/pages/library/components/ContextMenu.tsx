import { useEffect, useRef } from "react";
import { FolderPlus, MoveRight, Pencil, Trash2, Tv } from "lucide-react";
import type { Asset, AssetFolder } from "@/types/index";

export interface ContextMenuState {
  x: number;
  y: number;
  kind:
    | { type: "panel-empty" }
    | { type: "category"; channelId: number; categoryKey: string }
    | { type: "folder"; folder: AssetFolder }
    | { type: "asset"; asset: Asset };
}

/**
 * Right-click context menu shown over the sidebar (categories, folders)
 * and the asset grid (cards). Closes on outside click. Items vary by
 * what was right-clicked — a folder gets Rename/Delete, an asset gets
 * Move/Reassign/Delete, etc.
 */
export function ContextMenu({
  state,
  onClose,
  onNewFolder,
  onRenameFolder,
  onDeleteFolder,
  onDeleteAsset,
  onMoveAsset,
  onReassignChannel,
}: {
  state: ContextMenuState;
  onClose: () => void;
  onNewFolder: (channelId: number, categoryKey: string) => void;
  onRenameFolder: (folder: AssetFolder) => void;
  onDeleteFolder: (folder: AssetFolder) => void;
  onDeleteAsset: (asset: Asset) => void;
  onMoveAsset: (asset: Asset) => void;
  onReassignChannel: (asset: Asset) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [onClose]);

  const items: {
    label: string;
    icon: React.ReactNode;
    onClick: () => void;
    destructive?: boolean;
  }[] = [];

  if (state.kind.type === "panel-empty") {
    // No items for empty panel right-click for now (could add "New Folder" if category is selected)
  } else if (state.kind.type === "category") {
    const k = state.kind;
    items.push({
      label: "New Folder",
      icon: <FolderPlus className="size-4" />,
      onClick: () => {
        onNewFolder(k.channelId, k.categoryKey);
        onClose();
      },
    });
  } else if (state.kind.type === "folder") {
    items.push({
      label: "Rename",
      icon: <Pencil className="size-4" />,
      onClick: () => {
        onRenameFolder(
          state.kind.type === "folder"
            ? state.kind.folder
            : ({} as AssetFolder),
        );
        onClose();
      },
    });
    items.push({
      label: "Delete Folder",
      icon: <Trash2 className="size-4" />,
      destructive: true,
      onClick: () => {
        onDeleteFolder(
          state.kind.type === "folder"
            ? state.kind.folder
            : ({} as AssetFolder),
        );
        onClose();
      },
    });
  } else if (state.kind.type === "asset") {
    items.push({
      label: "Move to folder...",
      icon: <MoveRight className="size-4" />,
      onClick: () => {
        onMoveAsset(
          state.kind.type === "asset" ? state.kind.asset : ({} as Asset),
        );
        onClose();
      },
    });
    items.push({
      label: "Reassign to channel...",
      icon: <Tv className="size-4" />,
      onClick: () => {
        onReassignChannel(
          state.kind.type === "asset" ? state.kind.asset : ({} as Asset),
        );
        onClose();
      },
    });
    items.push({
      label: "Delete",
      icon: <Trash2 className="size-4" />,
      destructive: true,
      onClick: () => {
        onDeleteAsset(
          state.kind.type === "asset" ? state.kind.asset : ({} as Asset),
        );
        onClose();
      },
    });
  }

  if (items.length === 0) return null;

  return (
    <div
      ref={ref}
      className="fixed z-50 min-w-[160px] rounded-md border border-border bg-popover p-1 shadow-lg"
      style={{ left: state.x, top: state.y }}
    >
      {items.map((item, i) => (
        <button
          key={i}
          className={`flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm transition-colors hover:bg-accent ${
            item.destructive ? "text-destructive" : "text-popover-foreground"
          }`}
          onClick={item.onClick}
        >
          {item.icon}
          {item.label}
        </button>
      ))}
    </div>
  );
}
