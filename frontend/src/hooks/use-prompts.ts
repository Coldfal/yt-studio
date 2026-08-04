import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { Prompt } from "@/types/index";

export function usePrompts(params?: {
  channel_id?: number;
  prompt_type?: string;
  is_favorite?: boolean;
}) {
  return useQuery<Prompt[]>({
    queryKey: ["prompts", params],
    queryFn: async () => {
      const { data } = await api.get("/prompts", { params });
      return data;
    },
  });
}

export function usePrompt(id?: number | string) {
  return useQuery<Prompt>({
    queryKey: ["prompts", id],
    queryFn: async () => {
      const { data } = await api.get(`/prompts/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export function useCreatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<Prompt>) => {
      const { data } = await api.post("/prompts", payload);
      return data as Prompt;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });
}

export function useUpdatePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...payload
    }: Partial<Prompt> & { id: number }) => {
      const { data } = await api.put(`/prompts/${id}`, payload);
      return data as Prompt;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });
}

export function useDeletePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/prompts/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });
}

export function useUsePrompt() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await api.post(`/prompts/${id}/use`);
      return data as Prompt;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });
}

export function useToggleFavorite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await api.post(`/prompts/${id}/favorite`);
      return data as Prompt;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["prompts"] });
    },
  });
}
