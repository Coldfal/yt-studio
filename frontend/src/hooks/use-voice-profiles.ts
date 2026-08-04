/**
 * Voice profile + voice history hooks.
 *
 * Phase 2 of the farm redesign. Backs the Voice Studio's "Profiles"
 * dropdown (save/load/cross-channel apply) and the History drawer
 * (per-channel snapshots created on every save).
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";

export interface VoiceProfile {
  id: number;
  name: string;
  notes: string | null;
  niche: string | null;
  brand_identity: string | null;
  target_audience: string | null;
  default_tags: string | null;
  title_template: string | null;
  description_template: string | null;
  ai_voice: string | null;
  ai_example_title: string | null;
  ai_example_description: string | null;
  ai_example_tags: string | null;
  thumbnail_style_notes: string | null;
  source_channel_id: number | null;
  created_at: string;
  updated_at: string;
}

export interface VoiceHistoryEntry {
  id: number;
  channel_id: number;
  label: string | null;
  ai_voice: string | null;
  ai_example_title: string | null;
  ai_example_description: string | null;
  ai_example_tags: string | null;
  notes: string | null;
  created_at: string;
}

export interface LearnFromUrlProposals {
  competitor_url: string;
  kind: "channel" | "video";
  observations: string;
  proposed_rule_additions: { rule_text: string; rationale: string }[];
  proposed_example_titles: string[];
  proposed_keyword_pool: string[];
}

// ── Profiles ─────────────────────────────────────────────────────────

export function useVoiceProfiles() {
  return useQuery<VoiceProfile[]>({
    queryKey: ["voice-profiles"],
    queryFn: async () => {
      const { data } = await api.get("/voice-profiles/");
      return data;
    },
    staleTime: 60_000,
  });
}

export function useCreateVoiceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (body: {
      name: string;
      notes?: string;
      source_channel_id: number;
    }) => {
      const { data } = await api.post("/voice-profiles/", body);
      return data as VoiceProfile;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["voice-profiles"] });
    },
  });
}

export function useDeleteVoiceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (profileId: number) => {
      await api.delete(`/voice-profiles/${profileId}`);
      return profileId;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["voice-profiles"] });
    },
  });
}

/**
 * Apply a profile's fields to a channel. Snapshots the pre-state
 * server-side so the operator can roll back from the History drawer.
 */
export function useApplyVoiceProfile() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { channelId: number; profileId: number }) => {
      const { data } = await api.post(
        `/channels/${args.channelId}/apply-voice-profile/${args.profileId}`,
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["channel", vars.channelId] });
      qc.invalidateQueries({ queryKey: ["channels"] });
      qc.invalidateQueries({ queryKey: ["voice-history", vars.channelId] });
    },
  });
}

// ── History ──────────────────────────────────────────────────────────

export function useVoiceHistory(channelId: number, limit = 30) {
  return useQuery<VoiceHistoryEntry[]>({
    queryKey: ["voice-history", channelId, limit],
    queryFn: async () => {
      const { data } = await api.get(
        `/channels/${channelId}/voice-history`,
        { params: { limit } },
      );
      return data;
    },
    staleTime: 30_000,
  });
}

export function useRestoreVoiceSnapshot() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (args: { channelId: number; snapshotId: number }) => {
      const { data } = await api.post(
        `/channels/${args.channelId}/voice-history/${args.snapshotId}/restore`,
      );
      return data;
    },
    onSuccess: (_data, vars) => {
      qc.invalidateQueries({ queryKey: ["channel", vars.channelId] });
      qc.invalidateQueries({ queryKey: ["channels"] });
      qc.invalidateQueries({ queryKey: ["voice-history", vars.channelId] });
    },
  });
}

// ── Learn from URL ───────────────────────────────────────────────────

/**
 * Submit scraped competitor content for analysis. The frontend handles
 * the actual scraping via Claude in Chrome MCP; this hook just POSTs
 * the harvested titles + descriptions and returns the proposal block.
 */
export function useLearnFromUrl() {
  return useMutation({
    mutationFn: async (args: {
      channelId: number;
      url: string;
      kind: "channel" | "video";
      scraped_titles: string[];
      scraped_descriptions?: string[];
    }) => {
      const { data } = await api.post(
        `/channels/${args.channelId}/voice/learn-from-url`,
        {
          url: args.url,
          kind: args.kind,
          scraped_titles: args.scraped_titles,
          scraped_descriptions: args.scraped_descriptions ?? [],
        },
      );
      return data as LearnFromUrlProposals;
    },
  });
}

// ── Sample with voice override ───────────────────────────────────────

export interface AISampleResult {
  title: string;
  description: string;
  tags: string[];
  category_id: string;
  based_on_project_id: number | null;
  track_names_used: string[];
}

export interface VoiceOverride {
  niche?: string;
  brand_identity?: string;
  target_audience?: string;
  ai_voice?: string;
  ai_example_title?: string;
  ai_example_description?: string;
  ai_example_tags?: string;
  notes?: string;
}

/**
 * Run Claude with the current voice (saved + optional overrides). The
 * Voice Studio passes the live form values so the operator sees the
 * effect of unsaved edits.
 */
export function useGenerateVoiceSample() {
  return useMutation({
    mutationFn: async (args: {
      channelId: number;
      override?: VoiceOverride;
    }) => {
      const { data } = await api.post(
        `/channels/${args.channelId}/ai-sample`,
        args.override ?? {},
      );
      return data as AISampleResult;
    },
  });
}
