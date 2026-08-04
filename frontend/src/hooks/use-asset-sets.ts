/**
 * Asset Sets hooks — Phase 5 of farm redesign.
 *
 * A Set is a named (background, thumbnail, [overlay]) tuple per
 * channel that Quick Generate picks from when
 * ``automation_presets.use_asset_sets=True``. Replaces the
 * sticky-thumbnail abstraction with a richer pairing model now that
 * Phase 0 gave every image a role.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";

export interface AssetSet {
  id: number;
  channel_id: number;
  name: string;
  background_asset_id: number;
  thumbnail_asset_id: number;
  overlay_asset_id: number | null;
  is_active: boolean;
  background_file_url: string | null;
  thumbnail_file_url: string | null;
  overlay_file_url: string | null;
  background_filename: string | null;
  thumbnail_filename: string | null;
}

export interface AssetSetCreate {
  channel_id: number;
  name: string;
  background_asset_id: number;
  thumbnail_asset_id: number;
  overlay_asset_id?: number | null;
  is_active?: boolean;
}

export function useAssetSets(channelId?: number) {
  return useQuery<AssetSet[]>({
    queryKey: ["asset-sets", channelId],
    queryFn: async () => {
      const { data } = await api.get("/asset-sets", {
        params: channelId ? { channel_id: channelId } : {},
      });
      return data;
    },
    staleTime: 30_000,
  });
}

export function useCreateAssetSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: AssetSetCreate) => {
      const { data } = await api.post("/asset-sets", body);
      return data as AssetSet;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["asset-sets", data.channel_id] });
      qc.invalidateQueries({ queryKey: ["asset-sets"] });
    },
  });
}

export function useUpdateAssetSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { id: number; patch: Partial<AssetSetCreate> }) => {
      const { data } = await api.put(`/asset-sets/${args.id}`, args.patch);
      return data as AssetSet;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["asset-sets", data.channel_id] });
      qc.invalidateQueries({ queryKey: ["asset-sets"] });
    },
  });
}

export function useDeleteAssetSet() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/asset-sets/${id}`);
      return id;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["asset-sets"] });
    },
  });
}

export function useToggleAssetSetActive() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await api.post(`/asset-sets/${id}/toggle-active`);
      return data as AssetSet;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ["asset-sets", data.channel_id] });
      qc.invalidateQueries({ queryKey: ["asset-sets"] });
    },
  });
}
