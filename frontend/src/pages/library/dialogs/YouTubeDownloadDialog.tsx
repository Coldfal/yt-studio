/**
 * YouTube → MP3 download dialog (extracted from ``AssetsPage.tsx`` in
 * Phase 2). Self-contained: takes ``open``, ``onOpenChange``, and the
 * channel list as props; manages its own URL/folder/title/chapter
 * state internally and drives the ``ytdlp`` task through to completion.
 *
 * Two modes depending on the video:
 * - **Single-file mode** — when no chapter ticks are selected, the whole
 *   audio gets saved as one MP3 (using the optional Custom Title).
 * - **Chapter mode** — when at least one chapter section is ticked,
 *   each pick becomes its own Asset row named after the chapter.
 */
import { useEffect, useState } from "react";
import {
  Clock,
  Download,
  Eye,
  Loader2,
  Plus,
  Scissors,
  Search,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Progress } from "@/components/ui/progress";
import {
  useCreateFolder,
  useFolders,
  useYouTubeDownload,
  useYouTubeDownloadChapters,
  useYouTubeInfo,
  useYouTubeVideoDownload,
  useYouTubeVideoDownloadSections,
} from "@/hooks/use-assets";
import { useTask } from "@/hooks/use-tasks";
import { cn } from "@/lib/utils";
import { YtIcon } from "@/components/icons/YtIcon";

interface YouTubeDownloadDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: { id: number; name: string }[];
}

export function YouTubeDownloadDialog({
  open,
  onOpenChange,
  channels,
}: YouTubeDownloadDialogProps) {
  // Audio | Video toggle at the top of the dialog. Audio mode is the
  // historical default — drives the existing music-folder flow.
  // Video mode targets the channel's video/ folder and produces MP4s
  // that immediately show up in the visualizer's background-video picker.
  const [mode, setMode] = useState<"audio" | "video">("audio");

  const [url, setUrl] = useState("");
  const [channelId, setChannelId] = useState("");
  const [folderId, setFolderId] = useState<string>(""); // "" = unfiled, "<id>" = pick that folder
  const [newFolderName, setNewFolderName] = useState("");
  const [customTitle, setCustomTitle] = useState("");
  const [taskId, setTaskId] = useState<number | null>(null);
  const fetchInfo = useYouTubeInfo();
  const startDownload = useYouTubeDownload();
  const startChaptersDownload = useYouTubeDownloadChapters();
  const startVideoDownload = useYouTubeVideoDownload();
  const startVideoSectionsDownload = useYouTubeVideoDownloadSections();
  // Folder list is keyed on the active mode — music folders for audio,
  // video folders for video — so the user can't accidentally save a
  // download into the wrong type's folder tree.
  const { data: folders } = useFolders({
    channel_id: channelId ? Number(channelId) : undefined,
    asset_type: mode === "audio" ? "music" : "video",
  });
  const createFolder = useCreateFolder();
  const { data: task } = useTask(taskId ?? undefined);
  // Chapter selection: by index. When the video has chapters, the user
  // ticks which to download — each becomes a separate Asset.
  const [selectedChapterIdx, setSelectedChapterIdx] = useState<Set<number>>(
    new Set(),
  );
  // User-defined sections (raw strings preserved so partial edits don't
  // get clobbered while typing). Each row gets sliced by FFmpeg server-side
  // with the same chapter pipeline as auto-detected chapters — merged with
  // ticked auto-chapters before submission. Empty list = ignored.
  type CustomSection = { title: string; startStr: string; endStr: string };
  const [customSections, setCustomSections] = useState<CustomSection[]>([]);

  useEffect(() => {
    const isYt =
      url.includes("youtube.com/watch") ||
      url.includes("youtu.be/") ||
      url.includes("youtube.com/shorts/");
    if (isYt && !fetchInfo.data && !fetchInfo.isPending) {
      fetchInfo.mutate(url);
    }
    setSelectedChapterIdx(new Set());
    setCustomSections([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url]);

  const info = fetchInfo.data;

  /**
   * Parse a user-entered time string into seconds.
   *
   * Accepts the obvious shapes:
   *   "0:45"      → 45
   *   "3:20"      → 200
   *   "1:23:45"   → 5025
   *   "230"       → 230   (bare seconds also fine)
   *
   * Returns ``null`` for anything that doesn't parse. We never throw —
   * the row UI surfaces invalid rows by colour, not exceptions.
   */
  const parseTimeStr = (raw: string): number | null => {
    const s = raw.trim();
    if (!s) return null;
    if (/^\d+(\.\d+)?$/.test(s)) {
      const n = Number(s);
      return Number.isFinite(n) && n >= 0 ? n : null;
    }
    const parts = s.split(":").map((p) => p.trim());
    if (parts.length < 2 || parts.length > 3) return null;
    if (!parts.every((p) => /^\d+(\.\d+)?$/.test(p))) return null;
    const nums = parts.map(Number);
    if (!nums.every((n) => Number.isFinite(n) && n >= 0)) return null;
    let secs = 0;
    if (nums.length === 2) secs = nums[0] * 60 + nums[1];
    else secs = nums[0] * 3600 + nums[1] * 60 + nums[2];
    return secs;
  };

  /** Build the chapter array sent to the backend, merging auto-picked
   *  chapters and user-defined custom sections. Skips rows with bad
   *  times so a typo doesn't fail the whole submit. */
  const buildChaptersForSubmit = (): {
    chapters: { title: string; start: number; end: number; duration: number }[];
    badRowCount: number;
  } => {
    const merged: { title: string; start: number; end: number; duration: number }[] = [];
    let bad = 0;

    // 1) Auto-detected chapters the user ticked
    const auto = info?.chapters ?? [];
    for (let i = 0; i < auto.length; i++) {
      if (selectedChapterIdx.has(i)) merged.push(auto[i]);
    }

    // 2) User-defined custom sections
    for (const sec of customSections) {
      const start = parseTimeStr(sec.startStr);
      const end = parseTimeStr(sec.endStr);
      const title = sec.title.trim();
      if (start == null || end == null || end <= start || !title) {
        bad += 1;
        continue;
      }
      merged.push({ title, start, end, duration: end - start });
    }

    return { chapters: merged, badRowCount: bad };
  };

  const handleDownload = async () => {
    // If user typed a new folder name, create it first and use the new ID.
    // The new folder is typed for the ACTIVE mode (music | video) so it
    // ends up in the right per-type folder tree.
    let resolvedFolderId: number | undefined;
    const trimmedNew = newFolderName.trim();
    try {
      if (trimmedNew) {
        const created = await createFolder.mutateAsync({
          channel_id: Number(channelId),
          asset_type: mode === "audio" ? "music" : "video",
          name: trimmedNew,
        });
        resolvedFolderId = created.id;
      } else if (folderId && folderId !== "__none__") {
        resolvedFolderId = Number(folderId);
      }
    } catch {
      toast.error("Failed to create folder");
      return;
    }

    // Channel is REQUIRED. Folder is optional organising. Allowing
    // "folder only" was the root cause of the wrong-channel bug — the
    // backend defaulted the channel and assets ended up in the wrong
    // library. Always force an explicit channel pick now.
    if (!channelId) {
      toast.error("Pick a channel for this download");
      return;
    }

    // Section mode: user ticked auto-chapters and/or added custom
    // sections → each gets sliced by FFmpeg into its own Asset.
    // Branches on mode: audio → MP3 chapters endpoint; video → MP4
    // sections endpoint (re-encoded, sample-accurate cuts).
    const { chapters: mergedChapters, badRowCount } = buildChaptersForSubmit();
    if (mergedChapters.length > 0) {
      if (badRowCount > 0) {
        toast.error(
          `${badRowCount} custom section${badRowCount === 1 ? " has" : "s have"} invalid times — fix or remove them first`,
        );
        return;
      }
      try {
        const payload = {
          url,
          channel_id: Number(channelId),
          folder_id: resolvedFolderId,
        } as const;
        const result = mode === "audio"
          ? await startChaptersDownload.mutateAsync({
              ...payload,
              chapters: mergedChapters,
            })
          : await startVideoSectionsDownload.mutateAsync({
              ...payload,
              sections: mergedChapters,
            });
        setTaskId(result.task_id);
      } catch {
        toast.error(
          mode === "audio"
            ? "Failed to start chapter download"
            : "Failed to start video sections download",
        );
      }
      return;
    }

    // Single-file mode: download the whole asset as one file.
    // Audio → one MP3; Video → one MP4 (1080p cap).
    try {
      const payload = {
        url,
        channel_id: channelId ? Number(channelId) : undefined,
        folder_id: resolvedFolderId,
        title: customTitle.trim() || info?.title,
      } as const;
      const result = mode === "audio"
        ? await startDownload.mutateAsync(payload)
        : await startVideoDownload.mutateAsync(payload);
      setTaskId(result.task_id);
    } catch {
      toast.error(
        mode === "audio"
          ? "Failed to start download"
          : "Failed to start video download",
      );
    }
  };

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setMode("audio");
      setUrl("");
      setChannelId("");
      setFolderId("");
      setNewFolderName("");
      setCustomTitle("");
      setSelectedChapterIdx(new Set());
      setCustomSections([]);
      setTaskId(null);
      fetchInfo.reset();
    }
    onOpenChange(nextOpen);
  };

  // Switching modes clears the folder pick (folder lists are per-type
  // so the previously-selected id may not exist in the new list) and
  // any in-flight task state. URL + chapter ticks stay so the operator
  // can flip modes without re-pasting.
  const switchMode = (next: "audio" | "video") => {
    if (next === mode) return;
    setMode(next);
    setFolderId("");
    setNewFolderName("");
    setTaskId(null);
  };

  const isComplete = task?.status === "completed";
  const isFailed = task?.status === "failed";
  const isRunning = task?.status === "running" || task?.status === "pending";

  const fmtDuration = (s: number) => {
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${sec.toString().padStart(2, "0")}`;
  };

  const fmtViews = (n: number | null) => {
    if (!n) return "";
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M views`;
    if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K views`;
    return `${n} views`;
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <YtIcon className="size-5 text-red-500" />
            Download from YouTube
          </DialogTitle>
          <DialogDescription>
            {mode === "audio"
              ? "Paste a YouTube link to extract the audio as MP3 into your music library."
              : "Paste a YouTube link to save the video (≤1080p MP4) into your video library. Pick sections to slice it into clips."}
          </DialogDescription>
        </DialogHeader>

        {/* Mode toggle — Audio (MP3) vs Video (MP4). Folder lists +
            download endpoint branch on this. */}
        <div className="mt-1 grid grid-cols-2 gap-1 rounded-md border border-border bg-muted/30 p-1">
          <button
            type="button"
            onClick={() => switchMode("audio")}
            disabled={isRunning}
            className={cn(
              "rounded px-3 py-1.5 text-xs font-medium transition",
              mode === "audio"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            🎵 Audio (MP3)
          </button>
          <button
            type="button"
            onClick={() => switchMode("video")}
            disabled={isRunning}
            className={cn(
              "rounded px-3 py-1.5 text-xs font-medium transition",
              mode === "video"
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            🎬 Video (MP4 ≤1080p)
          </button>
        </div>

        <div className="mt-2 space-y-4">
          <div className="space-y-2">
            <Label htmlFor="yt-url">YouTube URL</Label>
            <div className="flex gap-2">
              <Input
                id="yt-url"
                placeholder="https://www.youtube.com/watch?v=..."
                value={url}
                onChange={(e) => {
                  setUrl(e.target.value);
                  fetchInfo.reset();
                  setTaskId(null);
                }}
                disabled={isRunning}
              />
              {url && !info && !fetchInfo.isPending && (
                <Button variant="outline" size="sm" onClick={() => fetchInfo.mutate(url)}>
                  <Search className="size-4" />
                </Button>
              )}
            </div>
            {fetchInfo.isPending && (
              <p className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" /> Fetching video info...
              </p>
            )}
            {fetchInfo.isError && (
              <p className="text-xs text-destructive">
                Could not fetch video info. Check the URL and try again.
              </p>
            )}
          </div>

          {info && (
            <Card className="overflow-hidden">
              <CardContent className="flex gap-3 p-3">
                {info.thumbnail && (
                  <img
                    src={info.thumbnail}
                    alt=""
                    className="h-20 w-36 shrink-0 rounded object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="line-clamp-2 text-sm font-medium">{info.title}</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{info.uploader}</p>
                  <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                    {info.duration > 0 && (
                      <span className="flex items-center gap-1">
                        <Clock className="size-3" />
                        {fmtDuration(info.duration)}
                      </span>
                    )}
                    {info.view_count != null && (
                      <span className="flex items-center gap-1">
                        <Eye className="size-3" />
                        {fmtViews(info.view_count)}
                      </span>
                    )}
                  </div>
                </div>
              </CardContent>
            </Card>
          )}

          {info && !taskId && (
            <>
              <div className="space-y-2">
                <Label>
                  Channel{" "}
                  <span className="text-destructive font-normal">*</span>
                </Label>
                <Select
                  value={channelId}
                  onValueChange={(v) => setChannelId(v)}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Select a channel..." />
                  </SelectTrigger>
                  <SelectContent>
                    {channels.map((ch) => (
                      <SelectItem key={ch.id} value={String(ch.id)}>
                        {ch.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {!channelId && (
                  <p className="text-[11px] text-muted-foreground">
                    Required. Tracks must belong to a channel — folders are
                    just organisation within the channel's library.
                  </p>
                )}
              </div>

              {/* Asset-library folder picker. Folders are channel-agnostic —
                  selecting a folder alone is enough to download. Type in the
                  text field to create a new folder on the fly. */}
              <div className="space-y-2">
                <Label>Folder</Label>
                <Select
                  value={folderId || "__none__"}
                  onValueChange={(v) => {
                    setFolderId(v);
                    if (v) setNewFolderName("");
                  }}
                  disabled={!!newFolderName.trim()}
                >
                  <SelectTrigger className="w-full">
                    <SelectValue placeholder="Unfiled" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="__none__">Unfiled</SelectItem>
                    {(folders ?? []).map((f) => (
                      <SelectItem key={f.id} value={String(f.id)}>
                        {f.name}
                        <span className="ml-1 text-xs text-muted-foreground">
                          ({f.asset_count})
                        </span>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Input
                  placeholder="Or type a new folder name to create…"
                  value={newFolderName}
                  onChange={(e) => {
                    setNewFolderName(e.target.value);
                    if (e.target.value.trim()) setFolderId("");
                  }}
                />
              </div>

              {/* Chapter sections detected from the description. Tick to
                  pick which slices to download as separate MP3s named after
                  the chapter. If nothing is ticked, the whole video is
                  downloaded as a single file (using the Custom Title). */}
              {info.chapters && info.chapters.length > 0 && (
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <Label>
                      Sections{" "}
                      <span className="text-muted-foreground font-normal">
                        ({info.chapters.length} found)
                      </span>
                    </Label>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() =>
                          setSelectedChapterIdx(
                            new Set(info.chapters!.map((_, i) => i)),
                          )
                        }
                      >
                        All
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setSelectedChapterIdx(new Set())}
                      >
                        None
                      </Button>
                    </div>
                  </div>
                  <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border border-border/40 bg-muted/10 p-2">
                    {info.chapters.map((ch, i) => {
                      const checked = selectedChapterIdx.has(i);
                      return (
                        <label
                          key={i}
                          className={cn(
                            "flex cursor-pointer items-center gap-3 rounded px-2 py-1.5 text-sm transition",
                            checked ? "bg-primary/10" : "hover:bg-muted/40",
                          )}
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={(e) => {
                              setSelectedChapterIdx((prev) => {
                                const next = new Set(prev);
                                if (e.target.checked) next.add(i);
                                else next.delete(i);
                                return next;
                              });
                            }}
                            className="size-3.5"
                          />
                          <span className="min-w-0 flex-1 truncate font-medium">
                            {ch.title}
                          </span>
                          <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
                            {fmtDuration(ch.start)}–{fmtDuration(ch.end)}
                            {" · "}
                            {fmtDuration(ch.duration)}
                          </span>
                        </label>
                      );
                    })}
                  </div>
                  {selectedChapterIdx.size > 0 && (
                    <p className="text-[11px] text-muted-foreground">
                      {selectedChapterIdx.size} section
                      {selectedChapterIdx.size !== 1 ? "s" : ""} will be saved
                      as separate MP3 files named after each section.
                    </p>
                  )}
                </div>
              )}

              {/* Custom sections — manual time-range slicing for videos
                  that don't have a chapter list in the description. Each
                  row becomes its own MP3 Asset with FFmpeg's -ss/-to.
                  Coexists with auto-detected chapter ticks: ticks +
                  custom rows are merged before submission. */}
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <Label className="flex items-center gap-1.5">
                    <Scissors className="size-3.5" />
                    Custom sections{" "}
                    <span className="text-muted-foreground font-normal">
                      (define your own splits)
                    </span>
                  </Label>
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() =>
                      setCustomSections((prev) => [
                        ...prev,
                        { title: "", startStr: "", endStr: "" },
                      ])
                    }
                  >
                    <Plus className="size-3.5" /> Add
                  </Button>
                </div>
                {customSections.length === 0 ? (
                  <p className="text-[11px] text-muted-foreground">
                    Click <strong>Add</strong> to slice this video at specific
                    times. Useful when there are no chapters and you want
                    only one part as its own song.
                  </p>
                ) : (
                  <div className="space-y-1.5 rounded-md border border-border/40 bg-muted/10 p-2">
                    {customSections.map((sec, i) => {
                      const start = parseTimeStr(sec.startStr);
                      const end = parseTimeStr(sec.endStr);
                      const titleOk = sec.title.trim().length > 0;
                      const startOk = start != null;
                      const endOk = end != null;
                      const orderOk =
                        startOk && endOk && (end as number) > (start as number);
                      const inRange =
                        !info.duration ||
                        (endOk && (end as number) <= info.duration + 1);
                      const rowValid =
                        titleOk && startOk && endOk && orderOk && inRange;
                      return (
                        <div
                          key={i}
                          className={cn(
                            "flex items-center gap-1.5 rounded px-1 py-1",
                            !rowValid &&
                              (sec.title || sec.startStr || sec.endStr) &&
                              "ring-1 ring-destructive/40",
                          )}
                        >
                          <Input
                            className="h-7 min-w-0 flex-1 text-sm"
                            placeholder="Section name"
                            value={sec.title}
                            onChange={(e) =>
                              setCustomSections((prev) =>
                                prev.map((s, j) =>
                                  j === i ? { ...s, title: e.target.value } : s,
                                ),
                              )
                            }
                          />
                          <Input
                            className={cn(
                              "h-7 w-[70px] tabular-nums text-sm",
                              !startOk && sec.startStr && "border-destructive",
                            )}
                            placeholder="0:00"
                            value={sec.startStr}
                            onChange={(e) =>
                              setCustomSections((prev) =>
                                prev.map((s, j) =>
                                  j === i ? { ...s, startStr: e.target.value } : s,
                                ),
                              )
                            }
                          />
                          <span className="text-xs text-muted-foreground">→</span>
                          <Input
                            className={cn(
                              "h-7 w-[70px] tabular-nums text-sm",
                              ((!endOk && sec.endStr) ||
                                (startOk && endOk && !orderOk)) &&
                                "border-destructive",
                            )}
                            placeholder={
                              info.duration > 0
                                ? fmtDuration(info.duration)
                                : "3:30"
                            }
                            value={sec.endStr}
                            onChange={(e) =>
                              setCustomSections((prev) =>
                                prev.map((s, j) =>
                                  j === i ? { ...s, endStr: e.target.value } : s,
                                ),
                              )
                            }
                          />
                          <Button
                            variant="ghost"
                            size="xs"
                            onClick={() =>
                              setCustomSections((prev) =>
                                prev.filter((_, j) => j !== i),
                              )
                            }
                          >
                            <X className="size-3" />
                          </Button>
                        </div>
                      );
                    })}
                    <p className="text-[11px] text-muted-foreground">
                      Use mm:ss or h:mm:ss
                      {info.duration > 0
                        ? ` · video length ${fmtDuration(info.duration)}`
                        : ""}
                      .
                    </p>
                  </div>
                )}
              </div>

              {selectedChapterIdx.size === 0 && customSections.length === 0 && (
                <div className="space-y-2">
                  <Label htmlFor="yt-title">Custom Title (optional)</Label>
                  <Input
                    id="yt-title"
                    placeholder={info.title}
                    value={customTitle}
                    onChange={(e) => setCustomTitle(e.target.value)}
                  />
                </div>
              )}
            </>
          )}

          {taskId && task && (
            <div className="space-y-2">
              {isRunning && (
                <>
                  <Progress value={task.progress ?? 0} />
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="size-3 animate-spin" />
                    {task.status_message || "Processing..."}
                  </p>
                </>
              )}
              {isComplete && (
                <div className="flex items-center gap-2 rounded-md border border-green-800 bg-green-950/40 p-3 text-sm text-green-400">
                  <Download className="size-4" />
                  Audio downloaded and saved to your library!
                </div>
              )}
              {isFailed && (
                <div className="space-y-2 rounded-md border border-red-800 bg-red-950/40 p-3 text-sm text-red-400">
                  <p>Download failed: {task.error || "Unknown error"}</p>
                </div>
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          {!taskId && info && (() => {
            const { chapters: pendingSections } = buildChaptersForSubmit();
            const hasSections = pendingSections.length > 0;
            const pending =
              startDownload.isPending ||
              startChaptersDownload.isPending ||
              startVideoDownload.isPending ||
              startVideoSectionsDownload.isPending;
            const label = (() => {
              if (mode === "audio") {
                return hasSections
                  ? `Download ${pendingSections.length} MP3${pendingSections.length === 1 ? "" : "s"}`
                  : "Download MP3";
              }
              return hasSections
                ? `Download ${pendingSections.length} MP4 section${pendingSections.length === 1 ? "" : "s"}`
                : "Download MP4";
            })();
            return (
              <Button onClick={handleDownload} disabled={pending || !channelId}>
                {pending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" /> Starting...
                  </>
                ) : (
                  <>
                    <Download className="size-4" /> {label}
                  </>
                )}
              </Button>
            );
          })()}
          {isComplete && <Button onClick={() => handleClose(false)}>Done</Button>}
          {isFailed && (
            <Button variant="outline" onClick={() => setTaskId(null)}>
              Try Again
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
