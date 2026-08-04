import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "react-router-dom";
import {
  ArrowDownRight,
  ArrowUpRight,
  BarChart3,
  ExternalLink,
  Loader2,
  Minus,
  Music,
  MousePointerClick,
  PlayCircle,
  TrendingUp,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { CtrCell } from "@/components/CtrCell";
import { BanditDecisionsCard } from "@/components/analytics/BanditDecisionsCard";

/**
 * Top-level cross-channel Analytics page.
 *
 * Reads from the persisted ``video_analytics_snapshots`` table — NOT
 * from YouTube live — so this loads instantly even with 1000+ videos
 * across 10 channels. The scheduler refreshes snapshots once a day;
 * the dashboard freshness pill (AnalyticsHealthPill) tells the user
 * when the data was last updated.
 *
 * Three sections:
 *   1. Per-channel summary cards (top strip)
 *   2. Recent-videos table — last 14 days, cross-channel, sortable
 *   3. (Phase 3) Title-token bandit panel — added later
 */

interface ChannelOverviewRow {
  channel_id: number;
  channel_name: string;
  videos_in_window: number;
  median_views_per_day: number;
  previous_median_views_per_day: number;
  delta_views_per_day: number;
  median_ctr: number;
  median_retention: number;
  top_video: {
    video_id: string;
    title: string;
    views_per_day: number;
  } | null;
}

interface RecentVideoRow {
  channel_id: number;
  channel_name: string;
  youtube_video_id: string;
  title: string;
  snapshot_date: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  views_per_day: number;
  ctr: number | null;
  avg_view_duration: number | null;
  avg_view_percentage: number | null;
  url: string;
  studio_url: string;
}

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(Math.round(n));
}

function fmtDuration(secs: number | null): string {
  if (secs == null) return "—";
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function pct(v: number | null, digits = 1): string {
  if (v == null) return "—";
  return `${(v * 100).toFixed(digits)}%`;
}

interface TopTrackRow {
  track_asset_id: number | null;
  track_title: string | null;
  track_filename: string | null;
  videos_used_in: number;
  total_views: number;
  mean_views_per_day: number;
  mean_retention: number | null;
  score: number;
}

export default function AnalyticsPage() {
  const navigate = useNavigate();
  // Per-channel tracks card state. The Top Tracks card lives at the
  // bottom of the page — one channel selected at a time so the
  // layout stays narrow on small screens. Defaults to whichever
  // channel has the most data once we fetch the overview.
  const [tracksChannelId, setTracksChannelId] = useState<number | null>(null);
  const overviewQ = useQuery<{ channels: ChannelOverviewRow[]; window_days: number }>({
    queryKey: ["analytics-overview"],
    queryFn: async () => {
      const { data } = await api.get("/analytics/overview");
      return data;
    },
    staleTime: 5 * 60_000,
  });
  const recentQ = useQuery<{ items: RecentVideoRow[]; window_days: number }>({
    queryKey: ["analytics-recent", 14],
    queryFn: async () => {
      const { data } = await api.get("/analytics/recent-videos", {
        params: { days: 14, limit: 50 },
      });
      return data;
    },
    staleTime: 5 * 60_000,
  });

  const isLoading = overviewQ.isLoading || recentQ.isLoading;
  const channels = overviewQ.data?.channels ?? [];
  const recent = recentQ.data?.items ?? [];

  // Default the tracks card to the channel with the most videos in
  // the window once the overview lands.
  useMemo(() => {
    if (tracksChannelId == null && channels.length > 0) {
      const best = [...channels].sort(
        (a, b) => b.videos_in_window - a.videos_in_window,
      )[0];
      if (best) setTracksChannelId(best.channel_id);
    }
  }, [channels, tracksChannelId]);

  const tracksQ = useQuery<{ items: TopTrackRow[] }>({
    queryKey: ["analytics-top-tracks", tracksChannelId],
    queryFn: async () => {
      const { data } = await api.get("/analytics/top-tracks", {
        params: { channel_id: tracksChannelId, limit: 25 },
      });
      return data;
    },
    enabled: tracksChannelId != null,
    staleTime: 5 * 60_000,
  });

  const channelHasNoData = channels.length > 0 && channels.every((c) => c.videos_in_window === 0);

  const sortedRecent = useMemo(
    () => [...recent].sort((a, b) => b.views_per_day - a.views_per_day),
    [recent],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <BarChart3 className="size-6 text-primary" />
          Analytics
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Cross-channel performance pulled from daily snapshots. Open
          the freshness pill in the top bar to refresh on demand.
        </p>
      </div>

      {isLoading && (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading…
        </div>
      )}

      {!isLoading && channels.length === 0 && (
        <Card>
          <CardContent className="py-8 text-center text-sm text-muted-foreground">
            No YouTube-connected channels yet. Connect at least one
            channel to start tracking analytics.
          </CardContent>
        </Card>
      )}

      {!isLoading && channelHasNoData && (
        <Card className="border-yellow-500/40 bg-yellow-500/5">
          <CardContent className="py-3 text-xs text-muted-foreground">
            <strong className="text-yellow-600 dark:text-yellow-400">
              No snapshots yet.
            </strong>{" "}
            The daily refresh worker hasn't run yet (or hasn't found
            videos in the 28-day window). Click the freshness pill in
            the top bar → Refresh now to kick one off.
          </CardContent>
        </Card>
      )}

      {channels.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {channels.map((c) => {
            const trendUp = c.delta_views_per_day > 0.05;
            const trendDown = c.delta_views_per_day < -0.05;
            const TrendIcon = trendUp
              ? ArrowUpRight
              : trendDown
                ? ArrowDownRight
                : Minus;
            return (
              <Card
                key={c.channel_id}
                className="cursor-pointer transition hover:border-primary/40"
                onClick={() =>
                  navigate(`/channels/${c.channel_id}?tab=performance`)
                }
              >
                <CardHeader className="pb-2">
                  <CardTitle className="flex items-center justify-between text-sm">
                    <span>{c.channel_name}</span>
                    <span
                      className={cn(
                        "inline-flex items-center gap-1 text-xs",
                        trendUp && "text-green-500",
                        trendDown && "text-destructive",
                        !trendUp && !trendDown && "text-muted-foreground",
                      )}
                    >
                      <TrendIcon className="size-3.5" />
                      {(c.delta_views_per_day * 100).toFixed(0)}%
                    </span>
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <div className="grid grid-cols-3 gap-2 text-center text-xs">
                    <div>
                      <div className="text-[10px] text-muted-foreground">
                        Median v/d
                      </div>
                      <div className="font-mono text-sm">
                        {fmtNum(c.median_views_per_day)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">CTR</div>
                      <div className="font-mono text-sm">
                        {pct(c.median_ctr)}
                      </div>
                    </div>
                    <div>
                      <div className="text-[10px] text-muted-foreground">
                        Retention
                      </div>
                      <div className="font-mono text-sm">
                        {pct(c.median_retention, 0)}
                      </div>
                    </div>
                  </div>
                  {c.top_video && (
                    <div className="rounded border border-border/40 bg-muted/20 p-2 text-xs">
                      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        <TrendingUp className="size-3 text-green-500" /> Top
                        performer (last 28 d)
                      </div>
                      <div className="mt-0.5 truncate">{c.top_video.title}</div>
                      <div className="mt-0.5 font-mono text-[11px] text-green-500">
                        {fmtNum(c.top_video.views_per_day)} views/day
                      </div>
                    </div>
                  )}
                  <div className="text-[10px] text-muted-foreground">
                    {c.videos_in_window} video
                    {c.videos_in_window === 1 ? "" : "s"} in window
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      {sortedRecent.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Last {recentQ.data?.window_days ?? 14} days · sorted by
              views/day
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Latest snapshot per video. Open a channel to drill into
              its full Performance tab.
            </p>
          </CardHeader>
          <CardContent className="px-0">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-border/40 [&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:text-[11px] [&>th]:uppercase [&>th]:tracking-wide [&>th]:text-muted-foreground">
                    <th>Channel</th>
                    <th>Title</th>
                    <th>Views/day</th>
                    <th>CTR</th>
                    <th>Retention</th>
                    <th>Avg view</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRecent.map((r) => (
                    <tr
                      key={r.youtube_video_id}
                      className="border-b border-border/30 [&>td]:px-3 [&>td]:py-2 hover:bg-accent/30"
                    >
                      <td>
                        <Badge
                          variant="outline"
                          className="cursor-pointer text-[10px]"
                          onClick={() =>
                            navigate(`/channels/${r.channel_id}?tab=performance`)
                          }
                        >
                          {r.channel_name}
                        </Badge>
                      </td>
                      <td className="max-w-md truncate">{r.title}</td>
                      <td className="font-mono">
                        {fmtNum(r.views_per_day)}
                      </td>
                      <td className="font-mono">
                        {/* Editable. Click → number input → Enter
                            saves. Same component used on the
                            per-channel Performance tab; saves
                            invalidate this query so the new value
                            appears here without a manual reload. */}
                        <CtrCell
                          videoId={r.youtube_video_id}
                          channelId={r.channel_id}
                          ctr={r.ctr}
                        />
                      </td>
                      <td className="font-mono">
                        {pct(r.avg_view_percentage, 0)}
                      </td>
                      <td className="font-mono text-muted-foreground">
                        {r.avg_view_duration != null ? (
                          <span className="inline-flex items-center gap-1">
                            <PlayCircle className="size-3" />
                            {fmtDuration(r.avg_view_duration)}
                          </span>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td>
                        {/* External-link goes to YouTube Studio so
                            the operator can pull the real CTR /
                            retention curves Google doesn't expose
                            via the API. Hold-shift to open the
                            public watch page instead. */}
                        <a
                          href={r.studio_url || r.url}
                          target="_blank"
                          rel="noreferrer"
                          className="text-primary hover:underline"
                          title="Open in YouTube Studio"
                          onClick={(e) => {
                            if (e.shiftKey) {
                              e.preventDefault();
                              window.open(r.url, "_blank");
                            }
                          }}
                        >
                          <ExternalLink className="size-3.5" />
                        </a>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Top performing tracks per channel. First-track attribution:
          when a video gets good retention we credit the FIRST music
          track in its mix, since that's what most viewers actually
          hear. Backed by the nightly track_performance_stats
          recompute. Switch channel via the chips at the top. */}
      {channels.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm">
              <Music className="size-4 text-primary" />
              Top performing tracks
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              First-track attribution. Stats credit the first track
              of each video — that's what every viewer hears even on
              short watches. Higher retention = stronger track.
            </p>
            <div className="mt-2 flex flex-wrap gap-1">
              {channels.map((c) => (
                <button
                  key={c.channel_id}
                  type="button"
                  onClick={() => setTracksChannelId(c.channel_id)}
                  className={cn(
                    "rounded border px-2 py-1 text-[11px] transition",
                    tracksChannelId === c.channel_id
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border/50 hover:border-primary",
                  )}
                >
                  {c.channel_name}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="px-0">
            {tracksQ.isLoading && (
              <div className="flex items-center justify-center gap-2 py-6 text-xs text-muted-foreground">
                <Loader2 className="size-3.5 animate-spin" /> Loading…
              </div>
            )}
            {tracksQ.data && tracksQ.data.items.length === 0 && (
              <div className="px-4 py-6 text-center text-xs text-muted-foreground">
                No track data yet. The next analytics refresh will
                attribute snapshots to first tracks and populate this
                table.
              </div>
            )}
            {tracksQ.data && tracksQ.data.items.length > 0 && (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="border-b border-border/40 [&>th]:px-3 [&>th]:py-2 [&>th]:text-left [&>th]:text-[11px] [&>th]:uppercase [&>th]:tracking-wide [&>th]:text-muted-foreground">
                      <th>Track</th>
                      <th>Used in</th>
                      <th>Total views</th>
                      <th>Mean v/d</th>
                      <th>Mean retention</th>
                      <th>Score</th>
                    </tr>
                  </thead>
                  <tbody>
                    {tracksQ.data.items.map((t) => {
                      const display =
                        t.track_title || t.track_filename || `Asset #${t.track_asset_id ?? "?"}`;
                      return (
                        <tr
                          key={t.track_asset_id ?? `noid-${display}`}
                          className="border-b border-border/30 [&>td]:px-3 [&>td]:py-2 hover:bg-accent/30"
                        >
                          <td className="max-w-md truncate" title={display}>
                            {display}
                          </td>
                          <td className="font-mono">{t.videos_used_in}</td>
                          <td className="font-mono">
                            {fmtNum(t.total_views)}
                          </td>
                          <td className="font-mono">
                            {fmtNum(t.mean_views_per_day)}
                          </td>
                          <td className="font-mono">
                            {t.mean_retention != null ? (
                              <span
                                className={cn(
                                  t.mean_retention >= 0.4
                                    ? "text-green-500"
                                    : t.mean_retention >= 0.25
                                      ? "text-yellow-500"
                                      : "text-muted-foreground",
                                )}
                              >
                                {Math.round(t.mean_retention * 100)}%
                              </span>
                            ) : (
                              <span className="text-muted-foreground/40">
                                —
                              </span>
                            )}
                          </td>
                          <td className="font-mono text-muted-foreground">
                            {t.score.toFixed(2)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Phase 3: Bandit decisions card — surfaces the three pools
          (title / description / tag) so the operator can audit which
          tokens the bandit is recommending for the next render. */}
      {tracksChannelId != null && (
        <BanditDecisionsCard
          channelId={tracksChannelId}
          channelName={
            channels.find((c) => c.channel_id === tracksChannelId)
              ?.channel_name ?? `Channel ${tracksChannelId}`
          }
        />
      )}
    </div>
  );
}
