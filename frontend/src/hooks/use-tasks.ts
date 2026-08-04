import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { BackgroundTask } from "@/types/index";

export function useTasks(params?: {
  status?: string;
  project_id?: number;
  task_type?: string;
  channel_id?: number;
  limit?: number;
}) {
  return useQuery<BackgroundTask[]>({
    queryKey: ["tasks", params],
    queryFn: async () => {
      const { data } = await api.get("/tasks", { params });
      return data;
    },
  });
}

/**
 * Last completed automation_run task on a channel — powers the Phase-1
 * "Last generation" diagnostic line on the dashboard card.
 */
export function useLastChannelRun(channelId: number) {
  return useQuery<BackgroundTask | null>({
    queryKey: ["last-channel-run", channelId],
    queryFn: async () => {
      const { data } = await api.get("/tasks", {
        params: {
          channel_id: channelId,
          task_type: "automation_run",
          limit: 1,
        },
      });
      return (data as BackgroundTask[])[0] ?? null;
    },
    staleTime: 30_000,
  });
}

export function useTask(id: number | string | undefined) {
  return useQuery<BackgroundTask>({
    queryKey: ["tasks", id],
    queryFn: async () => {
      const { data } = await api.get(`/tasks/${id}`);
      return data;
    },
    enabled: !!id,
    refetchInterval: (query) => {
      const task = query.state.data;
      if (task && (task.status === "running" || task.status === "pending")) {
        return 2000;
      }
      return false;
    },
  });
}

export function useCancelTask() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await api.post(`/tasks/${id}/cancel`);
      return data as BackgroundTask;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
  });
}
