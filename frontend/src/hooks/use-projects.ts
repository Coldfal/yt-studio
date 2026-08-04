import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import type { VideoProject } from "@/types/index";

export function useProjects(params?: {
  channel_id?: number | string;
  status?: string;
}) {
  return useQuery<VideoProject[]>({
    queryKey: ["projects", params],
    queryFn: async () => {
      const { data } = await api.get("/projects", { params });
      return data;
    },
  });
}

export function useProject(id: number | string | undefined) {
  return useQuery<VideoProject>({
    queryKey: ["projects", id],
    queryFn: async () => {
      const { data } = await api.get(`/projects/${id}`);
      return data;
    },
    enabled: !!id,
  });
}

export function useCreateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (payload: Partial<VideoProject>) => {
      const { data } = await api.post("/projects", payload);
      return data as VideoProject;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

export function useUpdateProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      ...payload
    }: Partial<VideoProject> & { id: number }) => {
      const { data } = await api.put(`/projects/${id}`, payload);
      return data as VideoProject;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({
        queryKey: ["projects", variables.id],
      });
    },
  });
}

export function useDeleteProject() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      await api.delete(`/projects/${id}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
    },
  });
}

/**
 * Push the project's saved translations to its already-uploaded
 * YouTube video. Only callable when the project has a
 * ``youtube_video_id`` — for fresh drafts, translations are applied
 * during the normal upload flow instead.
 *
 * Powers the "Push to YouTube" button on the Translations panel —
 * lets the operator backfill localisations on old videos that were
 * uploaded before this feature existed.
 */
export function usePushTranslationsToYoutube() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: number) => {
      const { data } = await api.post(
        `/projects/${id}/push-translations-to-youtube`,
      );
      return data as VideoProject;
    },
    onSuccess: (_data, id) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({ queryKey: ["projects", id] });
    },
  });
}

/**
 * Ask Claude to translate the project's English title + description top
 * into the requested locales (defaults to ja, zh-Hans, ko, es). The
 * server saves the result on ``project.youtube_translations`` and
 * returns the updated project — invalidating the cache is enough to
 * propagate it everywhere.
 */
export function useGenerateTranslations() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      id,
      languages,
      merge,
    }: {
      id: number;
      languages?: string[];
      merge?: boolean;
    }) => {
      const { data } = await api.post(
        `/projects/${id}/generate-translations`,
        { languages, merge },
      );
      return data as VideoProject;
    },
    onSuccess: (_data, variables) => {
      queryClient.invalidateQueries({ queryKey: ["projects"] });
      queryClient.invalidateQueries({
        queryKey: ["projects", variables.id],
      });
    },
  });
}
