/**
 * Zustand store for the embedded visualizer editor.
 *
 * Ported from the Music Visualiser's `editor-store.ts`. The parent page
 * (e.g. NewProjectPage Compose step) owns the persisted project and is
 * responsible for calling `setInitialConfig(...)` on mount. Whenever the
 * store's config changes we surface the full ProjectConfig via a selector
 * so the parent can debounce + PATCH to the backend.
 */

import { create } from "zustand";
import type { AudioTrack, ProjectConfig } from "@/types/visualizer";
import { DEFAULT_PROJECT_CONFIG } from "@/types/visualizer";

interface EditorState {
  // Config
  config: ProjectConfig;
  presetId: string;

  // Assets (URLs served by the backend)
  logoUrl: string | null;
  backgroundUrl: string | null;
  overlayUrl: string | null;

  // Audio playback
  audioTracks: AudioTrack[];
  currentTrackIndex: number;
  audioUrl: string | null;
  audioDuration: number;
  isPlaying: boolean;
  currentTime: number;
  seekTo: number | null;

  // UI state
  activePanel: string;
  previewQuality: "240p" | "360p" | "480p" | "720p";

  // Image library (channel assets) — populated by the parent (Compose step)
  // so the ImagesPanel can show a thumbnail picker and write picks back to the
  // project's image_asset_ids.
  imageLibrary: {
    id: number;
    file_url: string;
    filename: string;
    title?: string | null;
    asset_type?: string;
  }[];
  selectedBackgroundAssetId: number | null;
  /** Called by ImagesPanel when the user picks a different background asset
   *  from the library. Parent persists the change to the project. */
  onBackgroundAssetSelect: ((assetId: number | null) => void) | null;
  /** Called by ImagesPanel when the user uploads a new image. Parent uploads
   *  to the channel's asset library, then calls onBackgroundAssetSelect with
   *  the new asset id. Returns the resolved URL for instant preview. */
  onBackgroundFileUpload: ((file: File) => Promise<string | null>) | null;
  /** Called by ImagesPanel when the user uploads a logo or corner overlay.
   *  Parent uploads the file as a channel asset and writes the resulting
   *  filepath into ``config.logo_filepath`` / ``config.overlay_filepath``
   *  so the offline render can find it. Returns the public URL for the
   *  preview to display. Without this, uploads stay as local blob: URLs
   *  that the visualizer engine can't see — the composed video would
   *  silently render without the logo / overlay. */
  onLogoFileUpload: ((file: File) => Promise<string | null>) | null;
  onOverlayFileUpload: ((file: File) => Promise<string | null>) | null;

  // Actions
  setInitialConfig: (config: ProjectConfig, presetId: string) => void;
  updateConfig: (partial: Partial<ProjectConfig>) => void;
  setPresetId: (id: string) => void;
  setLogoUrl: (url: string | null) => void;
  setBackgroundUrl: (url: string | null) => void;
  setOverlayUrl: (url: string | null) => void;
  setAudioTracks: (tracks: AudioTrack[]) => void;
  addAudioTracks: (tracks: AudioTrack[]) => void;
  removeAudioTrack: (index: number) => void;
  setCurrentTrackIndex: (i: number) => void;
  setAudioDuration: (duration: number) => void;
  setIsPlaying: (playing: boolean) => void;
  setCurrentTime: (time: number) => void;
  setSeekTo: (time: number | null) => void;
  setActivePanel: (panel: string) => void;
  setPreviewQuality: (quality: EditorState["previewQuality"]) => void;
  setImageLibrary: (lib: EditorState["imageLibrary"]) => void;
  setSelectedBackgroundAssetId: (id: number | null) => void;
  setBackgroundCallbacks: (cbs: {
    onSelect: EditorState["onBackgroundAssetSelect"];
    onUpload: EditorState["onBackgroundFileUpload"];
  }) => void;
  setLogoOverlayCallbacks: (cbs: {
    onLogoUpload: EditorState["onLogoFileUpload"];
    onOverlayUpload: EditorState["onOverlayFileUpload"];
  }) => void;

  // Live canvas element — set by PreviewCanvas on mount so PresetManager
  // can capture a snapshot without prop-drilling.
  canvasEl: HTMLCanvasElement | null;
  setCanvasEl: (el: HTMLCanvasElement | null) => void;
  /** Capture a JPEG data-URL from the current canvas frame. Returns null if no canvas. */
  captureSnapshot: () => string | null;
}

function totalDuration(tracks: AudioTrack[]): number {
  return tracks.reduce((s, t) => s + (t.duration || 0), 0);
}

export const useVisualizerEditorStore = create<EditorState>((set) => ({
  config: DEFAULT_PROJECT_CONFIG,
  presetId: "linear-dots",

  logoUrl: null,
  backgroundUrl: null,
  overlayUrl: null,

  audioTracks: [],
  currentTrackIndex: 0,
  audioUrl: null,
  audioDuration: 0,
  isPlaying: false,
  currentTime: 0,
  seekTo: null,

  activePanel: "audio",
  previewQuality: "480p",

  imageLibrary: [],
  selectedBackgroundAssetId: null,
  onBackgroundAssetSelect: null,
  onBackgroundFileUpload: null,
  onLogoFileUpload: null,
  onOverlayFileUpload: null,

  canvasEl: null,
  setCanvasEl: (el) => set({ canvasEl: el }),
  captureSnapshot: () => {
    const canvas = useVisualizerEditorStore.getState().canvasEl;
    if (!canvas) return null;
    if (!canvas.width || !canvas.height) return null;
    try {
      const url = canvas.toDataURL("image/jpeg", 0.85);
      // A blank/uninitialised canvas can produce a tiny "image" header — the
      // dataurl length on a real 1920×1080 frame is hundreds of KB, so
      // anything under ~2 KB is almost certainly empty.
      if (!url || url.length < 2048) return null;
      return url;
    } catch {
      return null;
    }
  },

  setInitialConfig: (config, presetId) =>
    set({ config: { ...DEFAULT_PROJECT_CONFIG, ...config }, presetId }),

  updateConfig: (partial) =>
    set((state) => ({ config: { ...state.config, ...partial } })),

  setPresetId: (id) => set({ presetId: id }),

  setLogoUrl: (url) => set({ logoUrl: url }),
  setBackgroundUrl: (url) => set({ backgroundUrl: url }),
  setOverlayUrl: (url) => set({ overlayUrl: url }),

  setAudioTracks: (tracks) =>
    set({
      audioTracks: tracks,
      currentTrackIndex: 0,
      audioUrl: tracks[0]?.url ?? null,
      audioDuration: totalDuration(tracks),
      currentTime: 0,
    }),

  addAudioTracks: (newTracks) =>
    set((state) => {
      const tracks = [...state.audioTracks, ...newTracks];
      return {
        audioTracks: tracks,
        audioUrl: tracks[0]?.url ?? null,
        audioDuration: totalDuration(tracks),
      };
    }),

  removeAudioTrack: (index) =>
    set((state) => {
      const tracks = state.audioTracks.filter((_, i) => i !== index);
      const currentTrackIndex = Math.max(
        0,
        Math.min(state.currentTrackIndex, tracks.length - 1),
      );
      return {
        audioTracks: tracks,
        currentTrackIndex,
        audioUrl: tracks[currentTrackIndex]?.url ?? null,
        audioDuration: totalDuration(tracks),
        currentTime: 0,
        isPlaying: false,
      };
    }),

  setCurrentTrackIndex: (i) =>
    set((state) => ({
      currentTrackIndex: Math.max(0, Math.min(i, state.audioTracks.length - 1)),
      audioUrl: state.audioTracks[i]?.url ?? null,
      currentTime: 0,
    })),

  setAudioDuration: (duration) =>
    set((state) => {
      // Patch the current track's duration if it's unknown, so totals converge
      const tracks = [...state.audioTracks];
      const cur = tracks[state.currentTrackIndex];
      if (cur && (!cur.duration || cur.duration === 0)) {
        tracks[state.currentTrackIndex] = { ...cur, duration };
        return { audioTracks: tracks, audioDuration: totalDuration(tracks) };
      }
      return {};
    }),

  setIsPlaying: (playing) => set({ isPlaying: playing }),
  setCurrentTime: (time) => set({ currentTime: time }),
  setSeekTo: (time) => set({ seekTo: time }),
  setActivePanel: (panel) => set({ activePanel: panel }),
  setPreviewQuality: (quality) => set({ previewQuality: quality }),

  setImageLibrary: (lib) => set({ imageLibrary: lib }),
  setSelectedBackgroundAssetId: (id) => set({ selectedBackgroundAssetId: id }),
  setBackgroundCallbacks: ({ onSelect, onUpload }) =>
    set((state) => {
      // Skip the store update entirely when nothing changed by reference —
      // avoids notifying subscribers and prevents render loops when the
      // owning component re-renders with structurally-identical inline
      // callbacks (it shouldn't, but defensive is cheap here).
      if (
        state.onBackgroundAssetSelect === onSelect &&
        state.onBackgroundFileUpload === onUpload
      ) {
        return {};
      }
      return {
        onBackgroundAssetSelect: onSelect,
        onBackgroundFileUpload: onUpload,
      };
    }),
  setLogoOverlayCallbacks: ({ onLogoUpload, onOverlayUpload }) =>
    set((state) => {
      if (
        state.onLogoFileUpload === onLogoUpload &&
        state.onOverlayFileUpload === onOverlayUpload
      ) {
        return {};
      }
      return {
        onLogoFileUpload: onLogoUpload,
        onOverlayFileUpload: onOverlayUpload,
      };
    }),
}));
