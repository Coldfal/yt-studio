import { useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  AlertTriangle,
  Check,
  Image as ImageIcon,
  Loader2,
  Upload,
  X,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { useAsset, useAssets, useUploadAsset } from "@/hooks/use-assets";
import { useUpdateProject } from "@/hooks/use-projects";
import { useTask } from "@/hooks/use-tasks";
import { cn } from "@/lib/utils";
import type { VideoProject } from "@/types/index";

const MAX_THUMBNAIL_SIZE = 2 * 1024 * 1024; // 2 MB — YouTube's limit
const THUMBNAIL_FORMATS = ["image/jpeg", "image/png"];

export function ReviewUploadStep({
  project,
  channels,
  onUpload,
}: {
  project: VideoProject;
  channels: { id: number; name: string }[];
  onUpload: (privacy: string, scheduledAt: string | null) => Promise<number | null>;
}) {
  const [privacy, setPrivacy] = useState(project.youtube_privacy ?? "private");
  const [scheduledAt, setScheduledAt] = useState(
    project.youtube_scheduled_at ?? "",
  );
  const [uploading, setUploading] = useState(false);
  const [uploadTaskId, setUploadTaskId] = useState<number | null>(null);
  const [thumbnailUploading, setThumbnailUploading] = useState(false);
  const thumbnailInputRef = useRef<HTMLInputElement>(null);
  const navigate = useNavigate();

  const updateProject = useUpdateProject();
  const uploadAsset = useUploadAsset();

  // Load this channel's image library so the user can pick an existing
  // image as the YouTube thumbnail. We intentionally exclude videos —
  // YouTube only accepts JPEG/PNG/GIF for the thumbnail. ``file_exists``
  // filtering matches what ComposeStep does so the picker only shows
  // images that are still on disk.
  const { data: channelImageAssets } = useAssets({
    channel_id: String(project.channel_id),
    asset_type: "image",
  });
  const thumbnailLibrary = (channelImageAssets ?? []).filter(
    (a) => a.file_exists !== false,
  );
  const { data: thumbnailAsset } = useAsset(
    project.thumbnail_asset_id ?? undefined,
  );

  // Poll the active upload task for progress
  const { data: uploadTask } = useTask(uploadTaskId ?? undefined);
  const uploadHandledRef = useRef<number | null>(null);

  useEffect(() => {
    if (!uploadTask) return;
    if (uploadHandledRef.current === uploadTask.id) return;
    if (uploadTask.status === "completed") {
      uploadHandledRef.current = uploadTask.id;
      setUploading(false);
      toast.success("Video uploaded to YouTube!");
      // Give the toast a beat to render, then navigate so the user can see
      // the final state with the YouTube link on the detail page.
      setTimeout(() => navigate(`/projects/${project.id}`), 800);
    }
    if (uploadTask.status === "failed") {
      uploadHandledRef.current = uploadTask.id;
      setUploading(false);
      toast.error(uploadTask.error ?? "Upload failed");
    }
  }, [uploadTask, navigate, project.id]);

  const { data: composedAsset } = useAsset(project.composed_asset_id ?? undefined);
  const videoDurationMin = composedAsset?.duration_seconds
    ? Math.round(composedAsset.duration_seconds / 60)
    : null;
  const isLongVideo = videoDurationMin !== null && videoDurationMin > 15;

  const channelName =
    channels.find((c) => c.id === project.channel_id)?.name ?? "Unknown";

  const handleUpload = async () => {
    setUploading(true);
    uploadHandledRef.current = null;
    const taskId = await onUpload(privacy, scheduledAt || null);
    if (taskId) {
      setUploadTaskId(taskId);
    } else {
      setUploading(false);
    }
  };

  // Set a library image as the thumbnail — passes ``thumbnail_asset_id``
  // to /projects/{id}, which in turn is consumed by the YouTube upload
  // task. Toast feedback so the user can see the selection took.
  const handlePickThumbnail = async (assetId: number | null) => {
    try {
      await updateProject.mutateAsync({
        id: project.id,
        thumbnail_asset_id: assetId,
      });
      toast.success(assetId ? "Thumbnail set" : "Thumbnail cleared");
    } catch {
      toast.error("Failed to update thumbnail");
    }
  };

  // Upload a new file as a thumbnail. Lands in the channel's image
  // library (so it can be re-used) and the new asset is then set as
  // ``thumbnail_asset_id`` in one round-trip-ish.
  const handleUploadThumbnail = async (file: File) => {
    if (!THUMBNAIL_FORMATS.includes(file.type)) {
      toast.error("Use JPEG or PNG for thumbnails.");
      return;
    }
    if (file.size > MAX_THUMBNAIL_SIZE) {
      toast.error("Thumbnail too large (max 2MB — YouTube's limit).");
      return;
    }
    setThumbnailUploading(true);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("channel_id", String(project.channel_id));
      fd.append("asset_type", "image");
      fd.append("replace_existing", "true");
      const asset = await uploadAsset.mutateAsync(fd);
      await updateProject.mutateAsync({
        id: project.id,
        thumbnail_asset_id: asset.id,
      });
      toast.success("Thumbnail uploaded & set");
    } catch {
      toast.error("Thumbnail upload failed");
    } finally {
      setThumbnailUploading(false);
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl space-y-6">
      <div className="text-center">
        <h2 className="text-xl font-semibold">Review & Upload</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Review your project and upload to YouTube.
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Project Summary</CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Channel</span>
            <span className="font-medium">{channelName}</span>
          </div>
          <Separator />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Title</span>
            <span className="font-medium">
              {project.youtube_title ?? project.title}
            </span>
          </div>
          <Separator />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Style</span>
            <span className="font-medium">
              {project.video_style ?? "Not set"}
            </span>
          </div>
          <Separator />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Music</span>
            <Badge variant={project.music_asset_id ? "secondary" : "outline"}>
              {project.music_asset_id ? "Ready" : "Missing"}
            </Badge>
          </div>
          <Separator />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Images</span>
            <span className="font-medium">
              {project.image_asset_ids?.length ?? 0} images
            </span>
          </div>
          <Separator />
          <div className="flex justify-between text-sm">
            <span className="text-muted-foreground">Video</span>
            <Badge
              variant={project.composed_asset_id ? "secondary" : "outline"}
            >
              {project.composed_asset_id ? "Composed" : "Not composed"}
            </Badge>
          </div>
        </CardContent>
      </Card>

      {project.composed_asset_id && (
        <Card>
          <CardContent>
            <video
              controls
              className="w-full rounded-lg"
              src={`/api/assets/${project.composed_asset_id}/stream`}
            />
          </CardContent>
        </Card>
      )}

      {/* Thumbnail picker — separate from the visualizer background so
          users can keep an animated/video bg in the rendered video while
          still putting a still image on the YouTube tile. YouTube needs
          1280×720 (max 2MB) JPEG/PNG; the upload size guard mirrors that. */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <ImageIcon className="size-4" />
            YouTube Thumbnail
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="rounded-md border border-primary/30 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
            <strong className="text-foreground">Tip:</strong> for text overlays,
            fonts, and cinematic effects, design your thumbnail in the
            previous <strong>Thumbnail</strong> step (click <em>Back</em>). This
            picker is for setting a flat image directly — useful when you want
            to reuse a saved thumbnail or upload one prepared elsewhere.
          </div>
          <p className="text-xs text-muted-foreground">
            The image YouTube shows in search and on your channel. If left
            empty, YouTube auto-picks one frame from the video.
          </p>

          {thumbnailAsset && (
            <div className="relative w-full max-w-[320px]">
              <img
                src={thumbnailAsset.file_url}
                alt="Selected thumbnail"
                className="aspect-video w-full rounded-md border border-border/60 object-cover"
              />
              <Button
                variant="ghost"
                size="icon"
                className="absolute right-1 top-1 h-7 w-7 rounded-full bg-black/70 hover:bg-black/90"
                onClick={() => handlePickThumbnail(null)}
                title="Clear thumbnail"
              >
                <X className="h-3.5 w-3.5 text-white" />
              </Button>
            </div>
          )}

          {thumbnailLibrary.length > 0 && (
            <>
              <Label className="text-xs text-muted-foreground">
                Pick from this channel's images
              </Label>
              <div className="grid max-h-44 grid-cols-4 gap-1 overflow-y-auto rounded-md border border-border/40 p-1">
                {thumbnailLibrary.map((a) => {
                  const selected = project.thumbnail_asset_id === a.id;
                  return (
                    <button
                      key={a.id}
                      type="button"
                      onClick={() =>
                        handlePickThumbnail(selected ? null : a.id)
                      }
                      className={cn(
                        "group relative aspect-video overflow-hidden rounded border bg-muted transition",
                        selected
                          ? "ring-2 ring-primary"
                          : "border-border/50 hover:border-border",
                      )}
                      title={a.title || a.filename}
                    >
                      <img
                        src={a.file_url}
                        alt={a.title || a.filename}
                        className="h-full w-full object-cover"
                        loading="lazy"
                        onError={(e) => {
                          const img = e.currentTarget;
                          img.style.display = "none";
                          const parent = img.parentElement;
                          if (parent) parent.style.display = "none";
                        }}
                      />
                      {selected && (
                        <div className="absolute inset-0 bg-primary/15" />
                      )}
                    </button>
                  );
                })}
              </div>
            </>
          )}

          <input
            ref={thumbnailInputRef}
            type="file"
            accept="image/jpeg,image/png"
            className="hidden"
            onChange={async (e) => {
              const file = e.target.files?.[0];
              if (!file) return;
              await handleUploadThumbnail(file);
              if (e.target) e.target.value = "";
            }}
          />
          <Button
            variant="outline"
            size="sm"
            onClick={() => thumbnailInputRef.current?.click()}
            disabled={thumbnailUploading}
          >
            {thumbnailUploading ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Upload className="mr-2 h-4 w-4" />
            )}
            {thumbnailUploading ? "Uploading…" : "Upload new thumbnail"}
          </Button>
        </CardContent>
      </Card>

      <div className="space-y-4">
        <div className="space-y-2">
          <Label>Privacy</Label>
          <Select value={privacy} onValueChange={setPrivacy}>
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="private">Private</SelectItem>
              <SelectItem value="unlisted">Unlisted</SelectItem>
              <SelectItem value="public">Public</SelectItem>
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-2">
          <Label htmlFor="schedule-at">Schedule (optional)</Label>
          <Input
            id="schedule-at"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Leave empty to upload immediately
          </p>
        </div>
      </div>

      {isLongVideo && (
        <div className="flex items-start gap-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10 p-3">
          <AlertTriangle className="mt-0.5 size-5 shrink-0 text-yellow-500" />
          <div className="text-sm">
            <p className="font-medium text-yellow-500">
              Long video ({videoDurationMin} min)
            </p>
            <p className="mt-0.5 text-muted-foreground">
              Unverified YouTube accounts have a 15-minute upload limit.
              Verify your account at{" "}
              <a
                href="https://www.youtube.com/verify"
                target="_blank"
                rel="noreferrer"
                className="underline hover:text-foreground"
              >
                youtube.com/verify
              </a>{" "}
              first to upload videos longer than 15 minutes.
            </p>
          </div>
        </div>
      )}

      {uploadTask &&
        uploadTask.status !== "completed" &&
        uploadTask.status !== "failed" && (
          <Card className="border-blue-500/50 bg-blue-500/5">
            <CardContent className="space-y-2 py-3">
              <div className="flex items-center justify-between text-sm">
                <span className="flex items-center gap-2 font-medium">
                  <Loader2 className="size-4 animate-spin text-blue-400" />
                  {uploadTask.status_message ?? "Uploading to YouTube…"}
                </span>
                <span className="tabular-nums text-muted-foreground">
                  {Math.round(uploadTask.progress ?? 0)}%
                </span>
              </div>
              <Progress value={uploadTask.progress ?? 0} />
              <p className="text-xs text-muted-foreground">
                This can take several minutes for long videos. It's safe to
                close this tab — the upload runs on the server and you'll see
                the result on the project page.
              </p>
            </CardContent>
          </Card>
        )}

      {uploadTask && uploadTask.status === "completed" && (
        <Card className="border-green-500/50 bg-green-500/5">
          <CardContent className="py-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-green-400">
              <Check className="size-4" />
              Upload complete — redirecting…
            </p>
          </CardContent>
        </Card>
      )}

      {uploadTask && uploadTask.status === "failed" && (
        <Card className="border-destructive/50 bg-destructive/5">
          <CardContent className="py-3 text-sm">
            <p className="flex items-center gap-2 font-medium text-destructive">
              <AlertTriangle className="size-4" />
              Upload failed
            </p>
            {uploadTask.error && (
              <p className="mt-1 text-xs text-muted-foreground">
                {uploadTask.error}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Button
        onClick={handleUpload}
        disabled={uploading || !project.composed_asset_id}
        className="w-full"
        size="lg"
      >
        {uploading ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {uploadTask ? "Uploading…" : "Starting upload…"}
          </>
        ) : (
          <>
            <Upload className="size-4" />
            Upload to YouTube
          </>
        )}
      </Button>
    </div>
  );
}
