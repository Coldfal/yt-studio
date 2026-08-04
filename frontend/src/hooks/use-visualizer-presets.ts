import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { ProjectConfig } from "@/types/visualizer";

export interface VisualizerPreset {
  id: number;
  channel_id: number;
  name: string;
  preset_id: string;
  config: ProjectConfig & Record<string, unknown>;
  is_default: boolean;
  thumbnail_url: string | null;
  created_at: string;
  updated_at: string;
}

export function useVisualizerPresets(channelId: number | null | undefined) {
  return useQuery<VisualizerPreset[]>({
    queryKey: ["visualizer-presets", channelId],
    queryFn: async () => {
      const { data } = await api.get("/visualizer-presets", {
        params: channelId != null ? { channel_id: channelId } : undefined,
      });
      return data;
    },
    enabled: channelId != null,
  });
}

export function useCreateVisualizerPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      channel_id: number;
      name: string;
      preset_id: string;
      config: Record<string, unknown>;
      is_default?: boolean;
    }) => {
      const { data } = await api.post("/visualizer-presets", body);
      return data as VisualizerPreset;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["visualizer-presets", vars.channel_id] });
    },
  });
}

export function useUpdateVisualizerPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (vars: {
      id: number;
      body: Partial<{
        name: string;
        preset_id: string;
        config: Record<string, unknown>;
        is_default: boolean;
      }>;
    }) => {
      const { data } = await api.put(`/visualizer-presets/${vars.id}`, vars.body);
      return data as VisualizerPreset;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["visualizer-presets"] });
    },
  });
}

export function useDeleteVisualizerPreset() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/visualizer-presets/${id}`);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["visualizer-presets"] });
    },
  });
}

export function useUploadPresetThumbnail() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, dataUrl }: { id: number; dataUrl: string }) => {
      const { data } = await api.post(`/visualizer-presets/${id}/thumbnail`, {
        data_url: dataUrl,
      });
      return data as VisualizerPreset;
    },
    onSuccess: (_d, vars) => {
      qc.invalidateQueries({ queryKey: ["visualizer-presets"] });
      // Bust the specific preset cache key too (used by primary-preset endpoint)
      qc.invalidateQueries({ queryKey: ["channel-primary-preset"] });
    },
  });
}
