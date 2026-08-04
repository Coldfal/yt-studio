import {
  AlertTriangle,
  Eye,
  FileImage,
  Film,
  FolderOpen,
  Image,
  Maximize2,
  Music,
  Pause,
  Play,
  Repeat,
  Trash2,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  formatDuration as sharedFormatDuration,
  formatFileSize as sharedFormatFileSize,
} from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Asset } from "@/types/index";
import type { NavSelection } from "../categories";

function AssetTypeIcon({ type }: { type: string }) {
  switch (type) {
    case "music":
      return <Music className="size-5 text-blue-400" />;
    case "video":
      return <Film className="size-5 text-cyan-400" />;
    case "image":
      return <FileImage className="size-5 text-green-400" />;
    case "composed":
      return <Film className="size-5 text-purple-400" />;
    case "thumbnail":
      return <Image className="size-5 text-orange-400" />;
    default:
      return <FolderOpen className="size-5 text-muted-foreground" />;
  }
}

/**
 * One tile in the asset grid. Handles its own play/preview/delete actions
 * and the multi-select checkbox overlay; raises high-level callbacks
 * upward for things that need cross-tile state (context menu, bulk
 * selection set, media-player playlist building).
 */
export function AssetCard({
  asset,
  channelName,
  isNowPlaying,
  isSelected,
  nav,
  onPlay,
  onPreview,
  onCardClick,
  onContextMenu,
  onToggleSelect,
  onDelete,
  onFindLoop,
}: {
  asset: Asset;
  channelName: string;
  isNowPlaying: boolean;
  isSelected: boolean;
  nav: NavSelection;
  /** Click handler for the play/pause icon (audio only). */
  onPlay: (asset: Asset, event: React.MouseEvent) => void;
  /** Click handler for the preview icon (visuals only). */
  onPreview: (asset: Asset) => void;
  /**
   * Click anywhere on the card body. The shell decides whether to open
   * the preview, toggle selection (Cmd/Ctrl-click), etc.
   */
  onCardClick: (asset: Asset, event: React.MouseEvent) => void;
  onContextMenu: (asset: Asset, event: React.MouseEvent) => void;
  onToggleSelect: (asset: Asset) => void;
  onDelete: (asset: Asset) => void;
  /** Opens the seamless-loop finder dialog. Audio assets only. */
  onFindLoop?: (asset: Asset) => void;
}) {
  const isAudio = asset.asset_type === "music";
  const isVisual =
    asset.asset_type === "image" ||
    asset.asset_type === "thumbnail" ||
    asset.asset_type === "video" ||
    asset.asset_type === "composed";

  // ``file_exists === false`` means the row points at a file that's
  // been deleted out from under it (often by manual cleanup in
  // Windows Explorer). Dim the card + show a "Missing file" badge so
  // the user can review and decide whether to delete the row or
  // restore the file. Any render touching this asset would fail; the
  // visual nudge surfaces it before that happens.
  const isMissing = asset.file_exists === false;

  return (
    <Card
      className={cn(
        "group relative",
        isVisual && "cursor-pointer",
        isNowPlaying && "ring-1 ring-primary/50",
        isSelected && "ring-2 ring-primary",
        isMissing && "border-destructive/40 bg-destructive/5 opacity-70",
      )}
      data-asset-card
      onClick={(e) => onCardClick(asset, e)}
      onContextMenu={(e) => onContextMenu(asset, e)}
    >
      {/* Selection checkbox — top-left corner. Always visible when this
          card is selected; otherwise appears on group hover so the grid
          stays clean for users who never multi-select. */}
      <button
        type="button"
        aria-label={isSelected ? "Deselect" : "Select"}
        className={cn(
          "absolute left-2 top-2 z-10 flex size-5 items-center justify-center rounded border transition-opacity",
          isSelected
            ? "border-primary bg-primary text-primary-foreground opacity-100"
            : "border-border bg-background/80 opacity-0 group-hover:opacity-100",
        )}
        onClick={(e) => {
          e.stopPropagation();
          onToggleSelect(asset);
        }}
      >
        {isSelected && <span className="text-[11px] leading-none">✓</span>}
      </button>
      <CardContent className="flex items-start gap-3">
        {/* Thumbnail / icon */}
        <div className="relative flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
          {(asset.asset_type === "image" || asset.asset_type === "thumbnail") &&
          asset.file_url ? (
            <img
              src={asset.file_url}
              alt={asset.filename}
              className="size-12 rounded-lg object-cover"
            />
          ) : (
            <AssetTypeIcon type={asset.asset_type} />
          )}

          {/* Play overlay on thumbnails for videos */}
          {(asset.asset_type === "video" ||
            asset.asset_type === "composed") && (
            <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
              <Play className="size-5 text-white" />
            </div>
          )}

          {/* Zoom overlay on image thumbnails */}
          {(asset.asset_type === "image" || asset.asset_type === "thumbnail") &&
            asset.file_url && (
              <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <Maximize2 className="size-4 text-white" />
              </div>
            )}
        </div>

        {/* Info */}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium">
            {asset.title || asset.filename}
          </p>
          {asset.title && (
            <p className="truncate text-[10px] text-muted-foreground">
              {asset.filename}
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="outline" className="text-[10px]">
              {asset.asset_type}
            </Badge>
            {isMissing && (
              <Badge
                variant="outline"
                className="gap-1 border-destructive/50 text-[10px] text-destructive"
                title="The file at this asset's path is gone from disk. Renders that use this asset will fail. Delete the row or restore the file."
              >
                <AlertTriangle className="size-3" />
                Missing file
              </Badge>
            )}
            {asset.file_size ? (
              <span className="text-xs text-muted-foreground">
                {sharedFormatFileSize(asset.file_size)}
              </span>
            ) : null}
            {asset.duration_seconds ? (
              <span className="text-xs text-muted-foreground">
                {sharedFormatDuration(asset.duration_seconds)}
              </span>
            ) : null}
            {asset.folder_name && nav.kind !== "folder" && (
              <Badge variant="secondary" className="text-[10px]">
                {asset.folder_name}
              </Badge>
            )}
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">
            {channelName} --{" "}
            {formatDistanceToNow(new Date(asset.created_at))} ago
          </p>
        </div>

        {/* Actions */}
        <div className="flex shrink-0 flex-col gap-1">
          {isAudio && asset.file_url && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => onPlay(asset, e)}
            >
              {isNowPlaying ? (
                <Pause className="size-3 text-primary" />
              ) : (
                <Play className="size-3" />
              )}
            </Button>
          )}
          {isAudio && asset.file_url && onFindLoop && (
            <Button
              variant="ghost"
              size="icon-xs"
              className="opacity-0 transition-opacity group-hover:opacity-100"
              title="Find seamless loop point"
              onClick={(e) => {
                e.stopPropagation();
                onFindLoop(asset);
              }}
            >
              <Repeat className="size-3" />
            </Button>
          )}
          {isVisual && asset.file_url && (
            <Button
              variant="ghost"
              size="icon-xs"
              onClick={(e) => {
                e.stopPropagation();
                onPreview(asset);
              }}
            >
              <Eye className="size-3" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon-xs"
            className="opacity-0 transition-opacity group-hover:opacity-100"
            onClick={(e) => {
              e.stopPropagation();
              onDelete(asset);
            }}
          >
            <Trash2 className="size-3 text-destructive" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
