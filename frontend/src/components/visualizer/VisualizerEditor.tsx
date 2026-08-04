import { useEffect, useRef } from "react";
import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import type { AudioTrack, ProjectConfig } from "@/types/visualizer";
import { DEFAULT_PROJECT_CONFIG } from "@/types/visualizer";
import { VisualizerSidebar } from "./VisualizerSidebar";
import { PreviewCanvas } from "./PreviewCanvas";
import { PlaybackControls } from "./PlaybackControls";

interface VisualizerEditorProps {
  /** Current config — the full ProjectConfig plus output_* extensions. */
  value: ProjectConfig & {
    presetId?: string;
    output_width?: number;
    output_height?: number;
    output_fps?: number;
    crf?: number;
  };
  /** Fired whenever the user edits any setting (debounced upstream). */
  onChange: (next: VisualizerEditorProps["value"]) => void;
  /** Preset ID, separate from config for clarity. */
  presetId: string;
  /** Preset ID change callback (called when user clicks a preset tile). */
  onPresetIdChange: (id: string) => void;
  /** URL of the current audio track (legacy single-track path). */
  audioUrl?: string | null;
  audioName?: string;
  audioDuration?: number;
  /** Full ordered list of audio tracks (multi-track projects). Takes
   *  precedence over `audioUrl` when provided. */
  audioTracks?: AudioTrack[];
  /** Initial background / logo / overlay URLs from project assets. */
  backgroundUrl?: string | null;
  logoUrl?: string | null;
  overlayUrl?: string | null;
  /** Channel image library — when provided the Images panel renders a
   *  thumbnail picker. Picks invoke ``onBackgroundAssetSelect`` so the parent
   *  can persist the choice (e.g. into project.image_asset_ids).
   *
   *  Items can be ``asset_type: "image" | "video"``. Video items render
   *  as autoplay/looping/muted ``<video>`` previews so the user can see
   *  the loop in motion before picking. The compose backend detects
   *  video bg by file extension and switches to a chromakey-overlay
   *  pipeline; the same field on ``project.image_asset_ids[0]`` carries
   *  the asset id either way. */
  imageLibrary?: {
    id: number;
    file_url: string;
    filename: string;
    title?: string | null;
    asset_type?: string;
  }[];
  selectedBackgroundAssetId?: number | null;
  onBackgroundAssetSelect?: (assetId: number | null) => void | Promise<void>;
  /** Upload handler — Images panel calls this when the user picks a new file.
   *  Should upload to the channel's asset library and return the resulting
   *  file_url for instant preview. */
  onBackgroundFileUpload?: (file: File) => Promise<string | null>;
  /** Logo / overlay upload handlers. Same contract as
   *  ``onBackgroundFileUpload`` — the parent uploads the file and writes
   *  the resulting filepath into ``config.logo_filepath`` /
   *  ``config.overlay_filepath`` so the offline render picks them up.
   *  Without these wired up, ImagesPanel falls back to a local blob: URL
   *  that the visualizer engine can't see, and the composed video silently
   *  renders without the logo or overlay. */
  onLogoFileUpload?: (file: File) => Promise<string | null>;
  onOverlayFileUpload?: (file: File) => Promise<string | null>;
}

/**
 * Embedded visualizer editor. Ported from the Music Visualiser's EditorShell.
 *
 * Renders a left sidebar (7 panels) and a preview canvas. The parent owns
 * the persisted config — changes flow up via `onChange` so the parent can
 * debounce and PATCH to the project.
 */
export function VisualizerEditor({
  value,
  onChange,
  presetId,
  onPresetIdChange,
  audioUrl,
  audioName,
  audioDuration,
  audioTracks,
  backgroundUrl,
  logoUrl,
  overlayUrl,
  imageLibrary,
  selectedBackgroundAssetId,
  onBackgroundAssetSelect,
  onBackgroundFileUpload,
  onLogoFileUpload,
  onOverlayFileUpload,
}: VisualizerEditorProps) {
  const config = useVisualizerEditorStore((s) => s.config);
  const storePresetId = useVisualizerEditorStore((s) => s.presetId);
  const setInitialConfig = useVisualizerEditorStore((s) => s.setInitialConfig);
  const setAudioTracks = useVisualizerEditorStore((s) => s.setAudioTracks);
  const setLogoUrl = useVisualizerEditorStore((s) => s.setLogoUrl);
  const setBackgroundUrl = useVisualizerEditorStore((s) => s.setBackgroundUrl);
  const setOverlayUrl = useVisualizerEditorStore((s) => s.setOverlayUrl);
  const setImageLibrary = useVisualizerEditorStore((s) => s.setImageLibrary);
  const setSelectedBackgroundAssetId = useVisualizerEditorStore(
    (s) => s.setSelectedBackgroundAssetId,
  );
  const setBackgroundCallbacks = useVisualizerEditorStore(
    (s) => s.setBackgroundCallbacks,
  );
  const setLogoOverlayCallbacks = useVisualizerEditorStore(
    (s) => s.setLogoOverlayCallbacks,
  );

  const seededRef = useRef(false);

  // Seed the store from props on first mount
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    setInitialConfig(value as ProjectConfig, presetId);
    let tracks: AudioTrack[] = [];
    if (audioTracks && audioTracks.length > 0) {
      tracks = audioTracks;
    } else if (audioUrl) {
      tracks = [{ url: audioUrl, name: audioName ?? "Track", duration: audioDuration ?? 0 }];
    }
    setAudioTracks(tracks);
    if (logoUrl) setLogoUrl(logoUrl);
    if (backgroundUrl) setBackgroundUrl(backgroundUrl);
    if (overlayUrl) setOverlayUrl(overlayUrl);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // If the audioTracks prop changes post-mount (e.g. user goes back to the
  // Music step and adds tracks), re-seed them.
  useEffect(() => {
    if (!seededRef.current) return;
    if (audioTracks && audioTracks.length > 0) {
      setAudioTracks(audioTracks);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(audioTracks?.map((t) => t.url))]);

  // Push parent-driven `value` changes into the store post-mount. This is
  // what makes "Load saved preset" actually work — without it, the parent
  // updates its config but the editor keeps showing the old config because
  // the store was only seeded on mount.
  //
  // We use ``getState()`` (not subscribed values) inside the effect to read
  // the FRESH store config — closured ``config`` from useVisualizerEditorStore
  // can be stale when this effect runs immediately after seedEffect's
  // synchronous setInitialConfig in the same render cycle. The deps are
  // only [value, presetId] so the effect only re-fires when the parent
  // actually pushes new data, not when the store changes from inside.
  useEffect(() => {
    if (!seededRef.current) return;
    const wouldBe = { ...DEFAULT_PROJECT_CONFIG, ...(value as object) };
    const state = useVisualizerEditorStore.getState();
    if (
      state.presetId === presetId &&
      JSON.stringify(wouldBe) === JSON.stringify(state.config)
    ) {
      return;
    }
    setInitialConfig(value as ProjectConfig, presetId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, presetId]);

  // Forward image library + selection to the store so ImagesPanel can read it.
  useEffect(() => {
    setImageLibrary(imageLibrary ?? []);
  }, [imageLibrary, setImageLibrary]);
  useEffect(() => {
    setSelectedBackgroundAssetId(selectedBackgroundAssetId ?? null);
  }, [selectedBackgroundAssetId, setSelectedBackgroundAssetId]);
  useEffect(() => {
    setBackgroundCallbacks({
      onSelect: onBackgroundAssetSelect ?? null,
      onUpload: onBackgroundFileUpload ?? null,
    });
    // No cleanup on dep change — ImagesPanel reads via the store and we
    // don't want the brief "(null, null)" between cleanup and re-set to
    // disable the panel buttons. The store's setter is now a no-op when
    // the callback refs are unchanged, so re-firing is cheap.
  }, [onBackgroundAssetSelect, onBackgroundFileUpload, setBackgroundCallbacks]);

  // Clear the callbacks ONLY on real unmount, so stale closures from a
  // remounted editor on another page don't keep firing.
  useEffect(() => {
    return () => setBackgroundCallbacks({ onSelect: null, onUpload: null });
  }, [setBackgroundCallbacks]);

  useEffect(() => {
    setLogoOverlayCallbacks({
      onLogoUpload: onLogoFileUpload ?? null,
      onOverlayUpload: onOverlayFileUpload ?? null,
    });
  }, [onLogoFileUpload, onOverlayFileUpload, setLogoOverlayCallbacks]);
  useEffect(() => {
    return () =>
      setLogoOverlayCallbacks({ onLogoUpload: null, onOverlayUpload: null });
  }, [setLogoOverlayCallbacks]);

  // Propagate config changes upward. Like the push-down, we read FRESH
  // store state via getState() instead of relying on closured subscribed
  // values, which can be stale when this effect runs in the same cycle as
  // seedEffect. Deps include `config` and `storePresetId` so we re-fire
  // when the user edits something inside the editor (e.g. moves a slider
  // in ImagesPanel calling updateConfig).
  useEffect(() => {
    if (!seededRef.current) return;
    const state = useVisualizerEditorStore.getState();
    const merged: ProjectConfig & { presetId?: string } = {
      ...(state.config as ProjectConfig),
      presetId: state.presetId,
    };
    const incoming = { ...DEFAULT_PROJECT_CONFIG, ...(value as object) };
    if (JSON.stringify(merged) === JSON.stringify(incoming)) {
      return;
    }
    onChange(merged);
  }, [config, storePresetId, onChange, value]);

  // Propagate preset changes
  useEffect(() => {
    if (!seededRef.current) return;
    if (storePresetId && storePresetId !== presetId) {
      onPresetIdChange(storePresetId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storePresetId]);

  return (
    <div className="flex h-[80vh] flex-col overflow-hidden rounded-lg border border-border/50 bg-background">
      <div className="flex flex-1 overflow-hidden">
        <VisualizerSidebar />
        <div className="flex flex-1 flex-col">
          <div className="relative flex flex-1 items-center justify-center bg-black/20 p-4">
            <PreviewCanvas />
          </div>
          <PlaybackControls />
        </div>
      </div>
    </div>
  );
}
