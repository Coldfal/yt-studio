import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, Bell, RefreshCw, X } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * Top-bar bell + drawer for failed tasks. Replaces the inline
 * FailedTasksPanel that lived at the bottom of the dashboard — at
 * 5–10 channels the dashboard real estate matters more than always-
 * visible failure rows. The bell sticks to the top-right next to
 * RunningTasksDrawer; clicking it slides in a panel listing every
 * failed task in the last 7 days, with one-click Retry.
 *
 * Auto-hides when there's nothing failed (drawer is empty + no
 * notification = no point in occupying screen real estate).
 */
interface FailedTaskRow {
  task_id: number;
  task_type: string;
  channel_id: number | null;
  project_id: number | null;
  error: string | null;
  completed_at: string | null;
  created_at: string | null;
  channel_name: string | null;
}

const TASK_TYPE_LABELS: Record<string, string> = {
  video_composition: "Compose",
  video_extend: "Extend",
  youtube_upload: "Upload",
  metadata_generation: "Metadata",
  music_generation: "Music",
  image_generation: "Image",
  youtube_audio_download: "YT Download",
  youtube_chapters_download: "YT Chapters",
  automation_run: "Automation",
};

export function FailedTasksDrawer() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const { data: failures } = useQuery<FailedTaskRow[]>({
    queryKey: ["stats", "failed-tasks"],
    queryFn: async () => {
      const { data } = await api.get("/stats/failed-tasks", {
        params: { days: 7, limit: 50 },
      });
      return data;
    },
    // 30 s is snappy enough for a "failures bell" without hammering
    // SQLite. The drawer's contents auto-refresh too while open.
    refetchInterval: 30_000,
  });

  const retryMut = useMutation({
    mutationFn: async (taskId: number) => {
      const { data } = await api.post(`/tasks/${taskId}/retry`);
      return data;
    },
    onSuccess: (_data, taskId) => {
      toast.success(`Task ${taskId} re-queued`);
      queryClient.invalidateQueries({ queryKey: ["stats", "failed-tasks"] });
      queryClient.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: (err: unknown) => {
      const detail =
        (err as { response?: { data?: { message?: string } } })?.response?.data
          ?.message ??
        (err as Error)?.message ??
        "Retry failed";
      toast.error(detail);
    },
  });

  const count = failures?.length ?? 0;

  // Don't take any visual real estate when nothing's failed and the
  // drawer isn't already open (e.g. user just retried the last one).
  if (count === 0 && !open) return null;

  return (
    <>
      {/* Bell pinned to the top-right. RunningTasksDrawer pins at
          ``right-4 top-3``; we sit just to the left of it so the two
          coexist. Same pill aesthetic for visual consistency. */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          "fixed right-32 top-3 z-40 flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs shadow-md backdrop-blur transition hover:bg-accent",
          count > 0 && "border-destructive/60 bg-destructive/10 text-destructive",
        )}
        title={count > 0 ? `${count} failed in the last 7 days` : "Failed tasks"}
      >
        {count > 0 ? (
          <AlertTriangle className="size-3.5" />
        ) : (
          <Bell className="size-3.5" />
        )}
        {count > 0 ? (
          <span className="font-medium">
            {count} failed
          </span>
        ) : (
          <span>Alerts</span>
        )}
      </button>

      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/30 backdrop-blur-sm"
          onClick={() => setOpen(false)}
          aria-hidden
        />
      )}

      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-full max-w-md transform border-l border-border bg-background shadow-2xl transition-transform duration-200",
          open ? "translate-x-0" : "translate-x-full",
        )}
      >
        <header className="flex items-center justify-between border-b border-border/60 px-4 py-3">
          <div>
            <h2 className="flex items-center gap-2 text-sm font-semibold">
              <AlertTriangle className="size-4 text-destructive" />
              Failed tasks
            </h2>
            <p className="text-xs text-muted-foreground">
              {count === 0
                ? "Nothing failed in the last 7 days."
                : `${count} in the last 7 days. Click Retry to re-queue.`}
            </p>
          </div>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => setOpen(false)}
            aria-label="Close"
          >
            <X className="size-4" />
          </Button>
        </header>
        <div
          className="space-y-2 overflow-y-auto p-3"
          style={{ maxHeight: "calc(100vh - 64px)" }}
        >
          {count === 0 ? (
            <p className="py-8 text-center text-xs text-muted-foreground">
              No failures yet. The watchdog auto-fails stuck tasks if
              they go silent for too long, so you'll see anything
              that gets stuck here within a minute.
            </p>
          ) : (
            (failures ?? []).map((row) => (
              <FailedRow
                key={row.task_id}
                row={row}
                onRetry={() => retryMut.mutate(row.task_id)}
                onView={
                  row.project_id
                    ? () => {
                        setOpen(false);
                        navigate(`/projects/${row.project_id}`);
                      }
                    : undefined
                }
                retryDisabled={retryMut.isPending}
              />
            ))
          )}
        </div>
      </aside>
    </>
  );
}

function FailedRow({
  row,
  onRetry,
  onView,
  retryDisabled,
}: {
  row: FailedTaskRow;
  onRetry: () => void;
  onView?: () => void;
  retryDisabled: boolean;
}) {
  return (
    <div className="space-y-1.5 rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2">
      <div className="flex items-center gap-2 text-xs">
        <Badge variant="outline" className="text-[10px]">
          {TASK_TYPE_LABELS[row.task_type] ?? row.task_type}
        </Badge>
        {row.channel_name && (
          <span className="font-medium text-foreground">{row.channel_name}</span>
        )}
        {row.completed_at && (
          <span className="ml-auto text-muted-foreground">
            {formatDistanceToNow(new Date(row.completed_at), {
              addSuffix: true,
            })}
          </span>
        )}
      </div>
      {row.error && (
        <p className="line-clamp-3 text-xs text-muted-foreground">{row.error}</p>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={retryDisabled}
          onClick={onRetry}
          className="h-7 text-[11px]"
        >
          <RefreshCw className="size-3" />
          Retry
        </Button>
        {onView && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onView}
            className="h-7 text-[11px]"
          >
            View
          </Button>
        )}
      </div>
    </div>
  );
}
