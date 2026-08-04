/**
 * Bandit decisions panel — Phase 3 of farm redesign.
 *
 * Surfaces "what's the bandit currently telling Claude" so the operator
 * can audit which tokens are winners / cold / exploring for the three
 * kinds (title, description, tag). One channel at a time.
 *
 * Includes a 'Recompute now' button that runs the synchronous bandit
 * recompute — useful after the operator types in a manual CTR or
 * thumbs-up a preview and wants to see the new ranking immediately.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Cloud, Loader2, RefreshCw, Tag, Type, FileText, Sparkles } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import api from "@/lib/api";
import { StudioSyncDialog } from "./StudioSyncDialog";

interface TokenRow {
  token: string;
  samples: number;
  score: number;
}

interface KindBlock {
  total_tokens: number;
  winners: TokenRow[];
  cold: TokenRow[];
  exploring: TokenRow[];
}

interface BanditDecisions {
  title: KindBlock;
  description: KindBlock;
  tag: KindBlock;
}

const KIND_META: Record<keyof BanditDecisions, { label: string; icon: React.ReactNode }> = {
  title: { label: "Title", icon: <Type className="size-3.5" /> },
  description: { label: "Description", icon: <FileText className="size-3.5" /> },
  tag: { label: "Tag", icon: <Tag className="size-3.5" /> },
};

export function BanditDecisionsCard({ channelId, channelName }: {
  channelId: number;
  channelName: string;
}) {
  const qc = useQueryClient();
  const [expandedKind, setExpandedKind] = useState<keyof BanditDecisions>("title");
  const [studioOpen, setStudioOpen] = useState(false);

  const decisionsQ = useQuery<BanditDecisions>({
    queryKey: ["bandit-decisions", channelId],
    queryFn: async () => {
      const { data } = await api.get(`/analytics/bandit-decisions/${channelId}`);
      return data;
    },
    staleTime: 60_000,
  });

  const recompute = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(
        `/analytics/recompute-bandit/${channelId}`,
      );
      return data;
    },
    onSuccess: (data) => {
      toast.success(
        `Bandit recomputed: ${data.tokens_tracked} tokens, ` +
          `${data.winners} winners, ${data.cold} cold`,
      );
      qc.invalidateQueries({ queryKey: ["bandit-decisions", channelId] });
    },
    onError: () => toast.error("Recompute failed"),
  });

  const block = decisionsQ.data?.[expandedKind];

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center justify-between gap-2 text-sm">
          <span className="flex items-center gap-2">
            <Sparkles className="size-4 text-primary" />
            Bandit decisions · {channelName}
          </span>
          <div className="flex items-center gap-1">
            <Button
              size="xs"
              variant="outline"
              onClick={() => setStudioOpen(true)}
              title="Paste YouTube Studio CTR / impressions data — fills the bandit's signal"
            >
              <Cloud className="size-3" />
              Sync Studio
            </Button>
            <Button
              size="xs"
              variant="outline"
              onClick={() => recompute.mutate()}
              disabled={recompute.isPending}
            >
              {recompute.isPending ? (
                <>
                  <Loader2 className="size-3 animate-spin" />
                  Recomputing…
                </>
              ) : (
                <>
                  <RefreshCw className="size-3" />
                  Recompute now
                </>
              )}
            </Button>
          </div>
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          What the bandit is telling Claude on this channel's next render.
          Click a kind to see its top tokens.
        </p>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {/* Kind tabs */}
        <div className="flex gap-1">
          {(Object.keys(KIND_META) as (keyof BanditDecisions)[]).map((k) => {
            const meta = KIND_META[k];
            const data = decisionsQ.data?.[k];
            const active = expandedKind === k;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setExpandedKind(k)}
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 transition ${
                  active
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-border/50 text-muted-foreground hover:border-primary/50"
                }`}
              >
                {meta.icon}
                {meta.label}
                <Badge variant="secondary" className="text-[9px] py-0">
                  {data?.total_tokens ?? "—"}
                </Badge>
              </button>
            );
          })}
        </div>

        {decisionsQ.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          </div>
        )}

        {block && (
          <div className="grid gap-3 sm:grid-cols-3">
            <TokenColumn
              label="Winners"
              accent="text-green-500"
              rows={block.winners}
            />
            <TokenColumn
              label="Exploring"
              accent="text-amber-500"
              rows={block.exploring}
            />
            <TokenColumn
              label="Cold"
              accent="text-destructive"
              rows={block.cold}
            />
          </div>
        )}

        {block && block.total_tokens === 0 && (
          <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-4 text-center text-[11px] text-muted-foreground">
            No tokens yet. The bandit needs at least 8 snapshots before
            it makes recommendations. Run analytics refresh + Recompute
            to populate.
          </p>
        )}

        <Separator />
        <p className="text-[10px] text-muted-foreground">
          The 'must include' set is rotated each render so the same words
          don't dominate every title. Cold tokens are excluded from
          generation. Exploring tokens are sampled for variety.
        </p>
      </CardContent>
      <StudioSyncDialog
        open={studioOpen}
        onOpenChange={setStudioOpen}
        channelId={channelId}
        channelName={channelName}
      />
    </Card>
  );
}

function TokenColumn({
  label,
  accent,
  rows,
}: {
  label: string;
  accent: string;
  rows: TokenRow[];
}) {
  return (
    <div>
      <p className={`mb-1.5 text-[10px] font-semibold uppercase tracking-wider ${accent}`}>
        {label} ({rows.length})
      </p>
      {rows.length === 0 ? (
        <p className="text-[10px] italic text-muted-foreground">none</p>
      ) : (
        <ul className="space-y-0.5">
          {rows.map((r) => (
            <li
              key={r.token}
              className="flex items-center justify-between gap-1.5 rounded border border-border/40 bg-muted/20 px-1.5 py-0.5"
              title={`${r.samples} samples · score ${r.score}`}
            >
              <span className="truncate text-[11px]">{r.token}</span>
              <span className="text-[9px] text-muted-foreground tabular-nums">
                {r.samples}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
