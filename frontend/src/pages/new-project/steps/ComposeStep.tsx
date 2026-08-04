import { useCallback, useEffect, useRef, useState } from "react";
import {
  Check,
  Film,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useChannelLastConfig } from "@/hooks/use-channels";
import { useUpdateProject } from "@/hooks/use-projects";
import { useAsset, useAssets, useUploadAsset } from "@/hooks/use-assets";
import { useTask } from "@/hooks/use-tasks";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import type { VideoProject } from "@/types/index";
import { VisualizerEditor } from "@/components/visualizer/VisualizerEditor";
import { DEFAULT_PROJECT_CONFIG } from "@/types/visualizer";
import { useVisualizerEditorStore } from "@/stores/visualizer-editor-store";
import { useVisualizerPresets } from "@/hooks/use-visualizer-presets";
import { VisualizerPresetBar } from "../components/VisualizerPresetBar";
import { ExtendVideoCard } from "../components/ExtendVideoCard";

export function ComposeStep({
  project,
  onComposed,
}: {
  project: VideoProject;
  onComposed: () => void;
}) {
  // Visualizer toggle — when off, we keep the same engine running (so
  // particles, background, subscribe overlay, beat effects all still
  // render) but the engine skips drawing spectrum bars. Persisted in the
  // project's composition_config under ``visualizer_disabled``.
  const [visualizerEnabled, setVisualizerEnabled] = useState<boolean>(() => {
    const stored = (project.composition_config ?? {}) as Record<string, unknown>;
    return stored.visualizer_disabled ? false : true;
  });
  // Always use the spectrum (audio-reactive engine) style so the engine
  // runs. The flag inside the config controls whether bars are drawn.
  const style = "spectrum";
  const [composing, setComposing] = useState(false);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [config, setConfig] = useState<Record<string, unknown>>(() => {
    // If the stored config is empty or missing MV-style keys, seed with the
    // Music Visualiser defaults so the editor has a starting point.
    const stored = project.composition_config ?? {};
    if (!stored || Object.keys(stored).length === 0) {
      return {
        ...DEFAULT_PROJECT_CONFIG,
        presetId: "linear-dots",
        output_width: 1920,
        output_height: 1080,
        output_fps: 30,
        crf: 23,
      } as Record<string, unknown>;
    }
    return stored as Record<string, unknown>;
  });

  // Resolve music + first image URLs for the embedded editor.
  const { data: musicAsset } = useAsset(project.music_asset_id ?? undefined);
  // For folder mode, derive a single preview URL from the first folder file
  const folderPreviewUrl =
    project.music_folder_files && project.music_folder_files.length > 0
      ? `/api/music/stream-file?file_path=${encodeURIComponent(project.music_folder_files[0])}`
      : null;
  const firstImageId = project.image_asset_ids?.[0];
  const { data: firstImageAsset } = useAsset(firstImageId);

  // The channel's full image library — feeds the visualizer editor's
  // background picker. Picks here update project.image_asset_ids so the
  // backend render uses them.
  const { data: channelImageAssets } = useAssets({
    channel_id: String(project.channel_id),
    asset_type: "image",
  });
  // Plus the channel's videos — these can be used as a *looping* visual
  // background. Backend detects via file extension and switches to a
  // chromakey-overlay pipeline; the picker UI just shows them inline
  // alongside the images.
  const { data: channelVideoAssets } = useAssets({
    channel_id: String(project.channel_id),
    asset_type: "video",
  });
  // Combined library passed to the editor. Newest first — videos
  // typically rare so showing them at the top makes them findable.
  // Excludes rows whose file is missing on disk so the picker doesn't
  // surface dead options.
  const backgroundLibrary = [
    ...((channelVideoAssets ?? []).filter((a) => a.file_exists !== false)),
    ...((channelImageAssets ?? []).filter((a) => a.file_exists !== false)),
  ];
  const updateProject = useUpdateProject();
  const uploadAsset = useUploadAsset();

  // Resolve the full list of music assets for multi-track projects.
  const musicTrackIds =
    project.music_asset_ids && project.music_asset_ids.length > 0
      ? project.music_asset_ids
      : project.music_asset_id
        ? [project.music_asset_id]
        : [];
  const { data: allMusicAssets } = useAssets({
    channel_id: String(project.channel_id),
    asset_type: "music",
  });
  const libraryTracks = musicTrackIds
    .map((id) => allMusicAssets?.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .map((a) => ({
      url: a.file_url,
      name: a.title || a.filename,
      duration: a.duration_seconds ?? 0,
    }));
  // Folder-mode: build streamable URLs from absolute server paths.
  // Durations start as 0 and are filled in once the scan resolves.
  const [folderDurations, setFolderDurations] = useState<Record<string, number>>({});
  useEffect(() => {
    const files = project.music_folder_files;
    const folder = project.music_folder_path;
    if (!files?.length || !folder) return;
    api.get("/music/scan-folder", { params: { folder_path: folder } })
      .then(({ data }) => {
        const map: Record<string, number> = {};
        for (const t of data.tracks) map[t.path] = t.duration;
        setFolderDurations(map);
      })
      .catch(() => {});
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id]);

  const folderTracks =
    project.music_folder_files && project.music_folder_files.length > 0
      ? project.music_folder_files.map((filePath) => ({
          url: `/api/music/stream-file?file_path=${encodeURIComponent(filePath)}`,
          name: filePath.split(/[\\/]/).pop() ?? filePath,
          duration: folderDurations[filePath] ?? 0,
        }))
      : [];

  // Once real durations arrive, push updated tracks straight into the store
  // (the VisualizerEditor's update effect only watches URLs, not durations).
  useEffect(() => {
    if (!folderTracks.length) return;
    if (!folderTracks.some((t) => t.duration > 0)) return;
    useVisualizerEditorStore.getState().setAudioTracks(folderTracks);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [JSON.stringify(folderTracks.map((t) => t.duration))]);

  const resolvedTracks = folderTracks.length > 0 ? folderTracks : libraryTracks;

  // ── Project memory: AUTO-restore the last-used config ─────────────────
  // No banner / click-to-apply: as soon as the channel's last_composition_config
  // arrives we hydrate this project's editor with it (config, toggles, images).
  // This keeps the visual identity consistent across videos for the same channel.
  const { data: channelLastConfig } = useChannelLastConfig(project.channel_id);
  const lastConfigAppliedRef = useRef(false);

  // Determine whether the current config is still the pristine seed
  const storedConfig = project.composition_config ?? {};
  const hasCustomConfig =
    storedConfig &&
    Object.keys(storedConfig).length > 0 &&
    "waveColor1" in (storedConfig as object);

  // Auto-apply on first arrival of channelLastConfig, only when this project
  // has no custom saved config yet (i.e. brand-new project for this channel).
  useEffect(() => {
    if (lastConfigAppliedRef.current) return;
    if (hasCustomConfig) {
      lastConfigAppliedRef.current = true;
      return;
    }
    if (!channelLastConfig) return;
    const lastCfg = channelLastConfig.composition_config;
    if (lastCfg && Object.keys(lastCfg).length > 0) {
      setConfig(lastCfg as Record<string, unknown>);
      lastConfigAppliedRef.current = true;
    }
  }, [channelLastConfig, hasCustomConfig]);

  // Auto-apply the channel's last image asset IDs to the new project — gives
  // each new video the same backdrop until the user changes it.
  // ── Auto-apply a default image when the project has none ────────────
  // Single-shot effect that races with the user's image pick if not
  // careful. Two failure modes the previous (split) code hit:
  //   1. The parent shell's local ``project`` state didn't sync from
  //      React Query after our mutation, so subsequent renders still
  //      saw ``image_asset_ids: []`` and fired ANOTHER auto-apply that
  //      could land AFTER the user's pick — silently overwriting it.
  //      That's why the rendered MP4's background sometimes didn't
  //      match the visualizer preview.
  //   2. Two separate effects (channel-last + random fallback) both
  //      mutated the project; their write order vs. the user's pick
  //      was non-deterministic.
  // Fix: collapse to ONE effect that fires at most once per mount,
  // gated by a single ref that's set the moment we decide either way
  // (mutate, no-op, or no-data-yet → wait). Order of preference:
  //   (a) project already has image_asset_ids → leave it alone.
  //   (b) channel.last_image_asset_ids (memory) → use that.
  //   (c) one random pick from the channel's image library.
  // If the channel has no images at all, we leave image_asset_ids
  // empty — the preview shows a black background and the user picks
  // one explicitly. That's better UX than auto-magic that fights the
  // user, and the compose endpoint already 400s on empty.
  const autoImageAppliedRef = useRef(false);
  useEffect(() => {
    if (autoImageAppliedRef.current) return;
    // Wait for BOTH signals before committing — channelLastConfig
    // arriving alone could cause us to apply random fallback before
    // we've even checked memory.
    if (!channelLastConfig) return;
    if (!channelImageAssets) return;

    const projectIds = project.image_asset_ids ?? [];
    if (projectIds.length > 0) {
      // Project already has images — never auto-apply over user data.
      autoImageAppliedRef.current = true;
      return;
    }

    autoImageAppliedRef.current = true;

    const lastIds = (channelLastConfig as { image_asset_ids?: number[] | null })
      .image_asset_ids;
    if (lastIds && lastIds.length > 0) {
      // Inherit the channel's previous image batch — keeps the visual
      // identity consistent across videos for the same channel.
      updateProject.mutate({ id: project.id, image_asset_ids: lastIds });
      return;
    }

    if (channelImageAssets.length > 0) {
      // No memory — pick a random one from the library so the preview
      // has something to show.
      const pick = channelImageAssets[
        Math.floor(Math.random() * channelImageAssets.length)
      ];
      if (pick) {
        updateProject.mutate({ id: project.id, image_asset_ids: [pick.id] });
      }
    }
    // Else: channel has zero images → leave empty, user picks manually.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelLastConfig, channelImageAssets]);

  // Fall back to the channel's default visualizer preset only if there's no
  // custom config AND no last-config to inherit from.
  const { data: channelPresets } = useVisualizerPresets(project.channel_id);
  const defaultAppliedRef = useRef(false);
  useEffect(() => {
    if (defaultAppliedRef.current) return;
    if (lastConfigAppliedRef.current) return;
    if (!channelPresets || channelPresets.length === 0) return;
    if (hasCustomConfig) {
      defaultAppliedRef.current = true;
      return;
    }
    if (channelLastConfig?.composition_config) return; // memory wins
    const def = channelPresets.find((p) => p.is_default) ?? channelPresets[0];
    if (def) {
      setConfig({ ...(def.config as Record<string, unknown>), presetId: def.preset_id });
      defaultAppliedRef.current = true;
    }
  }, [channelPresets, hasCustomConfig, channelLastConfig]);

  const { data: task } = useTask(taskId ?? undefined);
  const composeHandledRef = useRef<number | null>(null);
  const [extending, setExtending] = useState(false);
  const [extendTaskId, setExtendTaskId] = useState<number | null>(null);
  const { data: extendTask } = useTask(extendTaskId ?? undefined);

  useEffect(() => {
    if (!task || !taskId) return;
    // Only handle each task completion once
    if (composeHandledRef.current === task.id) return;
    if (task.status === "completed") {
      composeHandledRef.current = task.id;
      setComposing(false);
      // If the user enabled "loop final video to duration", chain the
      // extend task automatically — no manual click needed.
      const wantLoop = Boolean(config.loop_to_target);
      const targetSec = Number(config.target_duration ?? 0);
      if (wantLoop && targetSec > 0) {
        (async () => {
          setExtending(true);
          try {
            const { data: ext } = await api.post("/compose/extend", {
              project_id: project.id,
              target_duration_seconds: targetSec,
              snap_to_song: config.snap_to_song !== false,
            });
            setExtendTaskId(ext.id);
            toast.success("Video composed — extending to target length…");
          } catch {
            setExtending(false);
            toast.error("Compose succeeded, but extend failed to start");
            onComposed();
          }
        })();
      } else {
        onComposed();
        toast.success("Video composed successfully");
      }
    }
    if (task.status === "failed") {
      composeHandledRef.current = task.id;
      setComposing(false);
      toast.error(task.error ?? "Composition failed");
    }
  }, [task]); // eslint-disable-line react-hooks/exhaustive-deps

  // Watch the extend task — when it finishes, signal the wizard to advance.
  const extendHandledRef = useRef<number | null>(null);
  useEffect(() => {
    if (!extendTask || !extendTaskId) return;
    if (extendHandledRef.current === extendTask.id) return;
    if (extendTask.status === "completed") {
      extendHandledRef.current = extendTask.id;
      setExtending(false);
      onComposed();
      toast.success("Video extended to target length");
    }
    if (extendTask.status === "failed") {
      extendHandledRef.current = extendTask.id;
      setExtending(false);
      toast.error(extendTask.error ?? "Extend failed");
      onComposed();
    }
  }, [extendTask]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleCompose = async () => {
    composeHandledRef.current = null;
    setComposing(true);
    try {
      const { data } = await api.post("/compose/start", {
        project_id: project.id,
        style,
        config,
      });
      setTaskId(data.id);
    } catch {
      setComposing(false);
      toast.error("Failed to start composition");
    }
  };

  const isComposed = project.status === "composed" || !!project.composed_asset_id;

  // ── Stable callbacks for VisualizerEditor ──────────────────────────────
  // Inline closures here would create a new function ref on every render,
  // and VisualizerEditor's effects would re-fire each time, eventually
  // causing "Maximum update depth exceeded" once a config push-down
  // round-trip is also in flight. Refs hold the latest captured state so
  // these callbacks never need to change identity.
  const projectRef2 = useRef(project);
  useEffect(() => { projectRef2.current = project; }, [project]);
  const updateProjectRef = useRef(updateProject);
  useEffect(() => { updateProjectRef.current = updateProject; }, [updateProject]);
  const uploadAssetRef = useRef(uploadAsset);
  useEffect(() => { uploadAssetRef.current = uploadAsset; }, [uploadAsset]);
  const setConfigRef = useRef(setConfig);
  useEffect(() => { setConfigRef.current = setConfig; }, [setConfig]);
  const configRef2 = useRef(config);
  useEffect(() => { configRef2.current = config; }, [config]);
  // Combined library ref — stable handle so the background-select callback
  // can look up an asset's ``asset_type`` ("image" vs "video") without
  // having ``backgroundLibrary`` in its deps (which would re-create the
  // callback on every render and cascade-fire the editor's effects).
  const backgroundLibraryRef = useRef(backgroundLibrary);
  useEffect(() => { backgroundLibraryRef.current = backgroundLibrary; }, [backgroundLibrary]);

  const onVizChange = useCallback((next: unknown) => {
    setConfigRef.current(next as Record<string, unknown>);
  }, []);
  const onVizPresetIdChange = useCallback((id: string) => {
    setConfigRef.current({ ...configRef2.current, presetId: id });
  }, []);
  const onVizBackgroundAssetSelect = useCallback(async (assetId: number | null) => {
    const p = projectRef2.current;
    const next = assetId == null
      ? []
      : [assetId, ...(p.image_asset_ids ?? []).filter((x) => x !== assetId)];
    // Detect whether the picked asset is a video so we can flip
    // ``config.backgroundType`` — PreviewCanvas keys its bgVideo loader off
    // this flag, and the offline render's compose_service detects video
    // backgrounds by file extension regardless. The flag is what makes
    // the live preview show the looping video instead of trying (and
    // failing) to load it as an <img>.
    const picked = assetId == null
      ? null
      : backgroundLibraryRef.current.find((a) => a.id === assetId);
    const nextBgType: "image" | "video" =
      picked?.asset_type === "video" ? "video" : "image";
    try {
      await updateProjectRef.current.mutateAsync({
        id: p.id,
        image_asset_ids: next,
      });
      // Persist the type into composition_config — the editor's downstream
      // ``onChange`` will round-trip it back into the project record so a
      // re-mount restores the right preview mode.
      setConfigRef.current({
        ...configRef2.current,
        backgroundType: nextBgType,
      });
      toast.success(
        assetId
          ? nextBgType === "video"
            ? "Video background set"
            : "Background updated"
          : "Background cleared",
      );
    } catch {
      toast.error("Failed to update background");
    }
  }, []);
  const onVizBackgroundFileUpload = useCallback(async (file: File) => {
    const p = projectRef2.current;
    // Mime-sniff to route image vs video to the right asset_type. Backend
    // stores both as channel-owned assets; compose_service picks the
    // chromakey-overlay pipeline when the chosen background's file
    // extension is a video format. Keeping ``asset_type`` accurate also
    // makes the asset show up in the right Library tab.
    const isVideoFile =
      file.type === "video/mp4" || file.type === "video/webm";
    const fd = new FormData();
    fd.append("file", file);
    fd.append("channel_id", String(p.channel_id));
    fd.append("asset_type", isVideoFile ? "video" : "image");
    fd.append("replace_existing", "true");
    try {
      const asset = await uploadAssetRef.current.mutateAsync(fd);
      await updateProjectRef.current.mutateAsync({
        id: p.id,
        image_asset_ids: [
          asset.id,
          ...(p.image_asset_ids ?? []).filter((x) => x !== asset.id),
        ],
      });
      // Flip backgroundType so the live preview activates its <video>
      // path (or falls back to <img>). Keeps the wizard's preview in
      // sync with what the offline render will produce.
      setConfigRef.current({
        ...configRef2.current,
        backgroundType: isVideoFile ? "video" : "image",
      });
      toast.success(
        isVideoFile ? "Video background uploaded & set" : "Background uploaded & set",
      );
      return asset.file_url;
    } catch {
      toast.error("Upload failed");
      return null;
    }
  }, []);

  // Logo + corner overlay uploads. These mirror the background uploader:
  // upload the file as a channel asset (image type), then write the
  // resulting filepath into composition_config so the offline render's
  // visualizer engine can see it. Without this the file would only live as
  // a local blob: URL — the preview would show it but the composed video
  // would silently render without the logo / overlay.
  const uploadLogoOrOverlay = useCallback(
    async (file: File, slot: "logo" | "overlay") => {
      const p = projectRef2.current;
      const fd = new FormData();
      fd.append("file", file);
      fd.append("channel_id", String(p.channel_id));
      fd.append("asset_type", "image");
      fd.append("replace_existing", "true");
      try {
        const asset = await uploadAssetRef.current.mutateAsync(fd);
        // Persist the filepath into composition_config. compose_service
        // reads ``logo_filepath`` and ``overlay_filepath`` and the engine
        // resolves them under settings.assets_dir.
        const key = slot === "logo" ? "logo_filepath" : "overlay_filepath";
        const next: Record<string, unknown> = {
          ...configRef2.current,
          [key]: asset.filepath,
        };
        if (slot === "overlay") {
          // Custom overlay overrides any built-in marker (e.g. subscribe).
          next.overlayBuiltin = null;
          next.overlayEnabled = true;
        } else {
          next.logoEnabled = true;
        }
        setConfigRef.current(next);
        toast.success(
          slot === "logo" ? "Logo uploaded & set" : "Overlay uploaded & set",
        );
        return asset.file_url;
      } catch {
        toast.error("Upload failed");
        return null;
      }
    },
    [],
  );
  const onVizLogoFileUpload = useCallback(
    (file: File) => uploadLogoOrOverlay(file, "logo"),
    [uploadLogoOrOverlay],
  );
  const onVizOverlayFileUpload = useCallback(
    (file: File) => uploadLogoOrOverlay(file, "overlay"),
    [uploadLogoOrOverlay],
  );

  return (
    <div className="w-full space-y-4">
      {/* Project memory now auto-applies on mount — see useEffect above.
          The "Resume your last look?" banner has been removed. */}

      <div>
        <h2 className="text-xl font-semibold">Design Your Visualizer</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Pick a preset, tweak the look, preview it live, then render.
        </p>
      </div>

      <VisualizerPresetBar
        channelId={project.channel_id}
        config={config}
        presetId={(config.presetId as string) ?? "linear-dots"}
        onApply={(c, p) => setConfig({ ...c, presetId: p })}
      />

      <VisualizerEditor
        value={config as any}
        onChange={onVizChange}
        presetId={(config.presetId as string) ?? "linear-dots"}
        onPresetIdChange={onVizPresetIdChange}
        audioUrl={musicAsset?.file_url ?? folderPreviewUrl}
        audioName={musicAsset?.filename}
        audioDuration={musicAsset?.duration_seconds ?? 0}
        audioTracks={resolvedTracks}
        backgroundUrl={firstImageAsset?.file_url ?? null}
        // Persisted logo / overlay come from composition_config — surface
        // them as preview URLs on remount so the user sees what the offline
        // render will use. ``/files/{relative_path}`` is the public asset
        // mount that the assets API uses for ``file_url``.
        logoUrl={
          config.logo_filepath
            ? `/files/${config.logo_filepath}`
            : null
        }
        overlayUrl={
          config.overlay_filepath
            ? `/files/${config.overlay_filepath}`
            : null
        }
        imageLibrary={backgroundLibrary}
        selectedBackgroundAssetId={firstImageId ?? null}
        onBackgroundAssetSelect={onVizBackgroundAssetSelect}
        onBackgroundFileUpload={onVizBackgroundFileUpload}
        onLogoFileUpload={onVizLogoFileUpload}
        onOverlayFileUpload={onVizOverlayFileUpload}
      />

      {/* Render options — visualizer on/off + frame rate. Both persist
          into composition_config so a re-compose remembers them. */}
      <div className="flex flex-wrap items-center gap-4 rounded-lg border border-border/60 bg-card/40 p-3">
        <div className="flex flex-1 items-center gap-3 min-w-[240px]">
          <Switch
            checked={visualizerEnabled}
            onCheckedChange={(v) => {
              setVisualizerEnabled(v);
              setConfig({ ...config, visualizer_disabled: !v });
            }}
          />
          <div className="flex-1">
            <Label className="text-sm font-medium">Audio-reactive visualizer</Label>
            <p className="text-[11px] text-muted-foreground">
              Off = static image + audio only (faster render, smaller file).
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Label className="text-xs">FPS</Label>
          <div className="flex gap-1">
            {[15, 24, 30].map((fps) => {
              const sel = Number(config.output_fps ?? 30) === fps;
              return (
                <button
                  key={fps}
                  type="button"
                  onClick={() =>
                    setConfig({ ...config, output_fps: fps })
                  }
                  className={cn(
                    "rounded px-2 py-1 text-xs transition",
                    sel
                      ? "bg-primary text-primary-foreground"
                      : "border border-border/50 text-muted-foreground hover:bg-muted",
                  )}
                >
                  {fps}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      {/* Loop-final-video-to-duration: composes the natural-length video first
          (1× pass over the audio), then loops/copies the result to the target
          duration via FFmpeg concat — no re-encoding, near-instant. */}
      <div className="space-y-2 rounded-lg border border-border/60 bg-card/40 p-3">
        <div className="flex items-center gap-4">
          <div className="flex-1">
            <Label className="text-sm font-medium">Loop final video to duration</Label>
            <p className="text-xs text-muted-foreground">
              After composing, the video is duplicated end-to-end (fast copy,
              no re-render) until it reaches the target length.
            </p>
          </div>
          <Switch
            checked={Boolean(config.loop_to_target)}
            onCheckedChange={(v) =>
              setConfig({ ...config, loop_to_target: v })
            }
          />
          {Boolean(config.loop_to_target) && (
            <Select
              value={String(config.target_duration ?? "36000")}
              onValueChange={(v) =>
                setConfig({ ...config, target_duration: parseInt(v) })
              }
            >
              <SelectTrigger className="w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="600">10 minutes</SelectItem>
                <SelectItem value="1800">30 minutes</SelectItem>
                <SelectItem value="3600">1 hour</SelectItem>
                <SelectItem value="7200">2 hours</SelectItem>
                <SelectItem value="10800">3 hours</SelectItem>
                <SelectItem value="14400">4 hours</SelectItem>
                <SelectItem value="28800">8 hours</SelectItem>
                <SelectItem value="36000">10 hours</SelectItem>
                <SelectItem value="43200">12 hours</SelectItem>
              </SelectContent>
            </Select>
          )}
        </div>
        {Boolean(config.loop_to_target) && (
          <div className="flex items-center justify-between gap-3 pt-1">
            <div className="flex-1">
              <Label className="text-xs">Snap to nearest full song</Label>
              <p className="text-[11px] text-muted-foreground">
                Round duration down so songs always finish — no mid-track cuts.
              </p>
            </div>
            <Switch
              checked={config.snap_to_song !== false}
              onCheckedChange={(v) =>
                setConfig({ ...config, snap_to_song: v })
              }
            />
          </div>
        )}
      </div>

      <Button
        onClick={handleCompose}
        disabled={composing || extending}
        className="w-full"
      >
        {composing ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Composing...
          </>
        ) : extending ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            Extending video...
          </>
        ) : isComposed ? (
          <>
            <RefreshCw className="size-4" />
            Re-compose Video
          </>
        ) : (
          <>
            <Film className="size-4" />
            Compose Video
          </>
        )}
      </Button>

      {composing && task && (
        <div className="space-y-2 rounded-lg border border-border bg-muted/30 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {task.status_message ?? "Composing video..."}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {Math.round(task.progress ?? 0)}%
            </span>
          </div>
          <Progress value={task.progress} />
          <p className="text-xs text-muted-foreground">
            This may take a while for long videos. Do not close this page.
          </p>
        </div>
      )}

      {extending && extendTask && (
        <div className="space-y-2 rounded-lg border border-blue-500/30 bg-blue-500/5 p-4">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">
              {extendTask.status_message ?? "Extending video to target length..."}
            </span>
            <span className="tabular-nums text-muted-foreground">
              {Math.round(extendTask.progress ?? 0)}%
            </span>
          </div>
          <Progress value={extendTask.progress} />
          <p className="text-xs text-muted-foreground">
            Fast copy/loop — no re-encoding. Should finish in seconds.
          </p>
        </div>
      )}

      {isComposed && !composing && (
        <>
          <Card>
            <CardContent className="flex items-center gap-3">
              <Film className="size-5 text-purple-400" />
              <span className="text-sm font-medium">Video composed</span>
              <Badge variant="secondary" className="ml-auto">
                <Check className="size-3" />
                Done
              </Badge>
            </CardContent>
          </Card>
          <ExtendVideoCard project={project} onExtended={onComposed} />
        </>
      )}
    </div>
  );
}
