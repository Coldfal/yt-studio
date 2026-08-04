export interface Channel {
  id: number;
  name: string;
  niche: string;
  description: string | null;
  youtube_channel_id: string | null;
  youtube_connected: boolean;
  default_prompt_prefix: string | null;
  default_image_style: string | null;
  default_video_width: number;
  default_video_height: number;
  default_video_style: string;
  brand_identity: string | null;
  target_audience: string | null;
  default_tags: string | null;
  title_template: string | null;
  description_template: string | null;
  // AI voice fields — see docs/ai-voice-redesign.md
  ai_voice: string | null;
  ai_example_title: string | null;
  ai_example_description: string | null;
  ai_example_tags: string | null;
  /** Free-form operator notes — observations about what's working on
   *  this channel. Fed into the metadata-generation system prompt as
   *  soft context (NOT hard rules — those go in ai_voice). */
  notes: string | null;
  thumbnail_style_notes: string | null;
  upload_schedule: string | null;
  /** YouTube ``snippet.defaultLanguage`` — the language the master
   *  title / description are written in. Drives the translations
   *  picker (master gets filtered out so we don't translate ko→ko).
   *  Defaults to "en"; set to "ko" / "ja" / etc. for non-English-master
   *  channels (e.g. yomii studio). */
  master_language: string;
  /** YouTube ``brandingSettings.channel.country`` — 2-letter ISO code
   *  (e.g. "JP"). null = leave YouTube's value untouched. */
  country: string | null;
  /** YouTube channel-level localizations — localized channel title +
   *  description per BCP-47 code. Pushed via sync-youtube-branding. */
  channel_localizations: Record<
    string,
    { title: string; description: string }
  > | null;
  created_at: string;
  updated_at: string;
}

export interface ChannelStats {
  total_projects: number;
  projects_by_status: Record<string, number>;
  total_assets: number;
}

export interface VideoProject {
  id: number;
  channel_id: number;
  status: string;
  title: string;
  music_asset_id: number | null;
  music_asset_ids: number[] | null;
  music_prompt: string | null;
  music_folder_path: string | null;
  music_folder_files: string[] | null;
  image_asset_ids: number[] | null;
  video_style: string | null;
  composed_asset_id: number | null;
  composition_config: Record<string, unknown> | null;
  youtube_title: string | null;
  youtube_description: string | null;
  youtube_tags: string[] | null;
  youtube_category_id: string;
  youtube_privacy: string;
  youtube_scheduled_at: string | null;
  thumbnail_asset_id: number | null;
  /** In-app thumbnail-editor state. Mirrors the `thumbnail_editor_state`
   *  column on the backend (JSON). See `ThumbnailStep.tsx` for the shape;
   *  rendered JPEG (the actual thumbnail) lives on `thumbnail_asset_id`. */
  thumbnail_editor_state: {
    bg: { kind: "asset" | "upload" | "video_bg"; asset_id: number | null };
    layers: Array<{
      text: string;
      x: number;
      y: number;
      font: string;
      size: number;
      color: string;
      weight: "normal" | "bold";
      align: "left" | "center" | "right";
      effect_preset:
        | "none" | "bloom" | "embossed" | "long_shadow"
        | "chromatic" | "gradient" | "glass";
    }>;
  } | null;
  /** Per-language localised title + description. The description here
   *  is only the translated TOP — tracklist + hashtags are appended
   *  from the English version at upload time. */
  youtube_translations: Record<string, { title: string; description: string }> | null;
  youtube_video_id: string | null;
  youtube_url: string | null;
  uploaded_at: string | null;
  /** Last upload error message (auto-publish failures). Null on success. */
  upload_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface AssetFolder {
  id: number;
  channel_id: number;
  asset_type: string;
  name: string;
  /** Free-text label that ties folders across asset types together.
   *  When two folders (e.g. an image + music folder) share the same
   *  ``pair_group``, channels with ``preset.use_folder_pairing=true``
   *  constrain Quick Generate's music selection to match the picked
   *  image's group. NULL/empty = ungrouped. */
  pair_group: string | null;
  asset_count: number;
  created_at: string;
}

export interface Asset {
  id: number;
  channel_id: number;
  asset_type: string;
  /** Sub-classification for images: "background" | "thumbnail" |
   *  "overlay" | "reference". NULL for music / video / composed
   *  assets. Quick Generate filters role='background' so a thumbnail
   *  or overlay never gets picked as a video background. */
  role: string | null;
  source: string;
  filename: string;
  filepath: string;
  file_url: string;
  file_size: number | null;
  duration_seconds: number | null;
  mime_type: string | null;
  prompt: string | null;
  title: string | null;
  description: string | null;
  folder_id: number | null;
  folder_name: string | null;
  /**
   * ``true`` when the file at ``filepath`` exists on disk.
   * The backend computes this on each list/get response. ``false`` →
   * the file has been deleted out from under the row (e.g. user removed
   * it manually) — UI shows a "missing" badge so the user can review
   * + decide whether to delete the row or restore the file.
   */
  file_exists: boolean;
  created_at: string;
}

export interface BackgroundTask {
  id: number;
  task_type: string;
  status: string;
  project_id: number | null;
  channel_id: number | null;
  progress: number;
  status_message: string | null;
  result: Record<string, unknown> | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
}

export interface SettingItem {
  key: string;
  value: string;
  is_secret: boolean;
}

export interface CompositionStyle {
  name: string;
  description: string;
  default_config: Record<string, unknown>;
}

export interface Prompt {
  id: number;
  channel_id: number;
  prompt_type: string;
  name: string;
  content: string;
  is_favorite: boolean;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export const PROMPT_TYPES = [
  { value: "music_generation", label: "Music Generation", color: "bg-blue-500" },
  { value: "metadata_generation", label: "Metadata / SEO", color: "bg-green-500" },
  { value: "visual_style", label: "Visual Style", color: "bg-purple-500" },
] as const;

export const NICHE_OPTIONS = [
  { value: "lofi", label: "Lofi / Chill" },
  { value: "music", label: "Music" },
  { value: "education", label: "Education" },
  { value: "motivation", label: "Motivation" },
  { value: "stories", label: "Stories / Narration" },
  { value: "asmr", label: "ASMR / Ambient" },
  { value: "tech", label: "Technology" },
  { value: "finance", label: "Finance" },
  { value: "custom", label: "Custom" },
] as const;

export const STATUS_COLORS: Record<string, string> = {
  draft: "bg-gray-500",
  music_ready: "bg-blue-500",
  visuals_ready: "bg-indigo-500",
  composing: "bg-yellow-500",
  composed: "bg-purple-500",
  uploading: "bg-orange-500",
  uploaded: "bg-green-500",
  scheduled: "bg-teal-500",
  failed: "bg-red-500",
};
