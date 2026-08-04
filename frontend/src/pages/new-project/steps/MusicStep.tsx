import { useEffect, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Clock,
  FolderOpen,
  GripVertical,
  Loader2,
  Music,
  Pause,
  Play,
  RefreshCw,
  Sparkles,
  UploadCloud,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { format as formatDate } from "date-fns";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Progress } from "@/components/ui/progress";
import { Separator } from "@/components/ui/separator";
import { useChannelLastConfig } from "@/hooks/use-channels";
import { useAssets, useUploadAsset } from "@/hooks/use-assets";
import { useTask } from "@/hooks/use-tasks";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import type { VideoProject } from "@/types/index";
import { ImportFolderRow } from "../components/ImportFolderRow";
import { FolderPickerDialog } from "../components/FolderPickerDialog";
import { formatDuration } from "../utils";

export function MusicStep({
  project,
  onMusicReady,
}: {
  project: VideoProject;
  onMusicReady: (assetIds: number | number[]) => void;
}) {
  const [mode, setMode] = useState<"generate" | "upload" | "library" | "folder">("library");

  // Pull the channel's project memory so we can pre-fill the folder input.
  const { data: channelLastConfig } = useChannelLastConfig(project.channel_id);

  // Folder-mode state. Initialise from the project (if it already has a
  // folder set) and otherwise fall back to nothing — the effect below
  // pre-fills from the channel's last-used folder once it arrives.
  const [folderPath, setFolderPath] = useState(project.music_folder_path ?? "");
  // Native-like Browse dialog. Driven by ``/api/fs/list-dirs``; the
  // browser can't read absolute filesystem paths via <input
  // type="file"> for security, so this is the cleanest path that
  // returns a real path the backend can scan.
  const [folderBrowserOpen, setFolderBrowserOpen] = useState(false);

  // When the channel's last folder loads and the user hasn't set anything
  // for this project yet, copy it in. Also auto-switch the music source
  // mode to "folder" if that was the user's last choice for this channel,
  // so they don't have to re-pick the tab on every new video.
  const folderPathSeededRef = useRef(false);
  useEffect(() => {
    if (folderPathSeededRef.current) return;
    if (!channelLastConfig) return;
    const lastPath = channelLastConfig.music_folder_path ?? "";
    if (!folderPath && lastPath) {
      setFolderPath(lastPath);
    }
    if (channelLastConfig.music_source === "folder" && !project.music_folder_path) {
      setMode("folder");
    }
    folderPathSeededRef.current = true;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelLastConfig]);
  const [folderTracks, setFolderTracks] = useState<
    { path: string; filename: string; duration: number; size: number }[]
  >([]);
  const [folderScanning, setFolderScanning] = useState(false);
  const [folderSelectedPaths, setFolderSelectedPaths] = useState<string[]>(
    project.music_folder_files ?? [],
  );
  // drag-to-reorder state for selected tracks
  const dragSrcIdx = useRef<number | null>(null);
  const [dragOverIdx, setDragOverIdx] = useState<number | null>(null);

  const moveFolderTrack = (from: number, to: number) => {
    if (from === to) return;
    setFolderSelectedPaths((prev) => {
      const next = [...prev];
      const [item] = next.splice(from, 1);
      next.splice(to, 0, item);
      return next;
    });
  };

  // Optional ``override`` lets the FolderPickerDialog scan with the
  // path it just picked, without waiting for React state to flush.
  // Without this the picker would land on the right path but show
  // the previous tracklist for one render.
  const handleScanFolder = async (override?: string) => {
    const p = (override ?? folderPath).trim();
    if (!p) { toast.error("Enter a folder path"); return; }
    setFolderScanning(true);
    try {
      const { data } = await api.get("/music/scan-folder", { params: { folder_path: p } });
      setFolderTracks(data.tracks);
      if (data.tracks.length === 0) toast.info("No audio files found in that folder");
      else toast.success(`Found ${data.tracks.length} track(s)`);
    } catch (err: unknown) {
      const msg = (err as { response?: { data?: { detail?: string } } })?.response?.data?.detail;
      toast.error(msg ?? "Could not scan folder");
    } finally {
      setFolderScanning(false);
    }
  };

  const toggleFolderTrack = (path: string) =>
    setFolderSelectedPaths((prev) =>
      prev.includes(path) ? prev.filter((x) => x !== path) : [...prev, path],
    );

  const folderTotalDuration = folderTracks
    .filter((t) => folderSelectedPaths.includes(t.path))
    .reduce((s, t) => s + t.duration, 0);

  const handleConfirmFolderSelection = async () => {
    if (folderSelectedPaths.length === 0) { toast.error("Select at least one track"); return; }
    try {
      await api.put(`/projects/${project.id}`, {
        music_folder_path: folderPath.trim(),
        music_folder_files: folderSelectedPaths,
        // Clear library selection so render uses folder mode
        music_asset_id: null,
        music_asset_ids: [],
      });
      onMusicReady([] as unknown as number); // signal "ready" to parent (no asset ID)
    } catch {
      toast.error("Failed to save folder selection");
    }
  };

  // Auto-save folder selection (debounced) — same UX as library mode: pick
  // tracks → Next unlocks → click Next. No "Use N tracks" button needed.
  const lastSavedFolderRef = useRef<string>("");
  useEffect(() => {
    if (folderSelectedPaths.length === 0) return;
    if (!folderPath.trim()) return;
    const key = `${folderPath}|${folderSelectedPaths.join(",")}`;
    if (key === lastSavedFolderRef.current) return;
    const handle = setTimeout(() => {
      lastSavedFolderRef.current = key;
      handleConfirmFolderSelection();
    }, 350);
    return () => clearTimeout(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [folderSelectedPaths, folderPath]);
  const [prompt, setPrompt] = useState(project.music_prompt ?? "");
  const [generating, setGenerating] = useState(false);
  const [taskId, setTaskId] = useState<number | null>(null);
  const [audioUrl, setAudioUrl] = useState<string | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [selectedIds, setSelectedIds] = useState<number[]>(() => {
    if (project.music_asset_ids && project.music_asset_ids.length > 0) {
      return [...project.music_asset_ids];
    }
    return project.music_asset_id ? [project.music_asset_id] : [];
  });
  const audioRef = useRef<HTMLAudioElement>(null);
  const uploadAsset = useUploadAsset();
  const { data: musicAssets } = useAssets({
    channel_id: String(project.channel_id),
    asset_type: "music",
  });

  // Search + sort the library
  const [librarySearch, setLibrarySearch] = useState("");
  const [librarySort, setLibrarySort] = useState<
    "newest" | "oldest" | "name_asc" | "name_desc"
  >("newest");

  const filteredMusicAssets = (musicAssets ?? [])
    .filter((a) => {
      if (!librarySearch.trim()) return true;
      const needle = librarySearch.trim().toLowerCase();
      return (
        a.filename.toLowerCase().includes(needle) ||
        (a.title ?? "").toLowerCase().includes(needle) ||
        (a.description ?? "").toLowerCase().includes(needle)
      );
    })
    .sort((a, b) => {
      switch (librarySort) {
        case "newest":
          return (b.created_at ?? "").localeCompare(a.created_at ?? "");
        case "oldest":
          return (a.created_at ?? "").localeCompare(b.created_at ?? "");
        case "name_asc":
          return (a.title || a.filename).localeCompare(b.title || b.filename);
        case "name_desc":
          return (b.title || b.filename).localeCompare(a.title || a.filename);
      }
    });

  const { data: task } = useTask(taskId ?? undefined);
  const taskHandledRef = useRef<number | null>(null);

  useEffect(() => {
    if (!task) return;
    if (taskHandledRef.current === task.id) return;
    if (task.status === "completed" && task.result) {
      taskHandledRef.current = task.id;
      const assetId = task.result.asset_id as number;
      const fileUrl = task.result.file_url as string;
      if (assetId) {
        onMusicReady(assetId);
        setSelectedIds([assetId]);
        if (fileUrl) setAudioUrl(fileUrl);
        setGenerating(false);
        toast.success("Music generated successfully");
      }
    }
    if (task.status === "failed") {
      taskHandledRef.current = task.id;
      setGenerating(false);
      toast.error(task.error ?? "Music generation failed");
    }
  }, [task, onMusicReady]);

  // ── Selection helpers ──
  const toggleSelect = (id: number) => {
    setSelectedIds((prev) =>
      prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id],
    );
  };

  const selectedAssets = (musicAssets ?? []).filter((a) =>
    selectedIds.includes(a.id),
  );

  const totalDuration = selectedAssets.reduce(
    (sum, a) => sum + (a.duration_seconds ?? 0),
    0,
  );

  // Auto-save selection whenever it changes (debounced) so the user doesn't
  // have to click a separate "Use N tracks" button. Next unlocks as soon as
  // any tracks are selected. Skips the very first run so we don't re-save
  // the initial state echoed back from the project.
  const lastSavedIdsRef = useRef<string>("");
  useEffect(() => {
    if (selectedIds.length === 0) return;
    const key = selectedIds.join(",");
    if (key === lastSavedIdsRef.current) return;
    const handle = setTimeout(() => {
      lastSavedIdsRef.current = key;
      onMusicReady(selectedIds);
      const single = selectedIds.length === 1;
      if (single) {
        const asset = musicAssets?.find((a) => a.id === selectedIds[0]);
        if (asset) setAudioUrl(asset.file_url);
      }
    }, 350);
    return () => clearTimeout(handle);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedIds]);

  const handleGenerate = async () => {
    if (!prompt.trim()) {
      toast.error("Enter a music prompt");
      return;
    }
    setGenerating(true);
    try {
      const { data } = await api.post("/music/generate", {
        channel_id: project.channel_id,
        project_id: project.id,
        prompt: prompt.trim(),
      });
      setTaskId(data.id);
    } catch {
      setGenerating(false);
      toast.error("Failed to start music generation");
    }
  };

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files ?? []);
    if (files.length === 0) return;

    const uploadedIds: number[] = [];
    for (const file of files) {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("channel_id", String(project.channel_id));
      formData.append("asset_type", "music");
      // Replace in place if the same filename was imported before — avoids
      // orphaning references from projects that already use that asset.
      formData.append("replace_existing", "true");
      try {
        const asset = await uploadAsset.mutateAsync(formData);
        uploadedIds.push(asset.id);
        // A successful replacement returns the same asset id that already
        // existed — the DB row was updated in place.
      } catch {
        toast.error(`Failed to upload ${file.name}`);
      }
    }

    if (uploadedIds.length === 0) return;

    if (uploadedIds.length === 1) {
      onMusicReady(uploadedIds[0]);
      setSelectedIds([uploadedIds[0]]);
      toast.success(
        `Uploaded ${files[0].name}`,
      );
    } else {
      setSelectedIds(uploadedIds);
      toast.success(
        `Uploaded ${uploadedIds.length} tracks — click "Confirm selection" to merge or use them`,
      );
    }

    // Reset the input so the same files can be re-picked if needed
    if (e.target) e.target.value = "";
  };

  const togglePlayback = () => {
    if (!audioRef.current) return;
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const hasMusicAsset = !!project.music_asset_id;

  return (
    <div className="mx-auto max-w-7xl space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold">Music</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select one or more tracks. Multiple tracks will be merged in order.
        </p>
      </div>

      {/* Mode switcher — Library is the primary mode, others tucked into
          a compact row of secondary buttons at the right. */}
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-muted-foreground">
          {mode === "library"
            ? "Pick from your channel's library"
            : mode === "upload"
              ? "Import audio files"
              : "Generate music with AI"}
        </h3>
        <div className="flex gap-1 rounded-md border border-border/50 bg-muted/40 p-0.5">
          <button
            type="button"
            onClick={() => setMode("library")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
              mode === "library"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Music className="size-3" />
            Library
          </button>
          <button
            type="button"
            onClick={() => setMode("upload")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
              mode === "upload"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <UploadCloud className="size-3" />
            Import
          </button>
          <button
            type="button"
            onClick={() => setMode("generate")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
              mode === "generate"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Sparkles className="size-3" />
            AI
          </button>
          <button
            type="button"
            onClick={() => setMode("folder")}
            className={cn(
              "flex items-center gap-1 rounded px-2 py-1 text-xs transition",
              mode === "folder"
                ? "bg-primary text-primary-foreground"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <FolderOpen className="size-3" />
            Folder
          </button>
        </div>
      </div>

      {mode === "folder" && (
        <div className="space-y-4">
          <div className="rounded-lg border border-dashed border-border/60 bg-muted/20 p-4">
            <p className="mb-3 text-xs text-muted-foreground">
              Pick tracks from any folder on your computer. Files are used directly — nothing is added to your library.
            </p>
            <div className="flex gap-2">
              <Input
                placeholder="e.g. C:\Music\LoFi Mix or /home/user/music"
                value={folderPath}
                onChange={(e) => setFolderPath(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleScanFolder()}
                className="font-mono text-xs"
              />
              <Button
                onClick={() => setFolderBrowserOpen(true)}
                size="sm"
                variant="outline"
                title="Open folder picker"
              >
                <FolderOpen className="size-4" />
                Browse…
              </Button>
              <Button
                onClick={() => handleScanFolder()}
                disabled={folderScanning || !folderPath.trim()}
                size="sm"
                variant="secondary"
              >
                {folderScanning ? <Loader2 className="size-4 animate-spin" /> : "Scan"}
              </Button>
            </div>
            <FolderPickerDialog
              open={folderBrowserOpen}
              onOpenChange={setFolderBrowserOpen}
              initialPath={folderPath || channelLastConfig?.music_folder_path || ""}
              onPick={(picked) => {
                setFolderPath(picked);
                // Auto-scan after picking so the user lands on the
                // tracklist immediately. Skipping the manual Scan
                // click matches the "browse-and-go" feel of native
                // OS file pickers.
                setTimeout(() => handleScanFolder(picked), 0);
              }}
            />
          </div>

          {folderTracks.length > 0 && (
            <>
              <div className="flex items-center justify-between">
                <span className="text-xs text-muted-foreground">
                  {folderTracks.length} track(s) found · {folderSelectedPaths.length} selected
                  {folderSelectedPaths.length > 0 && ` · ${formatDuration(folderTotalDuration)} total`}
                </span>
                <div className="flex gap-1">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setFolderSelectedPaths(folderTracks.map((t) => t.path))}
                  >
                    Select all
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => setFolderSelectedPaths([])}
                  >
                    Clear
                  </Button>
                </div>
              </div>

              {/* Track selection list */}
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/40 bg-muted/10 p-2">
                {folderTracks.map((track) => {
                  const selected = folderSelectedPaths.includes(track.path);
                  return (
                    <button
                      key={track.path}
                      type="button"
                      onClick={() => toggleFolderTrack(track.path)}
                      className={cn(
                        "flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm transition",
                        selected
                          ? "bg-primary/10 text-foreground ring-1 ring-primary/30"
                          : "hover:bg-muted/60 text-muted-foreground",
                      )}
                    >
                      <Music className={cn("size-3.5 shrink-0", selected ? "text-primary" : "")} />
                      <span className="min-w-0 flex-1 truncate text-xs font-medium">
                        {track.filename}
                      </span>
                      <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
                        {track.duration > 0 ? formatDuration(track.duration) : "—"}
                      </span>
                    </button>
                  );
                })}
              </div>

              {/* Playback order — drag to reorder selected tracks */}
              {folderSelectedPaths.length > 0 && (
                <div className="space-y-1.5">
                  <p className="text-xs font-medium text-muted-foreground">
                    Playback order
                    {folderSelectedPaths.length > 1 && (
                      <span className="ml-1 opacity-60">· drag to reorder</span>
                    )}
                  </p>
                  <div className="space-y-0.5 rounded-md border border-border/40 bg-muted/10 p-1.5">
                    {folderSelectedPaths.map((path, idx) => {
                      const meta = folderTracks.find((t) => t.path === path);
                      const filename = meta?.filename ?? path.split(/[\\/]/).pop() ?? path;
                      const duration = meta?.duration ?? 0;
                      return (
                        <div
                          key={path}
                          draggable
                          onDragStart={() => { dragSrcIdx.current = idx; }}
                          onDragOver={(e) => { e.preventDefault(); setDragOverIdx(idx); }}
                          onDragLeave={() => setDragOverIdx(null)}
                          onDrop={(e) => {
                            e.preventDefault();
                            if (dragSrcIdx.current !== null) moveFolderTrack(dragSrcIdx.current, idx);
                            dragSrcIdx.current = null;
                            setDragOverIdx(null);
                          }}
                          onDragEnd={() => { dragSrcIdx.current = null; setDragOverIdx(null); }}
                          className={cn(
                            "flex items-center gap-2 rounded px-2 py-1.5 text-xs transition select-none",
                            dragOverIdx === idx
                              ? "bg-primary/20 ring-1 ring-primary/40"
                              : "hover:bg-muted/40",
                          )}
                        >
                          <GripVertical className="size-3.5 shrink-0 cursor-grab text-muted-foreground/50 active:cursor-grabbing" />
                          <span className="min-w-0 flex-1 truncate font-medium text-foreground">
                            {filename}
                          </span>
                          <span className="shrink-0 tabular-nums text-muted-foreground">
                            {duration > 0 ? formatDuration(duration) : "—"}
                          </span>
                          <div className="flex shrink-0 gap-0.5">
                            <button
                              type="button"
                              disabled={idx === 0}
                              onClick={() => moveFolderTrack(idx, idx - 1)}
                              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                            >
                              <ArrowUp className="size-3" />
                            </button>
                            <button
                              type="button"
                              disabled={idx === folderSelectedPaths.length - 1}
                              onClick={() => moveFolderTrack(idx, idx + 1)}
                              className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-30"
                            >
                              <ArrowDown className="size-3" />
                            </button>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {folderSelectedPaths.length > 0 && (
                <div className="flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2.5 text-sm">
                  <Check className="size-4 text-primary" />
                  <span className="font-medium">
                    {folderSelectedPaths.length} track{folderSelectedPaths.length !== 1 ? "s" : ""} ready
                  </span>
                  <span className="text-muted-foreground">
                    · {formatDuration(folderTotalDuration)} · click Next to continue
                  </span>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {mode === "library" && (
        <div className="space-y-3">
          {!musicAssets || musicAssets.length === 0 ? (
            <Card>
              <CardContent className="py-8 text-center">
                <Music className="mx-auto mb-2 size-8 text-muted-foreground" />
                <p className="text-sm text-muted-foreground">
                  No music assets for this channel yet.
                </p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Upload tracks in the Assets page first, or switch to Import File.
                </p>
              </CardContent>
            </Card>
          ) : (
            <>
              <LibraryToolsBar
                channelId={project.channel_id}
                clearSelection={() => setSelectedIds([])}
              />
              <RandomPickBar
                total={musicAssets.length}
                onPick={(n) => {
                  // Fisher-Yates shuffle + slice n
                  const pool = musicAssets.map((a) => a.id);
                  for (let i = pool.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [pool[i], pool[j]] = [pool[j], pool[i]];
                  }
                  setSelectedIds(pool.slice(0, Math.min(n, pool.length)));
                  toast.success(`Picked ${Math.min(n, pool.length)} random tracks`);
                }}
              />

              {/* Search + sort toolbar */}
              <div className="flex flex-wrap items-center gap-2">
                <div className="relative flex-1 min-w-[180px]">
                  <Input
                    value={librarySearch}
                    onChange={(e) => setLibrarySearch(e.target.value)}
                    placeholder="Search by name…"
                    className="pl-8 h-9"
                  />
                  <Music className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                </div>
                <Select
                  value={librarySort}
                  onValueChange={(v) => setLibrarySort(v as typeof librarySort)}
                >
                  <SelectTrigger className="h-9 w-44">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="newest">Newest first</SelectItem>
                    <SelectItem value="oldest">Oldest first</SelectItem>
                    <SelectItem value="name_asc">Name (A–Z)</SelectItem>
                    <SelectItem value="name_desc">Name (Z–A)</SelectItem>
                  </SelectContent>
                </Select>
                <span className="text-xs text-muted-foreground">
                  {filteredMusicAssets.length}
                  {filteredMusicAssets.length !== musicAssets.length
                    ? ` of ${musicAssets.length}`
                    : ""}{" "}
                  tracks
                </span>
              </div>

              {/* Scrollable track list */}
              <div className="max-h-[480px] grid grid-cols-1 gap-2 overflow-y-auto rounded-md border border-border/40 bg-background/30 p-1 sm:grid-cols-2 xl:grid-cols-3">
                {filteredMusicAssets.length === 0 ? (
                  <p className="col-span-full py-6 text-center text-xs text-muted-foreground">
                    No tracks match "{librarySearch}".
                  </p>
                ) : (
                  filteredMusicAssets.map((asset) => {
                    const isSelected = selectedIds.includes(asset.id);
                    const selIndex = selectedIds.indexOf(asset.id);
                    return (
                      <Card
                        key={asset.id}
                        className={cn(
                          "cursor-pointer transition-colors",
                          isSelected
                            ? "ring-2 ring-primary bg-primary/5"
                            : "hover:bg-accent/50",
                        )}
                        onClick={() => toggleSelect(asset.id)}
                      >
                        <CardContent className="flex items-center gap-3 py-2">
                          {/* Selection indicator */}
                          <div
                            className={cn(
                              "flex size-8 shrink-0 items-center justify-center rounded-full border-2 text-xs font-bold transition-colors",
                              isSelected
                                ? "border-primary bg-primary text-primary-foreground"
                                : "border-muted-foreground/30 text-muted-foreground",
                            )}
                          >
                            {isSelected ? selIndex + 1 : ""}
                          </div>
                          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                            <Music className="size-5 text-blue-400" />
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-medium">
                              {asset.title || asset.filename}
                            </p>
                            {asset.description && (
                              <p className="truncate text-xs text-muted-foreground">
                                {asset.description}
                              </p>
                            )}
                            <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted-foreground">
                              {asset.duration_seconds && (
                                <span>{formatDuration(asset.duration_seconds)}</span>
                              )}
                              {asset.file_size && (
                                <span>
                                  {(asset.file_size / 1024 / 1024).toFixed(1)} MB
                                </span>
                              )}
                              {asset.created_at && (
                                <span
                                  title={new Date(asset.created_at).toLocaleString()}
                                  className="flex items-center gap-1"
                                >
                                  <Clock className="size-3" />
                                  {(() => {
                                    const d = new Date(asset.created_at);
                                    const sameYear =
                                      d.getFullYear() === new Date().getFullYear();
                                    return formatDate(d, sameYear ? "d MMM" : "d MMM yyyy");
                                  })()}
                                </span>
                              )}
                            </div>
                          </div>
                          {isSelected && (
                            <Badge variant="secondary">
                              <Check className="size-3" />
                            </Badge>
                          )}
                        </CardContent>
                      </Card>
                    );
                  })
                )}
              </div>

              {/* Selection summary bar — selection auto-saves; no separate
                  "Use N tracks" click required. Just hit Next at the bottom. */}
              {selectedIds.length > 0 && (
                <Card className="border-primary/50 bg-primary/5">
                  <CardContent className="flex items-center justify-between gap-3 py-3">
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-1.5 text-sm font-medium">
                        <Check className="size-4 text-primary" />
                        {selectedIds.length} track{selectedIds.length > 1 ? "s" : ""} ready
                      </div>
                      <Separator orientation="vertical" className="h-4" />
                      <div className="flex items-center gap-1 text-sm text-muted-foreground">
                        <Clock className="size-3.5" />
                        {formatDuration(totalDuration)}
                      </div>
                      <Separator orientation="vertical" className="h-4" />
                      <span className="text-xs text-muted-foreground">
                        Click Next to continue
                      </span>
                    </div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        setSelectedIds([]);
                      }}
                    >
                      <X className="size-3.5" />
                      Clear
                    </Button>
                  </CardContent>
                </Card>
              )}
            </>
          )}
        </div>
      )}

      {mode === "generate" && (
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="music-prompt">Music Prompt</Label>
            <Textarea
              id="music-prompt"
              placeholder="e.g. Calm lofi hip hop beat with warm piano chords, soft drums, vinyl crackle..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={3}
            />
          </div>
          <Button
            onClick={handleGenerate}
            disabled={generating || !prompt.trim()}
            className="w-full"
          >
            {generating ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                Generate Music
              </>
            )}
          </Button>
          {generating && task && (
            <div className="space-y-2">
              <Progress value={task.progress}>
                <span className="text-xs text-muted-foreground">
                  {task.status_message ?? "Processing..."}
                </span>
              </Progress>
            </div>
          )}
        </div>
      )}

      {mode === "upload" && (
        <div className="space-y-4">
          <ImportFolderRow
            channelId={project.channel_id}
            onImported={(ids) => {
              if (ids.length > 0) setSelectedIds(ids);
            }}
          />

          <div className="relative">
            <Separator />
            <span className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 bg-background px-2 text-xs text-muted-foreground">
              or pick individual files
            </span>
          </div>

          <label
            htmlFor="music-upload"
            className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border-2 border-dashed border-border p-6 transition-colors hover:border-primary/50 hover:bg-accent/50"
          >
            <UploadCloud className="size-7 text-muted-foreground" />
            <div className="text-center">
              <p className="text-sm font-medium">Pick file(s) from your computer</p>
              <p className="text-xs text-muted-foreground">
                MP3, WAV, FLAC, OGG, M4A — uploads through the browser
              </p>
            </div>
            <input
              id="music-upload"
              type="file"
              accept="audio/*"
              multiple
              className="hidden"
              onChange={handleFileUpload}
            />
          </label>

          {uploadAsset.isPending && (
            <div className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Uploading...
            </div>
          )}
        </div>
      )}

      {(audioUrl || hasMusicAsset) && (
        <Card>
          <CardContent className="flex items-center gap-3">
            <Button
              size="icon"
              variant="outline"
              onClick={togglePlayback}
            >
              {isPlaying ? (
                <Pause className="size-4" />
              ) : (
                <Play className="size-4" />
              )}
            </Button>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">Music Ready</p>
              <p className="text-xs text-muted-foreground">
                Audio asset attached to project
              </p>
            </div>
            <Badge variant="secondary">
              <Check className="size-3" />
              Ready
            </Badge>
            {audioUrl && (
              <audio
                ref={audioRef}
                src={audioUrl}
                onEnded={() => setIsPlaying(false)}
              />
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

// ── Private helpers — co-located because they're only used by MusicStep ──────

/**
 * Compact utility row above the music library — currently just a reconcile
 * button that purges DB rows for files that have been deleted from disk.
 * Ghost entries appear when you remove audio files directly in the folder.
 */
function LibraryToolsBar({
  channelId,
  clearSelection,
}: {
  channelId: number;
  clearSelection: () => void;
}) {
  const [running, setRunning] = useState(false);
  const qc = useQueryClient();

  const reconcile = async () => {
    if (!confirm("Purge music assets whose files are no longer on disk?")) return;
    setRunning(true);
    try {
      const { data } = await api.post(
        `/assets/reconcile?channel_id=${channelId}&asset_type=music`,
      );
      const removed = Number(data?.removed ?? 0);
      toast.success(
        removed > 0 ? `Removed ${removed} missing file(s)` : "Library is clean",
      );
      clearSelection();
      await qc.invalidateQueries({ queryKey: ["assets"] });
    } catch {
      toast.error("Failed to reconcile");
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="flex items-center justify-end gap-2 text-xs text-muted-foreground">
      <Button
        variant="ghost"
        size="xs"
        onClick={reconcile}
        disabled={running}
      >
        {running ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        Clean up missing files
      </Button>
    </div>
  );
}

/**
 * "Pick N random tracks" row shown above the library list. Picks a random
 * subset of the channel's music assets for the project (Fisher-Yates shuffle).
 * Useful for long mix videos where the selection doesn't need to be curated.
 */
function RandomPickBar({
  total,
  onPick,
}: {
  total: number;
  onPick: (n: number) => void;
}) {
  const [count, setCount] = useState<number>(Math.min(10, total));
  return (
    <Card className="border-primary/30 bg-primary/5">
      <CardContent className="flex flex-wrap items-center gap-3 py-3">
        <Sparkles className="size-4 text-primary" />
        <span className="text-sm font-medium">Random pick</span>
        <span className="text-xs text-muted-foreground">
          Shuffle &amp; select N random tracks from this channel's library ({total} total)
        </span>
        <div className="flex-1" />
        <div className="flex items-center gap-2">
          <Input
            type="number"
            min={1}
            max={total}
            value={count}
            onChange={(e) => {
              const v = parseInt(e.target.value, 10);
              if (!Number.isNaN(v)) setCount(Math.max(1, Math.min(total, v)));
            }}
            className="h-8 w-20"
          />
          <Button
            size="sm"
            onClick={() => onPick(count)}
            disabled={total === 0 || count < 1}
          >
            <RefreshCw className="size-3.5" />
            Pick {count}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
