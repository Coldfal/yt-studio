import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { SettingItem } from "@/types/index";

export function useSettings() {
  return useQuery<SettingItem[]>({
    queryKey: ["settings"],
    queryFn: async () => {
      const { data } = await api.get("/settings");
      return data;
    },
  });
}

export function useSaveSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (settings: Record<string, string>) => {
      const { data } = await api.put("/settings", { settings });
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["settings"] });
    },
  });
}

export function useTestConnection() {
  return useMutation({
    mutationFn: async (provider: string) => {
      const { data } = await api.post(`/settings/test/${provider}`);
      return data as { success: boolean; message: string };
    },
  });
}
