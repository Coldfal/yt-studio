/**
 * Failed-task triage — Phase 4 of farm redesign.
 *
 * Lists failed/cancelled background tasks from the last 7 days that
 * haven't been acknowledged. Per-row Retry (re-enqueues with the
 * original parameters) and Dismiss (sets acknowledged_at so the row
 * stops appearing here but stays in the audit log).
 *
 * Designed to be a "morning triage" surface for multi-channel
 * operators — see what broke overnight, fix or dismiss, move on.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { formatDistanceToNow } from "date-fns";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import api from "@/lib/api";
import { useChannels } from "@/hooks/use-channels";
import type { BackgroundTask } from "@/types/index";

const _TASK_TYPE_LABEL: Record<string, string> = {
  automation_run: "Generate",
  compose: "Compose",
  upload: "Upload",
  download: "Download",
  music_gen: "Music gen",
  image_gen: "Image gen",
  analytics_refresh: "Analytics refresh",
  youtube_download: "YouTube download",
  youtube_chapters_download: "YT chapters",
};

export function FailedTaskTriage() {
  const qc = useQueryClient();
  const { data: channels } = useChannels();

  // Fetch un-acknowledged failures from the last 7 days. Cancelled
  // tasks land here too so the operator can revive them if they were
  // cancelled by mistake.
  const failedQ = useQuery<BackgroundTask[]>({
    queryKey: ["fleet-failed-tasks"],
    queryFn: async () => {
      const { data } = await api.get("/tasks", {
        params: {
          status: "failed",
          acknowledged: false,
          since_days: 7,
          limit: 100,
        },
      });
      return data;
    },
    refetchInterval: 30_000,
  });

  const retryMut = useMutation({
    mutationFn: async (taskId: number) => {
      const { data } = await api.post(`/tasks/${taskId}/retry`);
      return data;
    },
    onSuccess: () => {
      toast.success("Re-queued");
      qc.invalidateQueries({ queryKey: ["fleet-failed-tasks"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
    },
    onError: () => toast.error("Retry failed"),
  });

  const dismissMut = useMutation({
    mutationFn: async (taskId: number) => {
      const { data } = await api.post(`/tasks/${taskId}/acknowledge`);
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["fleet-failed-tasks"] });
    },
    onError: () => toast.error("Dismiss failed"),
  });

  const clearAllMut = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(
        "/tasks/acknowledge-all",
        null,
        { params: { status: "failed" } },
      );
      return data as { acknowledged: number };
    },
    onSuccess: (data) => {
      toast.success(`Cleared ${data.acknowledged} failed task${data.acknowledged === 1 ? "" : "s"}`);
      qc.invalidateQueries({ queryKey: ["fleet-failed-tasks"] });
      qc.invalidateQueries({ queryKey: ["tasks"] });
      qc.invalidateQueries({ queryKey: ["stats", "failed-tasks"] });
    },
    onError: () => toast.error("Clear all failed"),
  });

  const tasks = failedQ.data ?? [];
  const channelName = (id: number | null | undefined) =>
    channels?.find((c) => c.id === id)?.name ?? (id != null ? `Channel ${id}` : "—");

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-amber-500" />
            Failed task triage
          </span>
          <div className="flex items-center gap-2">
            <Badge variant={tasks.length > 0 ? "destructive" : "secondary"}>
              {tasks.length}
            </Badge>
            {tasks.length > 0 && (
              <Button
                size="xs"
                variant="outline"
                onClick={() => {
                  if (
                    window.confirm(
                      `Clear all ${tasks.length} failed task${tasks.length === 1 ? "" : "s"}? Rows stay in the audit log but stop appearing here.`,
                    )
                  ) {
                    clearAllMut.mutate();
                  }
                }}
                disabled={clearAllMut.isPending}
                title="Bulk-dismiss every un-acknowledged failure"
              >
                {clearAllMut.isPending ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <Trash2 className="size-3" />
                )}
                Clear all
              </Button>
            )}
          </div>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Un-dismissed failures from the last 7 days. Retry to re-
          enqueue, Dismiss to mark as handled (the row stays in the
          audit log).
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {failedQ.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {tasks.length === 0 && !failedQ.isLoading && (
          <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
            <CheckCircle2 className="mx-auto mb-1 size-5 text-green-500" />
            All clear. No un-dismissed failures.
          </div>
        )}

        {tasks.map((t) => (
          <div
            key={t.id}
            className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs"
          >
            <div className="flex items-start justify-between gap-2">
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-1.5 font-medium">
                  <Badge variant="outline" className="text-[10px] py-0">
                    {_TASK_TYPE_LABEL[t.task_type] ?? t.task_type}
                  </Badge>
                  <span className="truncate">{channelName(t.channel_id)}</span>
                  <span className="text-[10px] text-muted-foreground">
                    ·{" "}
                    {formatDistanceToNow(new Date(t.created_at), {
                      addSuffix: true,
                    })}
                  </span>
                </div>
                {t.error && (
                  <p className="mt-1 line-clamp-3 text-[11px] text-destructive/90 font-mono">
                    {t.error}
                  </p>
                )}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => retryMut.mutate(t.id)}
                  disabled={retryMut.isPending}
                  title="Re-enqueue with original parameters"
                >
                  <RotateCcw className="size-3" />
                  Retry
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => dismissMut.mutate(t.id)}
                  disabled={dismissMut.isPending}
                  title="Mark as handled — hides from triage"
                >
                  <X className="size-3" />
                  Dismiss
                </Button>
              </div>
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}
