import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { Asset, AssetFolder } from "@/types/index";

export function useAssets(params?: {
  channel_id?: number | string;
  asset_type?: string;
  /** Sub-classification for images. Pass "background" to filter the
   *  Quick Generate picker pool; "thumbnail" / "overlay" / "reference"
   *  for the corresponding library sub-tabs. */
  role?: string;
  source?: string;
  folder_id?: number | string;
}) {
  return useQuery<Asset[]>({
    queryKey: ["assets", params],
    queryFn: async () => {
      const { data } = await api.get("/assets", { params });
      return data;
    },
  });
}

export function useAsset(id: number | string | undefined) {
  return useQuery<Asset>({
    queryKey: ["assets", id],
    queryFn: async () => {
      const { data } = await api.get(`/assets/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export function useUploadAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (formData: FormData) => {
      const { data } = await api.post("/assets/upload", formData, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      return data as Asset;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}

export function useDeleteAsset() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/assets/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/**
 * Scan disk for files dropped into the channel's folders that don't
 * have an Asset row yet — creates rows for them so they show up in
 * the Library. The inverse of ``useReconcileAssets``.
 *
 * ``channel_id`` is required (we never auto-adopt across every channel
 * at once). ``asset_type`` is optional; when omitted, every type
 * subfolder under the channel gets scanned.
 *
 * Idempotent: re-running skips files that already have a row.
 */
export function useScanDiskForAssets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      channel_id: number;
      asset_type?: string;
    }) => {
      const { data } = await api.post("/assets/scan-disk", null, { params });
      return data as {
        scanned: number;
        adopted: number;
        skipped_existing: number;
        skipped_unsupported: number;
        adopted_ids: number[];
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}

/**
 * Reconcile = delete Asset ROWS whose underlying file is missing on disk.
 * Scope is optional: when set, only rows matching ``channel_id`` and/or
 * ``asset_type`` are inspected. Asset files on disk are NEVER touched —
 * this only cleans up dangling DB rows.
 */
export function useReconcileAssets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (params?: {
      channel_id?: number;
      asset_type?: string;
    }) => {
      const { data } = await api.post("/assets/reconcile", null, { params });
      return data as {
        scanned: number;
        removed: number;
        removed_ids: number[];
      };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

// ── Folder hooks ──────────────────────────────────────────────────────

export function useFolders(params?: {
  channel_id?: number | string;
  asset_type?: string;
}) {
  return useQuery<AssetFolder[]>({
    queryKey: ["folders", params],
    queryFn: async () => {
      const cleaned = params
        ? Object.fromEntries(
            Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== ""),
          )
        : undefined;
      const { data } = await api.get("/assets/folders", {
        params: cleaned,
      });
      return data;
    },
  });
}

export function useCreateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      channel_id: number;
      asset_type: string;
      name: string;
    }) => {
      const { data } = await api.post("/assets/folders", payload);
      return data as AssetFolder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

export function useRenameFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: number;
      name?: string;
      /** Folder-pairing tag. Pass empty string or null to clear. */
      pair_group?: string | null;
    }) => {
      const body: Record<string, unknown> = {};
      if (vars.name !== undefined) body.name = vars.name;
      if (vars.pair_group !== undefined) body.pair_group = vars.pair_group;
      const { data } = await api.put(`/assets/folders/${vars.id}`, body);
      return data as AssetFolder;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/assets/folders/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}

export function useMoveAssets() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      asset_ids: number[];
      folder_id: number | null;
    }) => {
      const { data } = await api.put("/assets/move", payload);
      return data as Asset[];
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/**
 * Reassign one or more assets to a different channel.
 *
 * Moves the file on disk from ``{old_channel}/{type}/...`` →
 * ``{new_channel}/{type}/...`` and updates the DB row. Closes the
 * gap surfaced earlier where the YouTube download flow tagged
 * MP3s with the wrong channel and there was no UI to fix it.
 */
export function useReassignAssetsChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      asset_ids: number[];
      channel_id: number;
    }) => {
      const { data } = await api.put("/assets/reassign-channel", payload);
      return data as Asset[];
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

/**
 * Bulk re-classify the role of one or more image assets. Pass
 * ``role: null`` to clear back to unclassified.
 *
 * Phase 0 of the farm redesign — Quick Generate's background picker
 * filters ``role='background'`` so a thumbnail or overlay never gets
 * rendered as a video background. The operator uses this to fix
 * historically miscategorised images.
 */
export function useReassignAssetsRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      asset_ids: number[];
      role: "background" | "thumbnail" | "overlay" | "reference" | null;
    }) => {
      const { data } = await api.put("/assets/reassign-role", payload);
      return data as Asset[];
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
    },
  });
}

// ── Merge ─────────────────────────────────────────────────────────────

export function useMergeAudio() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      asset_ids: number[];
      channel_id: number;
      title?: string;
      description?: string;
    }) => {
      const { data } = await api.post("/assets/merge-audio", payload);
      return data as Asset;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      queryClient.invalidateQueries({ queryKey: ["folders"] });
    },
  });
}

// ── YouTube ───────────────────────────────────────────────────────────

export interface YouTubeChapter {
  title: string;
  start: number;
  end: number;
  duration: number;
}

export function useYouTubeInfo() {
  return useMutation({
    mutationFn: async (url: string) => {
      const { data } = await api.post("/assets/youtube-info", { url });
      return data as {
        video_id: string;
        title: string;
        duration: number;
        thumbnail: string;
        uploader: string;
        view_count: number | null;
        chapters?: YouTubeChapter[];
      };
    },
  });
}

export function useYouTubeDownloadChapters() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      url: string;
      chapters: YouTubeChapter[];
      channel_id?: number;
      folder_id?: number;
    }) => {
      const { data } = await api.post("/assets/youtube-download-chapters", payload);
      return data as { task_id: number; status: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

export function useYouTubeCookiesStatus() {
  return useQuery<{ configured: boolean; file_size: number }>({
    queryKey: ["youtube-cookies-status"],
    queryFn: async () => {
      const { data } = await api.get("/assets/youtube-cookies-status");
      return data;
    },
  });
}

export function useUploadYouTubeCookies() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      const { data } = await api.post(
        "/assets/youtube-cookies-upload",
        formData,
        { headers: { "Content-Type": "multipart/form-data" } }
      );
      return data as { success: boolean; message: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["youtube-cookies-status"] });
    },
  });
}

export function useDeleteYouTubeCookies() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async () => {
      const { data } = await api.delete("/assets/youtube-cookies");
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["youtube-cookies-status"] });
    },
  });
}

export function useYouTubeDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      url: string;
      // At least one of channel_id or folder_id is required. When only a
      // folder is given, the backend assigns the asset to a fallback channel
      // (folders are channel-agnostic).
      channel_id?: number;
      folder_id?: number;
      title?: string;
      description?: string;
    }) => {
      const { data } = await api.post("/assets/youtube-download", payload);
      return data as { task_id: number; status: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

/**
 * Download a full YouTube video (capped at 1080p) as an MP4 asset.
 * Mirror of ``useYouTubeDownload`` but produces ``asset_type='video'``
 * rows under ``data/assets/{channel_id}/video/``. The visualizer's
 * background-video picker reads ``asset_type='video'`` so downloads
 * become usable as compose backgrounds immediately.
 */
export function useYouTubeVideoDownload() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      url: string;
      channel_id?: number;
      folder_id?: number;
      title?: string;
      description?: string;
    }) => {
      const { data } = await api.post("/assets/youtube-video-download", payload);
      return data as { task_id: number; status: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}

/**
 * Download a YouTube video and slice it into MP4 sections.
 * Mirror of ``useYouTubeDownloadChapters`` but produces video assets.
 * Each section becomes its own asset; section cuts are sample-accurate
 * (re-encoded server-side via libx264 + aac).
 */
export function useYouTubeVideoDownloadSections() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: {
      url: string;
      sections: YouTubeChapter[];
      channel_id?: number;
      folder_id?: number;
    }) => {
      const { data } = await api.post(
        "/assets/youtube-video-download-sections",
        payload,
      );
      return data as { task_id: number; status: string };
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
