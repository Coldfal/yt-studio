/**
 * Channel quota stack — Phase 4 of farm redesign.
 *
 * One row per channel, each row a horizontal bar per provider showing
 * remaining quota (YouTube upload, Claude CLI, OpenAI, Suno…). When a
 * bar dips below 25% the operator gets a visual heads-up before they
 * click Generate and hit a rate-limit wall mid-render.
 *
 * Uses the existing per-channel quota endpoint (one fetch per
 * channel, polled every 30s — cheap, in-memory).
 */
import { useChannels, useChannelQuota } from "@/hooks/use-channels";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Gauge } from "lucide-react";

const PROVIDER_LABEL: Record<string, string> = {
  "youtube:upload": "YT upload",
  "youtube:download": "YT API",
  "claude:cli": "Claude CLI",
  "openai:image": "OpenAI img",
  "suno:music": "Suno",
};

export function ChannelQuotaStack() {
  const { data: channels } = useChannels();
  const rows = channels ?? [];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Gauge className="size-4 text-primary" />
          Quota by channel
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Live rate-limit buckets across every channel + provider. Bars
          dim as tokens drain; full bars mean ready to fire.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {rows.length === 0 && (
          <p className="text-xs text-muted-foreground">No channels yet.</p>
        )}
        {rows.map((c) => (
          <ChannelRow key={c.id} channelId={c.id} channelName={c.name} />
        ))}
      </CardContent>
    </Card>
  );
}

function ChannelRow({ channelId, channelName }: {
  channelId: number;
  channelName: string;
}) {
  const { data: buckets } = useChannelQuota(channelId);
  return (
    <div className="rounded-md border border-border/40 bg-muted/10 p-2.5">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs font-medium">{channelName}</span>
        {buckets && buckets.length === 0 && (
          <Badge variant="outline" className="text-[9px] py-0">
            No usage yet
          </Badge>
        )}
      </div>
      <div className="space-y-1">
        {(buckets ?? []).map((b) => {
          const pct =
            b.capacity > 0
              ? Math.min(100, Math.max(0, (b.tokens_available / b.capacity) * 100))
              : 0;
          const low = pct < 25;
          return (
            <div key={b.provider} className="flex items-center gap-2 text-[10px]">
              <span className="w-20 shrink-0 truncate text-muted-foreground">
                {PROVIDER_LABEL[b.provider] ?? b.provider}
              </span>
              <div className="flex-1 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className={`h-full transition-all ${
                    low
                      ? "bg-destructive"
                      : pct < 60
                        ? "bg-amber-500"
                        : "bg-green-500"
                  }`}
                  style={{ width: `${pct.toFixed(0)}%` }}
                />
              </div>
              <span className="w-12 shrink-0 text-right tabular-nums text-muted-foreground">
                {Math.floor(b.tokens_available)}/{b.capacity}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
