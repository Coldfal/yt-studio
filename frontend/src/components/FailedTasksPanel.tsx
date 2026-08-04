import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import { AlertTriangle, ChevronDown, ChevronUp, RefreshCw } from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

/**
 * Cross-channel "failed tasks in the last 7 days" panel for the dashboard.
 *
 * Shows only the **latest** failure by default — a noisy 15-row dump
 * was making the dashboard hostile. The rest of the failures live
 * behind a "Show N more" expander.
 *
 * Server endpoint: ``GET /api/stats/failed-tasks?days=7&limit=50``.
 * Per-row "Retry" hits ``POST /api/tasks/{id}/retry`` which re-enqueues
 * the task with its original parameters.
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

export function FailedTasksPanel() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  // Only the "older failures" section collapses. The latest one is
  // always visible — the whole point of a dashboard alert is to show
  // the most recent thing without an extra click.
  const [showOlder, setShowOlder] = useState(false);

  const { data: failures, isLoading } = useQuery<FailedTaskRow[]>({
    queryKey: ["stats", "failed-tasks"],
    queryFn: async () => {
      const { data } = await api.get("/stats/failed-tasks", {
        params: { days: 7, limit: 50 },
      });
      return data;
    },
    // Refresh every 30s so the panel doesn't go stale during a long
    // operator session, but isn't aggressive enough to spam the DB.
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

  if (isLoading || !failures || failures.length === 0) {
    return null;
  }

  // Backend already returns rows sorted by completed_at desc.
  const [latest, ...older] = failures;
  const olderByChannel = older.reduce<Record<string, FailedTaskRow[]>>(
    (acc, row) => {
      const key = row.channel_name ?? "Unknown channel";
      (acc[key] ??= []).push(row);
      return acc;
    },
    {},
  );

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between text-base">
          <span className="flex items-center gap-2 text-destructive">
            <AlertTriangle className="size-4" />
            Failed tasks (last 7 days)
            <Badge variant="destructive" className="ml-1">
              {failures.length}
            </Badge>
          </span>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-3 pt-0">
        {/* Latest failure: always visible, with channel name. */}
        <FailedTaskCard
          row={latest}
          onRetry={() => retryMut.mutate(latest.task_id)}
          onView={
            latest.project_id
              ? () => navigate(`/projects/${latest.project_id}`)
              : undefined
          }
          retryDisabled={retryMut.isPending}
          showChannelName
        />

        {/* "Show N more" expander only renders when there's actually more. */}
        {older.length > 0 && (
          <div className="space-y-3">
            <Button
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-center gap-1.5 text-[11px] text-muted-foreground hover:text-foreground"
              onClick={() => setShowOlder((v) => !v)}
            >
              {showOlder ? (
                <>
                  <ChevronUp className="size-3" />
                  Hide {older.length} older
                </>
              ) : (
                <>
                  <ChevronDown className="size-3" />
                  Show {older.length} older{older.length === 1 ? "" : ""}
                </>
              )}
            </Button>

            {showOlder &&
              Object.entries(olderByChannel).map(([channelName, rows]) => (
                <div key={channelName} className="space-y-2">
                  <div className="flex items-center gap-2 text-xs font-medium text-muted-foreground">
                    <span>{channelName}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {rows.length}
                    </Badge>
                  </div>
                  <div className="space-y-2">
                    {rows.map((row) => (
                      <FailedTaskCard
                        key={row.task_id}
                        row={row}
                        onRetry={() => retryMut.mutate(row.task_id)}
                        onView={
                          row.project_id
                            ? () => navigate(`/projects/${row.project_id}`)
                            : undefined
                        }
                        retryDisabled={retryMut.isPending}
                      />
                    ))}
                  </div>
                </div>
              ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * Single-row failed-task card. Same look-and-feel for the always-visible
 * latest row and each row inside the "older" expander, with an optional
 * channel-name pill on the latest one (since older rows are already
 * grouped under a channel header).
 */
function FailedTaskCard({
  row,
  onRetry,
  onView,
  retryDisabled,
  showChannelName,
}: {
  row: FailedTaskRow;
  onRetry: () => void;
  onView?: () => void;
  retryDisabled: boolean;
  showChannelName?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex items-start justify-between gap-3 rounded-md",
        "border border-destructive/20 bg-background/60 px-3 py-2 text-xs",
      )}
    >
      <div className="min-w-0 flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-[10px]">
            {TASK_TYPE_LABELS[row.task_type] ?? row.task_type}
          </Badge>
          {showChannelName && row.channel_name && (
            <span className="font-medium text-foreground">
              {row.channel_name}
            </span>
          )}
          {row.completed_at && (
            <span className="text-muted-foreground">
              {formatDistanceToNow(new Date(row.completed_at), {
                addSuffix: true,
              })}
            </span>
          )}
        </div>
        {row.error && (
          <p className="line-clamp-2 text-muted-foreground">{row.error}</p>
        )}
      </div>
      <div className="flex shrink-0 flex-col gap-1.5">
        <Button
          size="sm"
          variant="outline"
          disabled={retryDisabled}
          onClick={onRetry}
        >
          <RefreshCw className="size-3" />
          Retry
        </Button>
        {onView && (
          <Button size="sm" variant="ghost" onClick={onView}>
            View
          </Button>
        )}
      </div>
    </div>
  );
}
