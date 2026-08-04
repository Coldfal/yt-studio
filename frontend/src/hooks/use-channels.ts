import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { Channel, ChannelStats } from "@/types/index";

export function useChannels() {
  return useQuery<Channel[]>({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data } = await api.get("/channels");
      return data;
    },
  });
}

export function useChannel(id: number | string | undefined) {
  return useQuery<Channel>({
    queryKey: ["channels", id],
    queryFn: async () => {
      const { data } = await api.get(`/channels/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export function useChannelStats(id: number | string | undefined) {
  return useQuery<ChannelStats>({
    queryKey: ["channels", id, "stats"],
    queryFn: async () => {
      const { data } = await api.get(`/channels/${id}/stats`);
      return data;
    },
    enabled: !!id,
  });
}

/**
 * Per-channel disk usage. One round-trip for the whole list, cached
 * across the dashboard. Refresh interval is generous because asset
 * sizes don't change often — only on upload/delete.
 */
export interface StorageRow {
  channel_id: number;
  channel_name: string | null;
  total_bytes: number;
  asset_count: number;
  by_type: Record<string, { bytes: number; count: number }>;
}

export function useStorageStats() {
  return useQuery<StorageRow[]>({
    queryKey: ["stats", "storage"],
    queryFn: async () => {
      const { data } = await api.get("/stats/storage");
      return data;
    },
    staleTime: 5 * 60 * 1000, // 5 min — asset list rarely shifts
  });
}

/**
 * Per-channel rate-limit bucket snapshot. One row per provider with
 * tokens / capacity / refill rate. Used by the dashboard's "Quota"
 * line to surface the tightest bucket so the operator can see when
 * a channel is about to hit a limit before clicking Generate.
 */
export interface QuotaSnapshot {
  provider: string;
  channel_id: number | null;
  capacity: number;
  rate_per_minute: number;
  tokens_available: number;
  seconds_until_full: number;
}

export function useChannelQuota(id: number | undefined) {
  return useQuery<QuotaSnapshot[]>({
    queryKey: ["stats", "quota", id],
    queryFn: async () => {
      const { data } = await api.get(`/stats/quota/${id}`);
      return data;
    },
    enabled: !!id,
    // Buckets refill in real time — polling every 30s keeps the
    // displayed numbers fresh without spamming the in-memory store.
    refetchInterval: 30_000,
  });
}

export function useCreateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<Channel>) => {
      const { data } = await api.post("/channels", payload);
      return data as Channel;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
    },
  });
}

export function useUpdateChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...payload
    }: Partial<Channel> & { id: number }) => {
      const { data } = await api.put(`/channels/${id}`, payload);
      return data as Channel;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
      queryClient.invalidateQueries({
        queryKey: ["channels", variables.id],
      });
    },
  });
}

/**
 * Push the channel's country + localized channel title/description to
 * YouTube via the sync-youtube-branding endpoint. Operator-triggered
 * (the backend's channels().update() costs 50 quota units). The DB
 * values must be saved first — the endpoint reads persisted state.
 */
export interface SyncBrandingResult {
  ok: boolean;
  youtube_channel_id: string;
  country: string | null;
  localizations_pushed: string[];
  master_language: string;
}

export function useSyncChannelBranding() {
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await api.post(
        `/channels/${id}/sync-youtube-branding`,
      );
      return data as SyncBrandingResult;
    },
  });
}

export interface ChannelLastConfig {
  composition_config: Record<string, unknown> | null;
  visualizer_preset_id: number | null;
  music_source: string | null;
  image_asset_ids: number[] | null;
  // Last folder path used in folder-mode music selection. Pre-fills the
  // New Video wizard's folder input on the next project for this channel.
  music_folder_path: string | null;
}

/** Fetches the last-used composition config for a channel (project memory). */
export function useChannelLastConfig(id: number | string | undefined) {
  return useQuery<ChannelLastConfig>({
    queryKey: ["channels", id, "last-config"],
    queryFn: async () => {
      const { data } = await api.get(`/channels/${id}/last-config`);
      return data;
    },
    enabled: !!id,
    staleTime: 60_000,
  });
}

export function useDeleteChannel() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/channels/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["channels"] });
    },
  });
}
