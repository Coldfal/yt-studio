import { MoveRight, Tag, Trash2, Tv } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Floating bottom bar that appears when one or more cards are selected.
 * Holds the bulk-action triggers (Move to folder, Reassign channel,
 * Reassign role, Delete). Hidden entirely when nothing is selected so
 * a healthy library shows nothing.
 *
 * The "Set role" dropdown is only meaningful for image assets but the
 * caller decides when to render the whole bar — selections that mix
 * images with music/video aren't gated here; the API silently no-ops
 * on non-image rows.
 */
export function BulkActionBar({
  selectedCount,
  deleteDisabled,
  showRoleAction,
  onClear,
  onMove,
  onReassign,
  onSetRole,
  onDelete,
}: {
  selectedCount: number;
  /** Disable the Delete button while a delete mutation is in flight. */
  deleteDisabled: boolean;
  /** Show the "Set role" dropdown — only useful when the selection
   *  contains image assets. The parent computes this from its own
   *  filteredAssets + selectedIds. */
  showRoleAction?: boolean;
  onClear: () => void;
  onMove: () => void;
  onReassign: () => void;
  onSetRole?: (role: "background" | "thumbnail" | "overlay" | "reference" | null) => void;
  onDelete: () => void;
}) {
  if (selectedCount === 0) return null;
  return (
    <div className="fixed inset-x-0 bottom-4 z-30 flex justify-center px-4">
      <div className="flex items-center gap-2 rounded-full border bg-background px-3 py-2 shadow-lg">
        <span className="text-sm font-medium">{selectedCount} selected</span>
        <span className="text-muted-foreground">·</span>
        <Button size="sm" variant="ghost" onClick={onClear}>
          Clear
        </Button>
        <span className="text-muted-foreground">·</span>
        <Button size="sm" variant="outline" onClick={onMove}>
          <MoveRight className="size-3.5" />
          Move to folder
        </Button>
        <Button size="sm" variant="outline" onClick={onReassign}>
          <Tv className="size-3.5" />
          Reassign channel
        </Button>
        {showRoleAction && onSetRole && (
          <DropdownMenu>
            <DropdownMenuTrigger render={<Button size="sm" variant="outline" />}>
              <Tag className="size-3.5" />
              Set role
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuLabel>Re-classify as…</DropdownMenuLabel>
              <DropdownMenuItem onClick={() => onSetRole("background")}>
                🎬 Background
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSetRole("thumbnail")}>
                🖼️ Thumbnail
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSetRole("overlay")}>
                ✨ Overlay
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => onSetRole("reference")}>
                📝 Reference
              </DropdownMenuItem>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => onSetRole(null)}>
                Clear (unclassified)
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        )}
        <Button
          size="sm"
          variant="destructive"
          onClick={onDelete}
          disabled={deleteDisabled}
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
      </div>
    </div>
  );
}
