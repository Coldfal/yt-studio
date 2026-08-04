import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDownAZ,
  ArrowUpDown,
  ExternalLink,
  Eye,
  Loader2,
  MessageCircle,
  MousePointerClick,
  PlayCircle,
  RefreshCw,
  ShieldAlert,
  ThumbsUp,
  TrendingUp,
} from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { toast } from "sonner";

import api from "@/lib/api";
import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { CtrCell } from "@/components/CtrCell";

/**
 * Channel Performance / Analytics tab.
 *
 * Phase A (this file): pulls public statistics via the YouTube Data
 * API v3 — views, likes, comments, published date, thumbnail, title.
 * No CTR or retention; those require the YouTube Analytics API which
 * needs a separate ``yt-analytics.readonly`` OAuth scope (Phase B).
 *
 * Surfaces:
 *  - Sortable table of every uploaded video.
 *  - Top 5 + bottom 5 by views-per-day so a fresh video that's
 *    pulling 200 views/day doesn't get buried under a 6-month-old
 *    upload that's accumulated 5k total.
 *  - "Title patterns that work" insight: tokenises titles of the top
 *    quartile and shows the most over-represented words/phrases vs
 *    the channel average. Crude but useful — surfaces things like
 *    "Sunny" or "Tokyo" appearing 4× more in winners than losers.
 */
interface ChannelVideo {
  video_id: string;
  title: string;
  thumbnail_url: string | null;
  published_at: string;
  view_count: number;
  like_count: number;
  comment_count: number;
  duration_seconds: number | null;
  views_per_day: number;
  url: string;
  studio_url?: string | null;
  // Phase B Analytics — merged client-side from /channel-analytics.
  // Optional because the data only arrives after the user has
  // re-authorized with the yt-analytics scope, and even then a
  // fresh-uploaded video has no Analytics rows yet.
  ctr?: number;                 // 0..1 (manual-entered; YT API doesn't expose CTR)
  avg_view_duration?: number;   // seconds
  avg_view_percentage?: number; // 0..1
  impressions?: number;
  // Local-asset metadata, joined from VideoProject by youtube_video_id.
  // ``thumbnail_asset_url`` is the actual asset shown on YouTube
  // (uploaded by the wizard); ``thumbnail_url`` is YouTube's own
  // hosted thumbnail derived from that asset.
  thumbnail_asset_id?: number | null;
  thumbnail_asset_url?: string | null;
  first_track_asset_id?: number | null;
  project_id?: number | null;
}

interface AnalyticsRow {
  video_id: string;
  views: number;
  impressions: number;
  ctr: number;
  avg_view_duration: number;
  avg_view_percentage: number;
}

type SortKey =
  | "published_at"
  | "view_count"
  | "like_count"
  | "comment_count"
  | "views_per_day"
  | "ctr"
  | "avg_view_duration"
  | "avg_view_percentage";

function fmtNum(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function fmtDuration(secs: number | null): string {
  if (!secs && secs !== 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = secs % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Tokenise a title into lowercase keywords. Strips fullwidth /
// decorative characters (『』⋆｡°✩｜・☯ etc) so they don't pollute the
// frequency analysis. Words shorter than 3 chars are dropped because
// "for", "the", "a" dominate every list.
function tokeniseTitle(title: string): string[] {
  return (title || "")
    .toLowerCase()
    // keep ASCII letters/digits + Japanese/Korean blocks
    .replace(/[^a-z0-9぀-ヿ㐀-䶿一-鿿가-힯\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 3);
}

const STOP_WORDS = new Set([
  "and", "the", "for", "with", "your", "from", "this", "that", "you",
  "are", "was", "but", "all", "any", "out", "into", "over", "play",
  "playlist", "mix", "music", "song", "songs",
]);

export function PerformanceTab({ channelId }: { channelId: number }) {
  const [sortKey, setSortKey] = useState<SortKey>("views_per_day");
  const [sortDesc, setSortDesc] = useState(true);
  const queryClient = useQueryClient();

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery<{
    videos: ChannelVideo[];
    total: number;
  }>({
    queryKey: ["channel-videos", channelId],
    queryFn: async () => {
      const { data } = await api.get("/youtube/channel-videos", {
        params: { channel_id: channelId, limit: 200 },
      });
      return data;
    },
    // YouTube stats don't move minute to minute; ten-minute cache
    // keeps the tab snappy without burning quota on every nav.
    staleTime: 10 * 60_000,
  });

  // Phase B Analytics. Separate query so a missing scope (returning
  // ``needs_reauth=true``) doesn't block the public-stats table.
  const analyticsQ = useQuery<{
    items: AnalyticsRow[];
    needs_reauth: boolean;
    window_days: number;
  }>({
    queryKey: ["channel-analytics", channelId],
    queryFn: async () => {
      const { data } = await api.get("/youtube/channel-analytics", {
        params: { channel_id: channelId, days: 90 },
      });
      return data;
    },
    staleTime: 10 * 60_000,
  });

  // Manual CTR overrides — typed by the operator on the inline cell.
  // Light query: one indexed SELECT per channel, refetched after
  // every save so the number you typed appears instantly without a
  // round-trip flicker.
  const manualQ = useQuery<{
    items: { youtube_video_id: string; ctr: number | null; notes: string | null }[];
  }>({
    queryKey: ["channel-manual-metrics", channelId],
    queryFn: async () => {
      const { data } = await api.get("/youtube/manual-metrics", {
        params: { channel_id: channelId },
      });
      return data;
    },
    staleTime: 60_000,
  });

  // Merge the analytics rows onto the videos by video_id. O(n+m).
  const analyticsByVid = useMemo(() => {
    const map = new Map<string, AnalyticsRow>();
    for (const row of analyticsQ.data?.items ?? []) {
      map.set(row.video_id, row);
    }
    return map;
  }, [analyticsQ.data?.items]);

  // Manual CTR overlay. Operator-entered values WIN over whatever
  // came back from the API (in practice the API column is null for
  // CTR, so the manual value is the only source).
  const manualByVid = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of manualQ.data?.items ?? []) {
      if (r.ctr != null) map.set(r.youtube_video_id, r.ctr);
    }
    return map;
  }, [manualQ.data?.items]);

  const videos: ChannelVideo[] = useMemo(() => {
    return (data?.videos ?? []).map((v) => {
      const a = analyticsByVid.get(v.video_id);
      const manualCtr = manualByVid.get(v.video_id);
      const merged: ChannelVideo = a
        ? {
            ...v,
            ctr: a.ctr,
            avg_view_duration: a.avg_view_duration,
            avg_view_percentage: a.avg_view_percentage,
            impressions: a.impressions,
          }
        : { ...v };
      if (manualCtr != null) {
        merged.ctr = manualCtr;
      }
      return merged;
    });
  }, [data?.videos, analyticsByVid, manualByVid]);

  const needsAnalyticsReauth = Boolean(analyticsQ.data?.needs_reauth);

  // Trigger a fresh OAuth flow that includes the yt-analytics scope.
  // The auth-url endpoint already passes ``prompt=select_account
  // consent`` which forces Google to re-prompt — Google then re-issues
  // a token whose scope list includes the new yt-analytics one.
  const reauth = async () => {
    try {
      const { data } = await api.get("/youtube/auth-url", {
        params: { channel_id: channelId },
      });
      if (data?.url) {
        window.location.href = data.url;
      } else {
        toast.error("Couldn't get re-authorization URL.");
      }
    } catch {
      toast.error("Couldn't start re-authorization flow.");
    }
  };

  const sorted = useMemo(() => {
    const arr = [...videos];
    arr.sort((a, b) => {
      const va = (a[sortKey] ?? 0) as number | string;
      const vb = (b[sortKey] ?? 0) as number | string;
      if (typeof va === "string" && typeof vb === "string") {
        return sortDesc ? vb.localeCompare(va) : va.localeCompare(vb);
      }
      return sortDesc
        ? Number(vb) - Number(va)
        : Number(va) - Number(vb);
    });
    return arr;
  }, [videos, sortKey, sortDesc]);

  const top5 = useMemo(
    () => [...videos].sort((a, b) => b.views_per_day - a.views_per_day).slice(0, 5),
    [videos],
  );
  const bottom5 = useMemo(
    () => [...videos]
      .filter((v) => v.views_per_day > 0)
      .sort((a, b) => a.views_per_day - b.views_per_day)
      .slice(0, 5),
    [videos],
  );

  // Title-pattern analysis: which tokens appear in winners way more
  // often than in the channel average? We compare top-quartile vs
  // bottom-quartile by views_per_day. With <10 videos this is noise,
  // so we only render the insight panel above N videos.
  const titleInsights = useMemo(() => {
    if (videos.length < 8) return [];
    const sorted = [...videos].sort((a, b) => b.views_per_day - a.views_per_day);
    const q = Math.max(2, Math.floor(sorted.length / 4));
    const winners = sorted.slice(0, q);
    const losers = sorted.slice(-q);
    const count = (set: ChannelVideo[]) => {
      const c = new Map<string, number>();
      for (const v of set) {
        const seen = new Set<string>();
        for (const t of tokeniseTitle(v.title)) {
          if (STOP_WORDS.has(t)) continue;
          if (seen.has(t)) continue;
          seen.add(t);
          c.set(t, (c.get(t) ?? 0) + 1);
        }
      }
      return c;
    };
    const wc = count(winners);
    const lc = count(losers);
    type Row = { token: string; ratio: number; winRate: number; loseRate: number };
    const rows: Row[] = [];
    for (const [tok, w] of wc.entries()) {
      const winRate = w / winners.length;
      const loseRate = (lc.get(tok) ?? 0) / losers.length;
      // Smooth so a 100% winner with 0% loser doesn't divide by zero.
      const ratio = (winRate + 0.05) / (loseRate + 0.05);
      if (winRate < 0.25) continue; // appear in at least 25% of winners
      if (ratio < 1.6) continue; // need a real lift
      rows.push({ token: tok, ratio, winRate, loseRate });
    }
    rows.sort((a, b) => b.ratio - a.ratio);
    return rows.slice(0, 10);
  }, [videos]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> Loading channel videos…
      </div>
    );
  }
  if (isError) {
    const detail =
      (error as { response?: { data?: { detail?: string } } })?.response?.data
        ?.detail ?? (error as Error)?.message;
    return (
      <Card>
        <CardContent className="py-8 text-sm text-destructive">
          {detail || "Failed to load videos."}
        </CardContent>
      </Card>
    );
  }

  const SortHeader = ({ label, k }: { label: string; k: SortKey }) => (
    <button
      type="button"
      onClick={() => {
        if (sortKey === k) setSortDesc((v) => !v);
        else {
          setSortKey(k);
          setSortDesc(true);
        }
      }}
      className={cn(
        "flex items-center gap-1 text-[11px] uppercase tracking-wide",
        sortKey === k ? "text-primary" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {label}
      <ArrowUpDown className="size-3" />
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {videos.length} video{videos.length === 1 ? "" : "s"} from your YouTube channel.
          Public stats only. Stats refresh every 10 min.
        </p>
        <Button
          size="sm"
          variant="outline"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          {isFetching ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <RefreshCw className="size-3.5" />
          )}
          Refresh
        </Button>
      </div>

      {/* Re-auth banner — only renders when the stored OAuth token
          predates the yt-analytics scope. Once they re-authorize the
          banner disappears and the CTR + retention columns light up. */}
      {needsAnalyticsReauth && (
        <Card className="border-yellow-500/40 bg-yellow-500/10">
          <CardContent className="flex items-center justify-between gap-3 px-4 py-3 text-xs">
            <div className="flex items-start gap-2">
              <ShieldAlert className="mt-0.5 size-4 shrink-0 text-yellow-600 dark:text-yellow-400" />
              <div>
                <div className="font-medium text-yellow-700 dark:text-yellow-300">
                  Re-authorize for CTR &amp; retention
                </div>
                <div className="text-muted-foreground">
                  This channel was connected before the analytics scope
                  was added. Re-link it once and the CTR /
                  avg-view-duration / retention columns light up. Public
                  stats keep working in the meantime.
                </div>
              </div>
            </div>
            <Button size="sm" variant="outline" onClick={reauth}>
              Re-authorize
            </Button>
          </CardContent>
        </Card>
      )}
      {!needsAnalyticsReauth && analyticsQ.data && (
        <p className="text-[11px] text-muted-foreground">
          Analytics window: last {analyticsQ.data.window_days} days ·
          retention pulled from the YouTube Analytics API · CTR is
          operator-entered (Google blocks per-video CTR via the
          public API). Click any "—" CTR cell to type a value.
        </p>
      )}

      {videos.length >= 4 && (
        <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <TrendingUp className="size-4 text-green-500" />
                Top 5 by views/day
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {top5.map((v) => (
                <a
                  key={v.video_id}
                  href={v.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/40"
                >
                  <span className="w-12 shrink-0 text-right font-mono text-green-500">
                    {fmtNum(v.views_per_day)}/d
                  </span>
                  <span className="truncate">{v.title}</span>
                </a>
              ))}
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="flex items-center gap-2 text-sm">
                <ArrowDownAZ className="size-4 text-muted-foreground" />
                Bottom 5 by views/day
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-1.5">
              {bottom5.map((v) => (
                <a
                  key={v.video_id}
                  href={v.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 rounded px-1.5 py-1 text-xs hover:bg-accent/40"
                >
                  <span className="w-12 shrink-0 text-right font-mono text-muted-foreground">
                    {fmtNum(v.views_per_day)}/d
                  </span>
                  <span className="truncate">{v.title}</span>
                </a>
              ))}
            </CardContent>
          </Card>
        </div>
      )}

      {titleInsights.length > 0 && (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              Title patterns that correlate with performance
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Words that appear way more often in your top-quartile videos
              than in your bottom quartile. Use these as signal, not law.
            </p>
          </CardHeader>
          <CardContent>
            <div className="flex flex-wrap gap-1.5">
              {titleInsights.map((row) => (
                <Badge
                  key={row.token}
                  variant="outline"
                  className="font-mono text-[11px]"
                  title={`${Math.round(row.winRate * 100)}% of top videos vs ${Math.round(row.loseRate * 100)}% of bottom`}
                >
                  {row.token}{" "}
                  <span className="ml-1 text-green-500">
                    {row.ratio >= 10 ? "10×+" : `${row.ratio.toFixed(1)}×`}
                  </span>
                </Badge>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {/* Sortable video list */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm">All videos</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-border/40 [&>th]:px-3 [&>th]:py-2 [&>th]:text-left">
                  <th className="w-16">Thumb</th>
                  <th>Title</th>
                  <th><SortHeader label="Published" k="published_at" /></th>
                  <th><SortHeader label="Views" k="view_count" /></th>
                  <th><SortHeader label="Views/day" k="views_per_day" /></th>
                  <th><SortHeader label="CTR" k="ctr" /></th>
                  <th><SortHeader label="Avg view" k="avg_view_duration" /></th>
                  <th><SortHeader label="Retention" k="avg_view_percentage" /></th>
                  <th><SortHeader label="Likes" k="like_count" /></th>
                  <th><SortHeader label="Comments" k="comment_count" /></th>
                  <th>Length</th>
                  <th></th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((v) => (
                  <tr
                    key={v.video_id}
                    className="border-b border-border/30 [&>td]:px-3 [&>td]:py-2 hover:bg-accent/30"
                  >
                    <td>
                      {/* Prefer the LOCAL asset thumbnail when we
                          have it (set by the upload flow via
                          VideoProject.thumbnail_asset_id) — useful
                          later for thumbnail-bandit work. Falls back
                          to YouTube's hosted thumbnail. */}
                      {(v.thumbnail_asset_url || v.thumbnail_url) ? (
                        <img
                          src={v.thumbnail_asset_url || v.thumbnail_url || ""}
                          className="aspect-video w-14 rounded object-cover"
                          title={
                            v.thumbnail_asset_id
                              ? `Local asset id ${v.thumbnail_asset_id}`
                              : "YouTube-hosted thumbnail"
                          }
                        />
                      ) : (
                        <div className="aspect-video w-14 rounded bg-muted" />
                      )}
                    </td>
                    <td className="max-w-md truncate">{v.title}</td>
                    <td className="text-muted-foreground">
                      {v.published_at
                        ? formatDistanceToNow(new Date(v.published_at), {
                            addSuffix: true,
                          })
                        : "—"}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        <Eye className="size-3 text-muted-foreground" />
                        {fmtNum(v.view_count)}
                      </span>
                    </td>
                    <td className="font-mono">
                      {fmtNum(v.views_per_day)}
                    </td>
                    <td className="font-mono">
                      <CtrCell
                        videoId={v.video_id}
                        channelId={channelId}
                        ctr={v.ctr ?? null}
                      />
                    </td>
                    <td className="font-mono">
                      {v.avg_view_duration != null ? (
                        <span className="inline-flex items-center gap-1 text-muted-foreground">
                          <PlayCircle className="size-3" />
                          {fmtDuration(v.avg_view_duration)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td className="font-mono">
                      {v.avg_view_percentage != null ? (
                        <span
                          className={cn(
                            v.avg_view_percentage >= 0.4
                              ? "text-green-500"
                              : v.avg_view_percentage >= 0.25
                                ? "text-yellow-500"
                                : "text-muted-foreground",
                          )}
                        >
                          {Math.round(v.avg_view_percentage * 100)}%
                        </span>
                      ) : (
                        <span className="text-muted-foreground/40">—</span>
                      )}
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        <ThumbsUp className="size-3 text-muted-foreground" />
                        {fmtNum(v.like_count)}
                      </span>
                    </td>
                    <td>
                      <span className="inline-flex items-center gap-1">
                        <MessageCircle className="size-3 text-muted-foreground" />
                        {fmtNum(v.comment_count)}
                      </span>
                    </td>
                    <td className="text-muted-foreground">
                      {fmtDuration(v.duration_seconds)}
                    </td>
                    <td>
                      {/* External-link → YouTube Studio for the
                          real CTR/retention curves. Shift-click for
                          the public watch page. */}
                      <a
                        href={v.studio_url || v.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-primary hover:underline"
                        title="Open in YouTube Studio"
                        onClick={(e) => {
                          if (e.shiftKey) {
                            e.preventDefault();
                            window.open(v.url, "_blank");
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
    </div>
  );
}
