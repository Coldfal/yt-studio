import {
  ChevronRight,
  Folder,
  FolderOpen,
  FolderPlus,
  Tv,
} from "lucide-react";
import type { AssetFolder } from "@/types/index";
import { CATEGORIES, type NavSelection } from "../categories";

/**
 * Channel-first left rail.
 *
 * Tree shape:
 *   - All Assets (cross-channel; rare but useful for bulk-reassign)
 *   - Per channel:
 *       - Music
 *           - <folders for (channel, music)>
 *       - Images
 *           - <folders for (channel, image)>
 *       - Videos
 *       - Composed
 *
 * Folders belong to a single (channel_id, asset_type) per the
 * post-redesign schema, so the tree shows each folder under exactly
 * one channel + category. Right-clicking a category opens a context
 * menu (handled in the shell) for "New folder"; right-clicking a
 * folder opens Rename / Delete.
 */
export function Sidebar({
  nav,
  setNav,
  expanded,
  toggleExpanded,
  folders,
  channels,
  channelTotals,
  channelTypeTotals,
  onCategoryContextMenu,
  onFolderContextMenu,
  onCategoryNewFolder,
}: {
  nav: NavSelection;
  setNav: (next: NavSelection) => void;
  expanded: Record<string, boolean>;
  toggleExpanded: (key: string) => void;
  folders: AssetFolder[];
  channels: { id: number; name: string }[];
  /** channel_id → total asset count (across all asset_types). */
  channelTotals: Record<number, number>;
  /**
   * "{channel_id}:{categoryKey}" → asset count.
   * categoryKey is one of "music" / "image" / "video" / "composed";
   * the "image" key counts both image + thumbnail.
   */
  channelTypeTotals: Record<string, number>;
  /**
   * Right-click on a category row.
   * The shell uses this to open the "New folder" context menu —
   * the category gives us the (channel_id, asset_type) for the new folder.
   */
  onCategoryContextMenu: (
    event: React.MouseEvent,
    channelId: number,
    categoryKey: string,
  ) => void;
  onFolderContextMenu: (
    event: React.MouseEvent,
    folder: AssetFolder,
  ) => void;
  /** Click on the "+ folder" hover button next to a category. */
  onCategoryNewFolder: (channelId: number, categoryKey: string) => void;
}) {
  return (
    <div className="flex w-64 shrink-0 flex-col border-r border-border bg-card">
      <div className="border-b border-border px-4 py-3">
        <h2 className="text-sm font-semibold text-foreground">Assets</h2>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {/* ── All Assets (cross-channel) ────────────────────────────── */}
        <button
          className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
            nav.kind === "all"
              ? "bg-accent text-accent-foreground"
              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
          }`}
          onClick={() => setNav({ kind: "all" })}
        >
          <FolderOpen className="size-4" />
          <span className="flex-1 text-left">All Assets</span>
        </button>

        <div className="my-2 border-t border-border" />

        {/* ── Per-channel sections ──────────────────────────────────── */}
        {channels.map((channel) => {
          const channelKey = `channel:${channel.id}`;
          const isChannelExpanded = expanded[channelKey] ?? true;
          const isChannelActive =
            nav.kind === "channel" && nav.channelId === channel.id;
          const total = channelTotals[channel.id] ?? 0;

          return (
            <div key={channel.id} className="mb-2">
              {/* Channel header */}
              <div
                className={`group flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer ${
                  isChannelActive
                    ? "bg-accent text-accent-foreground"
                    : "text-foreground hover:bg-accent/50"
                }`}
                onClick={() => {
                  setNav({ kind: "channel", channelId: channel.id });
                  if (!isChannelExpanded) toggleExpanded(channelKey);
                }}
              >
                <ChevronRight
                  className={`size-3 shrink-0 transition-transform ${
                    isChannelExpanded ? "rotate-90" : ""
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    toggleExpanded(channelKey);
                  }}
                />
                <Tv className="size-4 text-primary" />
                <span className="flex-1 truncate text-left font-medium">
                  {channel.name}
                </span>
                <span className="text-xs text-muted-foreground">{total}</span>
              </div>

              {/* Categories under this channel */}
              {isChannelExpanded && (
                <div className="ml-3 mt-0.5 space-y-0.5">
                  {CATEGORIES.map((cat) => {
                    const catKey = `channel:${channel.id}:${cat.key}`;
                    const isExpanded = expanded[catKey] ?? false;
                    const isCategoryActive =
                      nav.kind === "category" &&
                      nav.channelId === channel.id &&
                      nav.categoryKey === cat.key;

                    const categoryFolders = folders.filter(
                      (f) =>
                        f.channel_id === channel.id &&
                        f.asset_type === cat.key,
                    );
                    const totalForCat =
                      channelTypeTotals[`${channel.id}:${cat.key}`] ?? 0;

                    return (
                      <div key={cat.key}>
                        {/* Category row */}
                        <div
                          className={`group flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors cursor-pointer ${
                            isCategoryActive
                              ? "bg-accent text-accent-foreground"
                              : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                          }`}
                          onClick={() => {
                            setNav({
                              kind: "category",
                              channelId: channel.id,
                              categoryKey: cat.key,
                            });
                            if (!isExpanded) toggleExpanded(catKey);
                          }}
                          onContextMenu={(e) =>
                            onCategoryContextMenu(e, channel.id, cat.key)
                          }
                        >
                          <ChevronRight
                            className={`size-3 shrink-0 transition-transform ${
                              isExpanded ? "rotate-90" : ""
                            }`}
                            onClick={(e) => {
                              e.stopPropagation();
                              toggleExpanded(catKey);
                            }}
                          />
                          {cat.icon}
                          <span className="flex-1 text-left">{cat.label}</span>
                          <span className="text-[11px] text-muted-foreground">
                            {totalForCat}
                          </span>
                          <button
                            className="size-5 flex items-center justify-center rounded opacity-0 hover:bg-accent group-hover:opacity-100 transition-opacity"
                            onClick={(e) => {
                              e.stopPropagation();
                              onCategoryNewFolder(channel.id, cat.key);
                            }}
                            title="New folder"
                          >
                            <FolderPlus className="size-3" />
                          </button>
                        </div>

                        {/* Folder rows */}
                        {isExpanded && categoryFolders.length > 0 && (
                          <div className="ml-5 mt-0.5 space-y-0.5">
                            {categoryFolders.map((folder) => {
                              const isFolderActive =
                                nav.kind === "folder" &&
                                nav.folderId === folder.id;
                              return (
                                <button
                                  key={folder.id}
                                  className={`flex w-full items-center gap-2 rounded-md px-2 py-1 text-xs transition-colors ${
                                    isFolderActive
                                      ? "bg-accent text-accent-foreground"
                                      : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                                  }`}
                                  onClick={() =>
                                    setNav({
                                      kind: "folder",
                                      channelId: channel.id,
                                      categoryKey: cat.key,
                                      folderId: folder.id,
                                      folderName: folder.name,
                                    })
                                  }
                                  onContextMenu={(e) =>
                                    onFolderContextMenu(e, folder)
                                  }
                                >
                                  <Folder className="size-3.5" />
                                  <span className="flex-1 truncate text-left">
                                    {folder.name}
                                  </span>
                                  <span className="text-[11px] text-muted-foreground">
                                    {folder.asset_count}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          );
        })}
      </nav>
    </div>
  );
}
