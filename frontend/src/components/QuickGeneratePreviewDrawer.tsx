/**
 * Phase 1 of farm redesign: full "preview before generate" drawer for
 * Quick Generate. Replaces the old fire-and-forget behaviour where the
 * operator clicked Generate-now and only saw the picked image — they
 * had no idea what title/description/tags Claude would produce until
 * the run finished.
 *
 * Flow:
 *   - Parent opens the dialog and provides a {package, loading, error}.
 *   - Drawer renders the full would-be result: title, description, tags,
 *     picked background image, sticky thumbnail (if any), track count +
 *     sample names, target duration, upload-target language list.
 *   - "Re-roll" → parent re-invokes useQuickGenPreviewFull.
 *   - "Approve & generate" → parent posts the approved package to
 *     /quick-generate so compose uses these exact picks (no re-pick
 *     between preview and fire).
 *   - "Cancel" → parent closes the dialog.
 *
 * Heavily defensive on the package shape because the backend returns
 * a free-form dict and the schemas live in DashboardPage.tsx.
 */
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Loader2, RotateCw, Sparkles, AlertCircle, Music, Tag, Image as ImageIcon, ThumbsUp, ThumbsDown } from "lucide-react";
import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import api from "@/lib/api";
import type { QuickGenPreviewFull } from "@/pages/DashboardPage";
import {
  renderThumbnailTemplate,
  type ThumbnailTemplate,
} from "@/components/thumbnail/renderTemplate";

interface QuickGeneratePreviewDrawerProps {
  /** Whether the drawer is visible. */
  open: boolean;
  /** Close handler — called on backdrop click + Cancel button + Esc. */
  onOpenChange: (open: boolean) => void;
  /** The previewed package, or null while loading / on error. */
  pkg: QuickGenPreviewFull | null;
  /** True while either initial fetch or re-roll is in flight. */
  loading: boolean;
  /** Error message from the most recent preview call, if any. */
  error: string | null;
  /** Channel display name for the header. */
  channelName: string;
  /** Fires another preview call — different image / tracks / metadata. */
  onReroll: () => void;
  /** Commits the previewed package to a real compose+upload run.
   *  Phase 7: accepts an optional thumbnail override the parent will
   *  splice into ``approved_package.thumbnail`` before POSTing
   *  /quick-generate. */
  onApprove: (
    thumbnailOverride?: { asset_id: number; file_url: string } | null,
  ) => void;
  /** True while POST /quick-generate (the approve commit) is in flight. */
  approving: boolean;
  /** Phase 7: per-channel thumbnail template. When supplied, the
   *  Sticky Thumbnail slot renders this template using the picked bg
   *  + a deterministic seed. On Approve the rendered JPEG is uploaded
   *  and its asset_id flows through onApprove. */
  thumbnailTemplate?: ThumbnailTemplate | null;
}

/** Format seconds → "12 min" / "1h 22m" for compact display. */
function fmtDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "—";
  const m = Math.round(seconds / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rem = m % 60;
  return rem ? `${h}h ${rem}m` : `${h}h`;
}

export function QuickGeneratePreviewDrawer({
  open,
  onOpenChange,
  pkg,
  loading,
  error,
  channelName,
  onReroll,
  onApprove,
  approving,
  thumbnailTemplate,
}: QuickGeneratePreviewDrawerProps) {
  const meta = pkg?.metadata;
  const image = pkg?.image;
  const thumb = pkg?.thumbnail;
  const music = pkg?.music;
  const diag = pkg?.diagnostics ?? {};

  // Phase 7: template-rendered thumbnail preview + upload-on-approve.
  // When the channel preset has a thumbnail_template AND we have a bg
  // image to layer over, render a fresh JPEG in-memory and show it
  // as the Sticky Thumbnail slot. Re-runs each time the picked bg
  // changes (re-roll) or the package's image id changes.
  const [tplBlob, setTplBlob] = useState<Blob | null>(null);
  const [tplBlobUrl, setTplBlobUrl] = useState<string | null>(null);
  const [tplRendering, setTplRendering] = useState(false);

  useEffect(() => {
    if (!thumbnailTemplate || !pkg?.image?.file_url) {
      setTplBlob(null);
      setTplBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }
    let cancelled = false;
    setTplRendering(true);
    renderThumbnailTemplate({
      template: thumbnailTemplate,
      bgUrl: pkg.image.file_url,
      seed: pkg.image.id,
    })
      .then((blob) => {
        if (cancelled) return;
        setTplBlob(blob);
        setTplBlobUrl((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return URL.createObjectURL(blob);
        });
      })
      .catch((err) => {
        if (cancelled) return;
        console.warn("[drawer] template render failed:", err);
        setTplBlob(null);
      })
      .finally(() => {
        if (!cancelled) setTplRendering(false);
      });
    return () => {
      cancelled = true;
    };
  }, [thumbnailTemplate, pkg?.image?.file_url, pkg?.image?.id]);

  // Clean up the last blob URL on unmount.
  useEffect(() => {
    return () => {
      setTplBlobUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, []);

  /** Upload the in-memory rendered blob → channel asset row, then
   *  invoke onApprove with the new {asset_id, file_url} override
   *  the parent splices into approved_package.thumbnail. */
  const handleApproveClicked = async () => {
    if (!pkg) return;
    if (!tplBlob) {
      // No template render — pass through unchanged.
      onApprove(null);
      return;
    }
    try {
      const fd = new FormData();
      fd.append("channel_id", String(pkg.channel_id));
      fd.append("file", tplBlob, `tpl_thumb_${pkg.image.id}.jpg`);
      const { data } = await api.post("/projects/upload-thumbnail", fd, {
        headers: { "Content-Type": "multipart/form-data" },
      });
      onApprove({ asset_id: data.asset_id, file_url: data.file_url });
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(
        typeof detail === "string"
          ? `Thumbnail upload failed: ${detail}`
          : "Thumbnail upload failed",
      );
    }
  };

  // Phase 3: operator gut-signal on the previewed metadata. Feeds the
  // bandit as a cold-start booster — clicking thumbs-up writes a
  // MetadataFeedback row that the next bandit recompute weighs into
  // its per-token score. Keyed on the title so re-rolls reset it.
  const [ratedFor, setRatedFor] = useState<{ title: string; rating: 1 | -1 } | null>(null);
  const rated =
    ratedFor && pkg?.metadata?.title === ratedFor.title ? ratedFor.rating : null;
  const feedbackMut = useMutation({
    mutationFn: async (rating: 1 | -1) => {
      if (!pkg) return;
      await api.post("/analytics/metadata-feedback", {
        channel_id: pkg.channel_id,
        generated_title: pkg.metadata?.title,
        generated_description: pkg.metadata?.description,
        generated_tags: pkg.metadata?.tags ?? [],
        operator_rating: rating,
      });
    },
    onSuccess: (_data, rating) => {
      if (pkg?.metadata?.title) {
        setRatedFor({ title: pkg.metadata.title, rating });
      }
      toast.success(
        rating === 1
          ? "Thumbs up — bandit will favour these tokens"
          : "Thumbs down — bandit will avoid these tokens",
      );
    },
    onError: () => toast.error("Couldn't save feedback"),
  });

  // Description is typically very long (TRACKLIST + chapters + boilerplate).
  // Show a sensible-length preview rather than the full 2000-char wall.
  const descriptionShort = meta?.description
    ? meta.description.length > 600
      ? meta.description.slice(0, 600) + "…"
      : meta.description
    : "";

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[920px] max-h-[92vh] p-0 overflow-hidden gap-0"
        showCloseButton={!approving}
      >
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-4 text-amber-500" />
            Preview before generate · {channelName}
          </DialogTitle>
          <DialogDescription>
            Approve to start the real compose+upload run. Re-roll to pick
            a fresh image, tracks, and metadata.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[68vh]">
          <div className="p-4 space-y-4">
            {loading && !pkg && (
              <div className="flex flex-col items-center justify-center py-16 gap-2">
                <Spinner className="size-6" />
                <p className="text-sm text-muted-foreground">
                  Picking image, tracks &amp; running metadata generator…
                </p>
                <p className="text-[11px] text-muted-foreground/70">
                  This calls Claude — typically 8-15s.
                </p>
              </div>
            )}

            {error && !loading && (
              <div className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm">
                <div className="flex items-center gap-1.5 font-medium text-destructive">
                  <AlertCircle className="size-4" />
                  Couldn&apos;t build a preview
                </div>
                <p className="mt-1 text-muted-foreground">{error}</p>
              </div>
            )}

            {pkg && (
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {/* Left: visuals */}
                <div className="space-y-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                      Background
                    </p>
                    <div
                      className="overflow-hidden rounded-md bg-muted ring-1 ring-border"
                      style={{ aspectRatio: "16/9" }}
                    >
                      {image?.asset_type === "video" ? (
                        <video
                          src={image.file_url}
                          className="h-full w-full object-cover"
                          autoPlay
                          muted
                          loop
                          playsInline
                        />
                      ) : image?.file_url ? (
                        <img
                          src={image.file_url}
                          alt={image.filename}
                          className="h-full w-full object-cover"
                        />
                      ) : (
                        <div className="flex h-full w-full items-center justify-center text-muted-foreground">
                          <ImageIcon className="size-8 opacity-30" />
                        </div>
                      )}
                    </div>
                    <p className="mt-1 text-[10px] text-muted-foreground truncate">
                      {image?.filename}
                      {image?.role && (
                        <Badge variant="outline" className="ml-2 text-[9px] py-0">
                          {image.role}
                        </Badge>
                      )}
                    </p>
                  </div>

                  {tplBlobUrl ? (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1.5">
                        <Sparkles className="size-3 text-primary" />
                        Template Thumbnail (rendered this run)
                      </p>
                      <div
                        className="overflow-hidden rounded-md bg-muted ring-1 ring-primary/40"
                        style={{ aspectRatio: "16/9" }}
                      >
                        <img
                          src={tplBlobUrl}
                          alt="template thumbnail"
                          className="h-full w-full object-cover"
                        />
                      </div>
                      <p className="mt-1 text-[9px] text-muted-foreground">
                        Re-roll picks a new bg → fresh template
                        render. On Approve the JPEG uploads as a new
                        channel asset and ships with this video.
                      </p>
                    </div>
                  ) : tplRendering ? (
                    <div
                      className="flex items-center justify-center overflow-hidden rounded-md bg-muted ring-1 ring-border"
                      style={{ aspectRatio: "16/9" }}
                    >
                      <Loader2 className="size-5 animate-spin text-muted-foreground" />
                    </div>
                  ) : thumb?.file_url ? (
                    <div>
                      <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">
                        Sticky Thumbnail
                      </p>
                      <div
                        className="overflow-hidden rounded-md bg-muted ring-1 ring-border"
                        style={{ aspectRatio: "16/9" }}
                      >
                        <img
                          src={thumb.file_url}
                          alt="thumbnail"
                          className="h-full w-full object-cover"
                        />
                      </div>
                    </div>
                  ) : (
                    <div className="text-[11px] text-muted-foreground italic">
                      No sticky thumbnail set for this channel.
                    </div>
                  )}

                  <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1.5">
                    <div className="flex items-center gap-1.5 font-medium">
                      <Music className="size-3.5" />
                      Tracks
                    </div>
                    <div className="text-muted-foreground">
                      {music?.count ?? 0} track{music?.count === 1 ? "" : "s"} ·{" "}
                      {fmtDuration(music?.total_duration_seconds ?? 0)}
                    </div>
                    {music?.sample_names?.length ? (
                      <ul className="mt-1.5 space-y-0.5 text-[11px] text-muted-foreground/80">
                        {music.sample_names.map((name, idx) => (
                          <li key={idx} className="truncate">
                            · {name || "(untitled)"}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </div>

                  <div className="rounded-md border bg-muted/30 p-3 text-[11px] space-y-1">
                    <div className="font-medium text-muted-foreground">Run config</div>
                    <div className="flex justify-between">
                      <span>Target duration</span>
                      <span className="tabular-nums">
                        {fmtDuration(pkg.target_duration_seconds)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span>Auto-upload</span>
                      <span>{pkg.auto_upload ? "yes" : "no"}</span>
                    </div>
                    <div className="flex justify-between">
                      <span>Translations</span>
                      <span className="text-right">
                        {pkg.auto_translate_languages.length === 0
                          ? "none"
                          : pkg.auto_translate_languages.join(", ")}
                      </span>
                    </div>
                    {Object.entries(diag).length > 0 && (
                      <>
                        <Separator className="my-1.5" />
                        <div className="font-medium text-muted-foreground">
                          Diagnostics
                        </div>
                        {Object.entries(diag).map(([k, v]) => (
                          <div key={k} className="flex justify-between gap-2">
                            <span className="text-muted-foreground/80 truncate">
                              {k}
                            </span>
                            <span className="text-right text-foreground/80 truncate">
                              {String(v)}
                            </span>
                          </div>
                        ))}
                      </>
                    )}
                  </div>
                </div>

                {/* Right: metadata */}
                <div className="space-y-3">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Title
                    </p>
                    <p className="text-sm font-medium leading-snug break-words">
                      {meta?.title || "(no title)"}
                    </p>
                  </div>

                  <Separator />

                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">
                      Description{" "}
                      <span className="font-normal text-muted-foreground/70">
                        ({meta?.description.length ?? 0} chars)
                      </span>
                    </p>
                    <pre className="whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 text-[11px] leading-relaxed text-foreground/90 max-h-72 overflow-auto font-sans">
                      {descriptionShort}
                    </pre>
                  </div>

                  <Separator />

                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground mb-1.5 flex items-center gap-1">
                      <Tag className="size-3" />
                      Tags ({meta?.tags.length ?? 0})
                    </p>
                    <div className="flex flex-wrap gap-1">
                      {(meta?.tags ?? []).slice(0, 30).map((t, idx) => (
                        <Badge
                          key={idx}
                          variant="secondary"
                          className="text-[10px] py-0"
                        >
                          {t}
                        </Badge>
                      ))}
                      {(meta?.tags?.length ?? 0) > 30 && (
                        <Badge variant="outline" className="text-[10px] py-0">
                          +{(meta?.tags?.length ?? 0) - 30} more
                        </Badge>
                      )}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <div className="flex flex-wrap items-center gap-2 border-t bg-muted/40 p-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={approving}
          >
            Cancel
          </Button>

          {/* Phase 3: operator thumbs feedback. Once a preview is
              loaded, the operator can rate the package; the bandit's
              next recompute will weigh the tokens in this package. */}
          {pkg && (
            <div className="ml-2 flex items-center gap-1 border-l border-border/50 pl-2">
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                Rate
              </span>
              <Button
                size="xs"
                variant={rated === 1 ? "default" : "outline"}
                onClick={() => feedbackMut.mutate(1)}
                disabled={feedbackMut.isPending || rated !== null}
                title="Bandit will favour these tokens"
              >
                <ThumbsUp className="size-3" />
              </Button>
              <Button
                size="xs"
                variant={rated === -1 ? "default" : "outline"}
                onClick={() => feedbackMut.mutate(-1)}
                disabled={feedbackMut.isPending || rated !== null}
                title="Bandit will avoid these tokens"
              >
                <ThumbsDown className="size-3" />
              </Button>
            </div>
          )}

          <div className="flex-1" />
          <Button
            variant="outline"
            onClick={onReroll}
            disabled={loading || approving}
          >
            {loading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Re-rolling…
              </>
            ) : (
              <>
                <RotateCw className="size-4" />
                Re-roll
              </>
            )}
          </Button>
          <Button
            onClick={handleApproveClicked}
            disabled={!pkg || loading || approving || !!error || tplRendering}
          >
            {approving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Starting…
              </>
            ) : (
              <>
                <Sparkles className="size-4" />
                Approve &amp; generate
              </>
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
