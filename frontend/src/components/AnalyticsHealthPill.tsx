import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  BarChart3,
  CheckCircle2,
  Loader2,
  RefreshCw,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

/**
 * Top-bar pill that surfaces analytics-refresh health across all
 * connected channels. Lives next to the Running/Failed task pills,
 * pinned to the top-right of the layout.
 *
 * Colour states (signal hierarchy from "all good" → "needs attention"):
 *   - GREEN:  every connected channel refreshed within 26 h.
 *   - YELLOW: at least one channel stale (>26 h or never).
 *   - RED:    most-recent attempt for any channel was a failure.
 *
 * Hidden when no channels are connected to YouTube — there's nothing
 * to monitor and the pill would just be noise.
 *
 * Click expands a small panel listing each channel's last refresh,
 * with a "Refresh now" button that POSTs to
 * ``/api/stats/analytics-runs/refresh``.
 */
interface ChannelStatus {
  channel_id: number;
  channel_name: string;
  last_run_status: "completed" | "failed" | "running" | null;
  last_completed_at: string | null;
  minutes_since: number | null;
  videos_processed: number;
  analytics_skipped: boolean;
}

interface AnalyticsRunsResponse {
  channels: ChannelStatus[];
  summary: {
    channels_total: number;
    channels_fresh: number;
    channels_stale: number;
    channels_failed: number;
    youngest_completed_at: string | null;
    oldest_completed_at: string | null;
  };
}

export function AnalyticsHealthPill() {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [refreshingId, setRefreshingId] = useState<number | null>(null);

  const { data, refetch, isFetching } = useQuery<AnalyticsRunsResponse>({
    queryKey: ["analytics-runs"],
    queryFn: async () => {
      const { data } = await api.get("/stats/analytics-runs");
      return data;
    },
    // Poll every 60 s so the pill flips green within a minute of a
    // successful scheduled run. Cheap query (one indexed SELECT).
    refetchInterval: 60_000,
  });

  if (!data || data.summary.channels_total === 0) return null;

  const { channels_fresh, channels_stale, channels_failed, channels_total, youngest_completed_at } =
    data.summary;
  const allGreen = channels_fresh === channels_total && channels_failed === 0;
  const anyFailed = channels_failed > 0;

  const Icon = anyFailed
    ? AlertTriangle
    : allGreen
      ? CheckCircle2
      : BarChart3;

  const triggerRefresh = async (channelId: number) => {
    setRefreshingId(channelId);
    try {
      await api.post("/stats/analytics-runs/refresh", null, {
        params: { channel_id: channelId },
      });
    } finally {
      setRefreshingId(null);
      refetch();
    }
  };

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          // Sit just to the LEFT of the FailedTasksDrawer bell
          // (right-32) and the RunningTasksDrawer pill (right-4).
          "fixed right-60 top-3 z-40 flex items-center gap-2 rounded-full border border-border/60 bg-background/95 px-3 py-1.5 text-xs shadow-md backdrop-blur transition hover:bg-accent",
          allGreen && !anyFailed && "border-green-500/50 text-green-500",
          !allGreen && !anyFailed && "border-yellow-500/50 bg-yellow-500/10 text-yellow-500",
          anyFailed && "border-destructive/60 bg-destructive/10 text-destructive",
        )}
        title={
          anyFailed
            ? `${channels_failed} channel(s) failed last refresh`
            : allGreen
              ? `All ${channels_total} channels fresh`
              : `${channels_stale} channel(s) stale`
        }
      >
        <Icon className="size-3.5" />
        <span className="font-medium">
          {anyFailed
            ? `${channels_failed} failed`
            : allGreen
              ? "Analytics fresh"
              : `${channels_stale}/${channels_total} stale`}
        </span>
        {youngest_completed_at && (
          <span className="text-[10px] opacity-70">
            ·{" "}
            {formatDistanceToNow(new Date(youngest_completed_at), {
              addSuffix: false,
            })}
          </span>
        )}
      </button>

      {open && (
        <>
          <div
            className="fixed inset-0 z-40"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="fixed right-4 top-12 z-50 w-80 rounded-lg border border-border/60 bg-background shadow-2xl">
            <div className="flex items-center justify-between border-b border-border/40 px-3 py-2">
              <span className="text-xs font-semibold">Analytics refresh</span>
              <Button
                size="icon-sm"
                variant="ghost"
                onClick={() => navigate("/analytics")}
                title="Open Analytics page"
              >
                <BarChart3 className="size-3.5" />
              </Button>
            </div>
            <ul className="max-h-72 overflow-y-auto divide-y divide-border/30">
              {data.channels.map((ch) => (
                <li
                  key={ch.channel_id}
                  className="flex items-center justify-between gap-2 px-3 py-2"
                >
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium">
                      {ch.channel_name}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {ch.last_completed_at
                        ? `Last: ${formatDistanceToNow(
                            new Date(ch.last_completed_at),
                            { addSuffix: true },
                          )}`
                        : "Never refreshed"}
                      {ch.last_run_status === "failed" && (
                        <span className="ml-1 text-destructive">· failed</span>
                      )}
                      {ch.analytics_skipped && (
                        <span className="ml-1 text-yellow-500">
                          · CTR/retention skipped
                        </span>
                      )}
                    </div>
                  </div>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    onClick={() => triggerRefresh(ch.channel_id)}
                    disabled={refreshingId === ch.channel_id}
                    title="Refresh this channel now"
                  >
                    {refreshingId === ch.channel_id ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <RefreshCw className="size-3" />
                    )}
                  </Button>
                </li>
              ))}
            </ul>
            <div className="border-t border-border/40 px-3 py-2">
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setOpen(false);
                  navigate("/analytics");
                }}
                disabled={isFetching}
              >
                Open Analytics page
              </Button>
            </div>
          </div>
        </>
      )}
    </>
  );
}
