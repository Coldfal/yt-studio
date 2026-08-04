/**
 * Library page shell.
 *
 * Owns cross-component state (nav selection, dialog targets, bulk
 * selection set) and routes it down to the sidebar + grid + dialogs
 * under ``./library/``. Rendering of individual rows/tiles/menus lives
 * in the per-component files there — this file is the orchestrator.
 */
import { useCallback, useEffect, useState, lazy, Suspense } from "react";
import { useSearchParams } from "react-router-dom";
import { FolderOpen, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmptyState } from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useAssets,
  useDeleteAsset,
  useFolders,
  useCreateFolder,
  useRenameFolder,
  useDeleteFolder,
  useMoveAssets,
  useReassignAssetsChannel,
  useReassignAssetsRole,
  useReconcileAssets,
  useScanDiskForAssets,
} from "@/hooks/use-assets";
import { useChannels } from "@/hooks/use-channels";
import { cn } from "@/lib/utils";
import type { Asset, AssetFolder } from "@/types/index";
import { useMediaPlayer, type MediaTrack } from "@/contexts/media-player";
import PreviewModal from "@/components/media/PreviewModal";
import { YouTubeDownloadDialog } from "@/pages/library/dialogs/YouTubeDownloadDialog";
import { MergeAudioDialog } from "@/pages/library/dialogs/MergeAudioDialog";
import { UploadDialog } from "@/pages/library/dialogs/UploadDialog";
import {
  DeleteAssetConfirmDialog,
  DeleteFolderConfirmDialog,
  MoveToFolderDialog,
  NewFolderDialog,
  ReassignChannelDialog,
  RenameFolderDialog,
} from "@/pages/library/dialogs/AssetDialogs";
import { CATEGORIES, type NavSelection } from "@/pages/library/categories";
import { Sidebar } from "@/pages/library/components/Sidebar";
import {
  ContextMenu,
  type ContextMenuState,
} from "@/pages/library/components/ContextMenu";
import { AssetCard } from "@/pages/library/components/AssetCard";
import { LoopFinderDialog } from "@/pages/library/dialogs/LoopFinderDialog";
import { AssetsToolbar } from "@/pages/library/components/AssetsToolbar";
import { BulkActionBar } from "@/pages/library/components/BulkActionBar";
import { LoadingSkeleton } from "@/pages/library/components/LoadingSkeleton";
import { SetsTab } from "@/components/library/SetsTab";

function assetToTrack(asset: Asset): MediaTrack {
  return {
    id: asset.id,
    title: asset.title || asset.filename,
    subtitle: asset.description || undefined,
    url: asset.file_url,
    duration: asset.duration_seconds ?? undefined,
    type: asset.asset_type === "music" ? "audio" : "video",
    asset,
  };
}

function AssetsPageInner() {
  // -- Navigation state --
  // The Library is channel-first. ``nav`` carries channel + category +
  // folder in one shape; the shell derives query params for ``useAssets``
  // from it. URL syncs via ``?channel_id=N&category=K&folder_id=F`` so
  // links are bookmarkable.
  const [navParams, setNavParams] = useSearchParams();
  const nav: NavSelection = (() => {
    const channelRaw = navParams.get("channel_id");
    if (!channelRaw) return { kind: "all" } as NavSelection;
    const channelId = parseInt(channelRaw, 10);
    if (Number.isNaN(channelId)) return { kind: "all" } as NavSelection;
    const folderRaw = navParams.get("folder_id");
    const categoryKey = navParams.get("category");
    if (folderRaw && categoryKey) {
      const folderId = parseInt(folderRaw, 10);
      if (!Number.isNaN(folderId)) {
        return {
          kind: "folder",
          channelId,
          categoryKey,
          folderId,
          folderName: navParams.get("folder_name") ?? "",
        };
      }
    }
    if (categoryKey) {
      return { kind: "category", channelId, categoryKey };
    }
    return { kind: "channel", channelId };
  })();

  const setNav = (next: NavSelection) => {
    if (next.kind === "all") {
      navParams.delete("channel_id");
      navParams.delete("category");
      navParams.delete("folder_id");
      navParams.delete("folder_name");
    } else if (next.kind === "channel") {
      navParams.set("channel_id", String(next.channelId));
      navParams.delete("category");
      navParams.delete("folder_id");
      navParams.delete("folder_name");
    } else if (next.kind === "category") {
      navParams.set("channel_id", String(next.channelId));
      navParams.set("category", next.categoryKey);
      navParams.delete("folder_id");
      navParams.delete("folder_name");
    } else {
      navParams.set("channel_id", String(next.channelId));
      navParams.set("category", next.categoryKey);
      navParams.set("folder_id", String(next.folderId));
      navParams.set("folder_name", next.folderName);
    }
    setNavParams(navParams, { replace: true });
  };

  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  // -- Dialog state --
  const [uploadOpen, setUploadOpen] = useState(false);
  const [ytOpen, setYtOpen] = useState(false);
  const [mergeOpen, setMergeOpen] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<Asset | null>(null);
  const [moveTarget, setMoveTarget] = useState<Asset | null>(null);
  const [reassignTarget, setReassignTarget] = useState<Asset | null>(null);
  // New-folder dialog target — folders are scoped to (channelId, categoryKey)
  // post-redesign, so the dialog needs both. ``null`` = closed.
  const [newFolderTarget, setNewFolderTarget] = useState<
    { channelId: number; categoryKey: string } | null
  >(null);
  const [renameFolderTarget, setRenameFolderTarget] =
    useState<AssetFolder | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] =
    useState<AssetFolder | null>(null);

  // -- Preview state --
  const [previewAsset, setPreviewAsset] = useState<Asset | null>(null);
  const [loopTarget, setLoopTarget] = useState<Asset | null>(null);

  // -- Context menu state --
  const [ctxMenu, setCtxMenu] = useState<ContextMenuState | null>(null);

  // -- Multi-select state. Drives the floating bulk-action bar at the
  //    bottom and the per-card checkbox overlay. Cleared on tab change
  //    so selection doesn't survive a navigation that hides items. --
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };
  const clearSelection = () => setSelectedIds(new Set());
  // -- Bulk action targets --
  const [bulkReassignOpen, setBulkReassignOpen] = useState(false);
  const [bulkDeleteOpen, setBulkDeleteOpen] = useState(false);

  // -- Image-role sub-filter. ``null`` = show all images on the
  //    Images tab; otherwise restrict to assets with this exact role
  //    (background / thumbnail / overlay / reference). Reset whenever
  //    the user navigates away from the Images category. --
  const [roleFilter, setRoleFilter] = useState<
    "background" | "thumbnail" | "overlay" | "reference" | null
  >(null);
  useEffect(() => {
    // Image-role filter is only meaningful inside the Images category.
    // Reset to "all roles" when leaving so the next visit defaults clean.
    if (nav.kind !== "category" || nav.categoryKey !== "image") {
      setRoleFilter(null);
    }
  }, [nav]);

  // -- Media player --
  const mediaPlayer = useMediaPlayer();

  // -- Derive query params from nav state --
  const navChannelId =
    nav.kind === "all" ? undefined : nav.channelId;

  const selectedType = (() => {
    if (nav.kind !== "category" && nav.kind !== "folder") return undefined;
    const cat = CATEGORIES.find((c) => c.key === nav.categoryKey);
    // If the category has exactly one type, filter by it. Otherwise use
    // the category key — for "image" we want both image + thumbnail and
    // filter client-side.
    if (cat && cat.types.length === 1) return cat.types[0];
    return undefined;
  })();

  const selectedFolderId = nav.kind === "folder" ? nav.folderId : undefined;

  // -- Data hooks --
  const { data: channels } = useChannels();
  // Pull ALL folders so the sidebar can group by channel, then by type.
  const { data: allFolders } = useFolders();
  const {
    data: assets,
    isLoading,
    error,
  } = useAssets({
    channel_id: navChannelId,
    asset_type: selectedType,
    folder_id: selectedFolderId,
  });

  // Sidebar totals — fetch every asset once (id + channel_id + asset_type
  // + folder_id are tiny per row) so we can compute (a) per-channel total
  // and (b) per (channel, category) total without N round-trips. The
  // existing useAssets({}) call below already pulls everything, so we
  // reuse it.
  const deleteAsset = useDeleteAsset();
  const createFolder = useCreateFolder();
  const renameFolder = useRenameFolder();
  const deleteFolder = useDeleteFolder();
  const moveAssets = useMoveAssets();
  const reassignChannel = useReassignAssetsChannel();
  const reassignRole = useReassignAssetsRole();
  const reconcileAssets = useReconcileAssets();
  const scanDisk = useScanDiskForAssets();

  const channelList = channels ?? [];
  const folderList = allFolders ?? [];

  // Client-side filter for multi-type categories (images = image + thumbnail)
  // PLUS the per-image-role sub-filter when the user has picked one.
  const filteredAssets = (() => {
    if (!assets) return [];
    let out = assets;
    if (nav.kind === "category" || nav.kind === "folder") {
      const cat = CATEGORIES.find((c) => c.key === nav.categoryKey);
      if (cat && cat.types.length > 1) {
        out = out.filter((a) => cat.types.includes(a.asset_type));
      }
    }
    if (roleFilter !== null) {
      out = out.filter((a) => a.role === roleFilter);
    }
    return out;
  })();

  /** True iff the current selection contains at least one image asset.
   *  Drives the "Set role" dropdown in the bulk action bar. */
  const selectionHasImage = (() => {
    if (selectedIds.size === 0) return false;
    for (const a of filteredAssets) {
      if (selectedIds.has(a.id) && a.asset_type === "image") return true;
    }
    return false;
  })();

  const handleBulkSetRole = async (
    role: "background" | "thumbnail" | "overlay" | "reference" | null,
  ) => {
    if (selectedIds.size === 0) return;
    try {
      await reassignRole.mutateAsync({
        asset_ids: Array.from(selectedIds),
        role,
      });
      toast.success(
        role === null
          ? `Cleared role on ${selectedIds.size} asset${selectedIds.size === 1 ? "" : "s"}`
          : `Set ${selectedIds.size} asset${selectedIds.size === 1 ? "" : "s"} to ${role}`,
      );
      clearSelection();
    } catch {
      toast.error("Failed to update role");
    }
  };

  // For the merge dialog AND the sidebar's per-channel/per-category counts,
  // pull every asset once. The shape we read is small (id + channel_id
  // + asset_type) so this stays cheap even at thousands of rows.
  const { data: allAssets } = useAssets({});
  const allAudioAssets = (allAssets ?? []).filter(
    (a) => a.asset_type === "music",
  );

  // Sidebar count tables — channel header shows the channel total,
  // each category row shows that channel's slice for that asset_type.
  const channelTotals: Record<number, number> = {};
  const channelTypeTotals: Record<string, number> = {};
  if (allAssets) {
    for (const a of allAssets) {
      channelTotals[a.channel_id] = (channelTotals[a.channel_id] ?? 0) + 1;
      // Map asset_type → categoryKey ("thumbnail" rolls into "image")
      let catKey: string | null = null;
      for (const c of CATEGORIES) {
        if (c.types.includes(a.asset_type)) {
          catKey = c.key;
          break;
        }
      }
      if (catKey) {
        const k = `${a.channel_id}:${catKey}`;
        channelTypeTotals[k] = (channelTypeTotals[k] ?? 0) + 1;
      }
    }
  }

  const channelName = (channelId: number) =>
    channelList.find((c) => c.id === channelId)?.name ?? "Unknown";

  // -- Handlers --
  const handleDelete = async () => {
    if (!deleteTarget) return;
    try {
      await deleteAsset.mutateAsync(deleteTarget.id);
      toast.success("Asset deleted");
    } catch {
      toast.error("Failed to delete asset");
    }
    setDeleteTarget(null);
  };

  const handleMove = async (folderId: number | null) => {
    if (!moveTarget) return;
    // If the user has a selection, treat the dialog as a bulk-move
    // entry point. The MoveToFolderDialog only knows about one
    // ``moveTarget`` asset (the trigger), but the action applies to
    // every selected id — much better UX than asking the user to
    // open the dialog N times.
    const ids =
      selectedIds.size > 0 ? Array.from(selectedIds) : [moveTarget.id];
    try {
      await moveAssets.mutateAsync({
        asset_ids: ids,
        folder_id: folderId,
      });
      toast.success(
        ids.length === 1
          ? folderId
            ? "Asset moved to folder"
            : "Asset removed from folder"
          : `${ids.length} assets moved`,
      );
      if (selectedIds.size > 0) clearSelection();
    } catch {
      toast.error("Failed to move asset");
    }
    setMoveTarget(null);
  };

  const handleReassignChannel = async (channelId: number) => {
    if (!reassignTarget) return;
    try {
      await reassignChannel.mutateAsync({
        asset_ids: [reassignTarget.id],
        channel_id: channelId,
      });
      toast.success("Asset reassigned to channel");
    } catch {
      toast.error("Failed to reassign asset");
    }
    setReassignTarget(null);
  };

  // ── Bulk action handlers ──────────────────────────────────────────
  // The selection set is the source of truth; each handler reads from
  // it and clears on success. Endpoints already accept `asset_ids: []`.

  const handleBulkReassign = async (channelId: number) => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    try {
      await reassignChannel.mutateAsync({
        asset_ids: ids,
        channel_id: channelId,
      });
      toast.success(
        `${ids.length} asset${ids.length === 1 ? "" : "s"} reassigned`,
      );
      clearSelection();
    } catch {
      toast.error("Failed to reassign selected assets");
    }
    setBulkReassignOpen(false);
  };

  const handleBulkDelete = async () => {
    const ids = Array.from(selectedIds);
    if (ids.length === 0) return;
    let ok = 0;
    let fail = 0;
    // No bulk-delete endpoint yet — loop. Fast enough for the
    // typical 5–50 selection size; revisit if a user picks 500+.
    for (const id of ids) {
      try {
        await deleteAsset.mutateAsync(id);
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    if (ok > 0) toast.success(`Deleted ${ok} asset${ok === 1 ? "" : "s"}`);
    if (fail > 0)
      toast.error(`Failed to delete ${fail} asset${fail === 1 ? "" : "s"}`);
    clearSelection();
    setBulkDeleteOpen(false);
  };

  const handleCreateFolder = async (name: string) => {
    if (!newFolderTarget) return;
    try {
      await createFolder.mutateAsync({
        channel_id: newFolderTarget.channelId,
        asset_type: newFolderTarget.categoryKey,
        name,
      });
      toast.success("Folder created");
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Failed to create folder");
    }
    setNewFolderTarget(null);
  };

  const handleRenameFolder = async (vars: {
    name: string;
    pair_group: string | null;
  }) => {
    if (!renameFolderTarget) return;
    try {
      await renameFolder.mutateAsync({
        id: renameFolderTarget.id,
        name: vars.name,
        pair_group: vars.pair_group,
      });
      toast.success("Folder saved");
    } catch {
      toast.error("Failed to save folder");
    }
    setRenameFolderTarget(null);
  };

  const handleDeleteFolder = async () => {
    if (!deleteFolderTarget) return;
    try {
      await deleteFolder.mutateAsync(deleteFolderTarget.id);
      toast.success("Folder deleted");
      // If we were viewing this folder, fall back to its category view.
      if (nav.kind === "folder" && nav.folderId === deleteFolderTarget.id) {
        setNav({
          kind: "category",
          channelId: deleteFolderTarget.channel_id,
          categoryKey: deleteFolderTarget.asset_type,
        });
      }
    } catch {
      toast.error("Failed to delete folder");
    }
    setDeleteFolderTarget(null);
  };

  // ── Clean up rows whose underlying file is gone from disk ───────────
  // Scoped to the current view so the user only deletes rows they're
  // actually looking at — never goes wider than what's visible. The
  // backend reconcile endpoint accepts ``channel_id`` + ``asset_type``
  // filters; we forward what the nav has set.
  const handleCleanupMissing = async () => {
    const missingCount = filteredAssets.filter(
      (a) => a.file_exists === false,
    ).length;
    if (missingCount === 0) return;

    const scopeLabel =
      nav.kind === "all"
        ? "all channels"
        : `${channelName(nav.channelId)}${
            "categoryKey" in nav ? ` / ${nav.categoryKey}` : ""
          }`;
    const confirmed = window.confirm(
      `Delete ${missingCount} database row${missingCount === 1 ? "" : "s"} ` +
        `whose file is missing on disk?\n\n` +
        `Scope: ${scopeLabel}\n\n` +
        `Asset files are NOT touched (they're already gone). Only the ` +
        `dangling DB rows are removed. Cannot be undone.`,
    );
    if (!confirmed) return;

    try {
      const params: { channel_id?: number; asset_type?: string } = {};
      if (nav.kind !== "all") params.channel_id = nav.channelId;
      if (nav.kind === "category" || nav.kind === "folder") {
        // Translate categoryKey → asset_type. "image" category maps to
        // both "image" and "thumbnail" so don't narrow there — let the
        // backend scan all of the channel's missing rows for this scope.
        if (nav.categoryKey !== "image") {
          params.asset_type = nav.categoryKey;
        }
      }
      const result = await reconcileAssets.mutateAsync(params);
      if (result.removed > 0) {
        toast.success(
          `Removed ${result.removed} missing row${result.removed === 1 ? "" : "s"}`,
        );
      } else {
        toast.info("Nothing to clean up");
      }
      clearSelection();
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Cleanup failed");
    }
  };

  // ── Scan disk for orphan files (manually-dropped audio/images) ───────
  // Inverse of cleanup: looks for files in this channel's folders that
  // don't have a DB row yet, and creates rows for them. So a user can
  // drag mp3s into ``data/assets/2/music/`` from Windows Explorer and
  // hit "Scan disk" to make them appear in the Library.
  //
  // Scoped to the current view's channel + asset_type, same shape as the
  // cleanup button. Won't run on the cross-channel "all" view — the
  // toolbar disables the button when ``scanDiskAvailable=false``.
  const handleScanDisk = async () => {
    if (nav.kind === "all") return;
    const params: { channel_id: number; asset_type?: string } = {
      channel_id: nav.channelId,
    };
    if (nav.kind === "category" || nav.kind === "folder") {
      // "image" category covers both image + thumbnail folders; let the
      // backend default (scan all type folders) when the user is on the
      // image category, since asset_type filter is single-string.
      if (nav.categoryKey !== "image" && nav.categoryKey !== "composed") {
        params.asset_type = nav.categoryKey;
      }
    }
    try {
      const result = await scanDisk.mutateAsync(params);
      if (result.adopted > 0) {
        toast.success(
          `Adopted ${result.adopted} new file${result.adopted === 1 ? "" : "s"}` +
            (result.skipped_existing > 0
              ? ` (${result.skipped_existing} already known)`
              : ""),
        );
      } else if (result.scanned === 0) {
        toast.info("No files in that folder to scan.");
      } else {
        toast.info(
          `Scanned ${result.scanned} file${result.scanned === 1 ? "" : "s"} ` +
            `— all already in the library.`,
        );
      }
    } catch (err: any) {
      const detail = err?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Scan failed");
    }
  };

  const closeCtxMenu = useCallback(() => setCtxMenu(null), []);

  const toggleExpanded = (key: string) => {
    setExpanded((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // -- Breadcrumb label --
  const breadcrumb = (() => {
    if (nav.kind === "all") return "All Assets";
    const ch = channelName(nav.channelId);
    if (nav.kind === "channel") return ch;
    const cat = CATEGORIES.find((c) => c.key === nav.categoryKey);
    const catLabel = cat?.label ?? nav.categoryKey;
    if (nav.kind === "category") return `${ch} / ${catLabel}`;
    return `${ch} / ${catLabel} / ${nav.folderName}`;
  })();

  // ── Per-card handlers wired into AssetCard ──────────────────────────
  const handleCardPlay = (asset: Asset, e: React.MouseEvent) => {
    e.stopPropagation();
    if (mediaPlayer.track?.id === asset.id && mediaPlayer.playing) {
      mediaPlayer.togglePlay();
      return;
    }
    if (asset.asset_type === "music") {
      // Build playlist from all visible music assets
      const musicTracks = filteredAssets
        .filter((a) => a.asset_type === "music" && a.file_url)
        .map(assetToTrack);
      const startIdx = musicTracks.findIndex((t) => t.id === asset.id);
      mediaPlayer.playList(musicTracks, startIdx >= 0 ? startIdx : 0);
    }
  };

  const handleCardClick = (asset: Asset, e: React.MouseEvent) => {
    // Cmd/Ctrl-click toggles selection without opening the preview —
    // power-user shortcut so the user doesn't always have to aim at the
    // tiny checkbox.
    if (e.metaKey || e.ctrlKey) {
      e.stopPropagation();
      toggleSelect(asset.id);
      return;
    }
    const isVisual =
      asset.asset_type === "image" ||
      asset.asset_type === "thumbnail" ||
      asset.asset_type === "video" ||
      asset.asset_type === "composed";
    if (isVisual && asset.file_url) {
      setPreviewAsset(asset);
    }
  };

  const handleCardContextMenu = (asset: Asset, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({
      x: e.clientX,
      y: e.clientY,
      kind: { type: "asset", asset },
    });
  };

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  return (
    <div className="flex h-full gap-0">
      <Sidebar
        nav={nav}
        setNav={setNav}
        expanded={expanded}
        toggleExpanded={toggleExpanded}
        folders={folderList}
        channels={channelList}
        channelTotals={channelTotals}
        channelTypeTotals={channelTypeTotals}
        onCategoryContextMenu={(e, channelId, categoryKey) => {
          e.preventDefault();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            kind: { type: "category", channelId, categoryKey },
          });
        }}
        onFolderContextMenu={(e, folder) => {
          e.preventDefault();
          setCtxMenu({
            x: e.clientX,
            y: e.clientY,
            kind: { type: "folder", folder },
          });
        }}
        onCategoryNewFolder={(channelId, categoryKey) =>
          setNewFolderTarget({ channelId, categoryKey })
        }
      />

      {/* ── Right Panel ── */}
      <div className="flex flex-1 flex-col overflow-hidden">
        <AssetsToolbar
          breadcrumb={breadcrumb}
          count={filteredAssets.length}
          missingCount={
            filteredAssets.filter((a) => a.file_exists === false).length
          }
          cleanupPending={reconcileAssets.isPending}
          scanPending={scanDisk.isPending}
          scanDiskAvailable={nav.kind !== "all"}
          isLoading={isLoading}
          onCleanupMissing={handleCleanupMissing}
          onScanDisk={handleScanDisk}
          onMergeOpen={() => setMergeOpen(true)}
          onYouTubeOpen={() => setYtOpen(true)}
          onUploadOpen={() => setUploadOpen(true)}
        />

        {/* Image-role sub-filter pills. Only shown when the user is
            in the Images category (or a folder under it). Lets the
            operator focus on Backgrounds / Thumbnails / Overlays /
            Reference without leaving the page. */}
        {(nav.kind === "category" || nav.kind === "folder") &&
          nav.categoryKey === "image" && (
            <div className="flex items-center gap-1.5 border-b border-border bg-muted/30 px-4 py-2">
              <span className="text-[11px] font-medium text-muted-foreground">
                Role:
              </span>
              {[
                { key: null, label: "All" },
                { key: "background" as const, label: "🎬 Backgrounds" },
                { key: "thumbnail" as const, label: "🖼️ Thumbnails" },
                { key: "overlay" as const, label: "✨ Overlays" },
                { key: "reference" as const, label: "📝 Reference" },
              ].map((opt) => (
                <button
                  key={opt.label}
                  type="button"
                  onClick={() => setRoleFilter(opt.key)}
                  className={cn(
                    "rounded-full px-3 py-1 text-[11px] transition",
                    roleFilter === opt.key
                      ? "bg-primary text-primary-foreground"
                      : "bg-background text-muted-foreground hover:bg-muted hover:text-foreground border border-border",
                  )}
                >
                  {opt.label}
                </button>
              ))}
              <span className="ml-auto text-[10px] text-muted-foreground">
                Quick Generate only picks "Background" images.
              </span>
            </div>
          )}

        {/* Content area */}
        <div
          className="flex-1 overflow-y-auto p-4"
          onContextMenu={(e) => {
            // Only fire when clicking empty space (not on a card)
            if ((e.target as HTMLElement).closest("[data-asset-card]")) return;
            e.preventDefault();
            // If a category is selected, offer "New Folder"
            if (nav.kind === "category") {
              setCtxMenu({
                x: e.clientX,
                y: e.clientY,
                kind: {
                  type: "category",
                  channelId: nav.channelId,
                  categoryKey: nav.categoryKey,
                },
              });
            }
          }}
        >
          {isLoading && <LoadingSkeleton />}

          {error && (
            <Card>
              <CardContent className="py-8 text-center">
                <p className="text-sm text-destructive">
                  Failed to load assets. Please try again.
                </p>
              </CardContent>
            </Card>
          )}

          {!isLoading && !error && filteredAssets.length === 0 && (
            <EmptyState
              icon={FolderOpen}
              title={
                nav.kind === "all"
                  ? "No assets yet"
                  : nav.kind === "channel"
                    ? `No assets for ${channelName(nav.channelId)}`
                    : "This location is empty"
              }
              description={
                nav.kind === "all"
                  ? "Upload audio or images to use in your projects, or import an entire folder of music in one go from the New Project wizard."
                  : nav.kind === "channel"
                    ? `${channelName(nav.channelId)} hasn't had any music or images uploaded yet. Use the Upload button or the New Project wizard's Music step.`
                    : "Move existing assets here, or upload new ones."
              }
              actionLabel="Upload asset"
              onAction={() => setUploadOpen(true)}
            />
          )}

          {!isLoading && filteredAssets.length > 0 && (
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {filteredAssets.map((asset) => (
                <AssetCard
                  key={asset.id}
                  asset={asset}
                  channelName={channelName(asset.channel_id)}
                  isNowPlaying={
                    mediaPlayer.track?.id === asset.id && mediaPlayer.playing
                  }
                  isSelected={selectedIds.has(asset.id)}
                  nav={nav}
                  onPlay={handleCardPlay}
                  onPreview={(a) => setPreviewAsset(a)}
                  onCardClick={handleCardClick}
                  onContextMenu={handleCardContextMenu}
                  onToggleSelect={(a) => toggleSelect(a.id)}
                  onDelete={(a) => setDeleteTarget(a)}
                  onFindLoop={(a) => setLoopTarget(a)}
                />
              ))}
            </div>
          )}
        </div>
      </div>

      {/* ── Context Menu ── */}
      {ctxMenu && (
        <ContextMenu
          state={ctxMenu}
          onClose={closeCtxMenu}
          onNewFolder={(channelId, categoryKey) =>
            setNewFolderTarget({ channelId, categoryKey })
          }
          onRenameFolder={(folder) => setRenameFolderTarget(folder)}
          onDeleteFolder={(folder) => setDeleteFolderTarget(folder)}
          onDeleteAsset={(asset) => setDeleteTarget(asset)}
          onMoveAsset={(asset) => setMoveTarget(asset)}
          onReassignChannel={(asset) => setReassignTarget(asset)}
        />
      )}

      {/* ── Dialogs ── */}
      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        channels={channelList}
      />

      <YouTubeDownloadDialog
        open={ytOpen}
        onOpenChange={setYtOpen}
        channels={channelList}
      />

      <MergeAudioDialog
        open={mergeOpen}
        onOpenChange={setMergeOpen}
        channels={channelList}
        audioAssets={allAudioAssets}
      />

      <LoopFinderDialog
        asset={loopTarget}
        open={!!loopTarget}
        onOpenChange={(v) => { if (!v) setLoopTarget(null); }}
      />

      <DeleteAssetConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => !open && setDeleteTarget(null)}
        asset={deleteTarget}
        onConfirm={handleDelete}
        isPending={deleteAsset.isPending}
      />

      <MoveToFolderDialog
        open={!!moveTarget}
        onOpenChange={(open) => !open && setMoveTarget(null)}
        asset={moveTarget}
        folders={folderList}
        onMove={handleMove}
        isPending={moveAssets.isPending}
      />

      <ReassignChannelDialog
        open={!!reassignTarget}
        onOpenChange={(open) => !open && setReassignTarget(null)}
        asset={reassignTarget}
        channels={channelList.map((c) => ({ id: c.id, name: c.name }))}
        onReassign={handleReassignChannel}
        isPending={reassignChannel.isPending}
      />

      <NewFolderDialog
        open={!!newFolderTarget}
        onOpenChange={(open) => !open && setNewFolderTarget(null)}
        channelName={
          newFolderTarget
            ? channelName(newFolderTarget.channelId)
            : ""
        }
        assetTypeLabel={
          newFolderTarget
            ? (CATEGORIES.find((c) => c.key === newFolderTarget.categoryKey)
                ?.label ?? newFolderTarget.categoryKey)
            : ""
        }
        onCreate={handleCreateFolder}
        isPending={createFolder.isPending}
      />

      <RenameFolderDialog
        open={!!renameFolderTarget}
        onOpenChange={(open) => !open && setRenameFolderTarget(null)}
        folder={renameFolderTarget}
        onRename={handleRenameFolder}
        isPending={renameFolder.isPending}
      />

      <DeleteFolderConfirmDialog
        open={!!deleteFolderTarget}
        onOpenChange={(open) => !open && setDeleteFolderTarget(null)}
        folder={deleteFolderTarget}
        onConfirm={handleDeleteFolder}
        isPending={deleteFolder.isPending}
      />

      {/* ── Preview Modal ── */}
      <PreviewModal
        asset={previewAsset}
        onClose={() => setPreviewAsset(null)}
      />

      {/* ── Bulk action bar ── */}
      <BulkActionBar
        selectedCount={selectedIds.size}
        deleteDisabled={deleteAsset.isPending}
        showRoleAction={selectionHasImage}
        onClear={clearSelection}
        onMove={() => {
          // Reuse the single-asset MoveToFolderDialog by stuffing
          // a synthetic "asset" with the right asset_type. First selected
          // sets the type — we only allow same-type bulk moves because
          // folders are type-scoped.
          const firstId = selectedIds.values().next().value as number;
          const first = filteredAssets.find((a) => a.id === firstId);
          if (first) setMoveTarget(first);
        }}
        onReassign={() => setBulkReassignOpen(true)}
        onSetRole={handleBulkSetRole}
        onDelete={() => setBulkDeleteOpen(true)}
      />

      {/* Bulk reassign — same dialog component, fed all selected ids
          + a synthetic "any" asset (only used to render the title
          and current-channel hint, which is shown as the channel of
          the first selected asset). */}
      <ReassignChannelDialog
        open={bulkReassignOpen}
        onOpenChange={setBulkReassignOpen}
        asset={
          // Show a synthetic asset that summarises the selection so
          // the dialog title reads naturally for bulk ops.
          selectedIds.size > 0
            ? ({
                id: -1,
                title: `${selectedIds.size} selected asset${
                  selectedIds.size === 1 ? "" : "s"
                }`,
                filename: "",
                channel_id:
                  filteredAssets.find((a) => selectedIds.has(a.id))
                    ?.channel_id ?? -1,
              } as unknown as Asset)
            : null
        }
        channels={channelList.map((c) => ({ id: c.id, name: c.name }))}
        onReassign={handleBulkReassign}
        isPending={reassignChannel.isPending}
      />

      {/* Bulk delete confirm — separate dialog from single-delete so
          the messaging can be specific. */}
      <Dialog open={bulkDeleteOpen} onOpenChange={setBulkDeleteOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              Delete {selectedIds.size} asset
              {selectedIds.size === 1 ? "" : "s"}?
            </DialogTitle>
            <DialogDescription>
              This permanently removes the selected files from disk and
              clears their rows from the library. Cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBulkDeleteOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleBulkDelete}
              disabled={deleteAsset.isPending}
            >
              <Trash2 className="size-3.5" />
              Delete {selectedIds.size}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

// Lazy-load the Uploads tab content so it doesn't inflate the initial bundle
const UploadsPage = lazy(() => import("@/pages/UploadsPage"));

/** Top-level Library page — Assets + Uploads in two tabs. */
export default function AssetsPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const tab = searchParams.get("tab") ?? "assets";

  const handleTabChange = (value: string) => {
    if (value === "assets") {
      searchParams.delete("tab");
    } else {
      searchParams.set("tab", value);
    }
    setSearchParams(searchParams, { replace: true });
  };

  return (
    <Tabs value={tab} onValueChange={handleTabChange} className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold">Library</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            All your media assets and upload history in one place.
          </p>
        </div>
        <TabsList>
          <TabsTrigger value="assets">Assets</TabsTrigger>
          <TabsTrigger value="sets">Sets</TabsTrigger>
          <TabsTrigger value="uploads">Uploads</TabsTrigger>
        </TabsList>
      </div>
      <TabsContent value="assets">
        <AssetsPageInner />
      </TabsContent>
      <TabsContent value="sets">
        <SetsTab />
      </TabsContent>
      <TabsContent value="uploads">
        <Suspense
          fallback={
            <div className="flex h-40 items-center justify-center text-muted-foreground">
              Loading…
            </div>
          }
        >
          <UploadsPage />
        </Suspense>
      </TabsContent>
    </Tabs>
  );
}
