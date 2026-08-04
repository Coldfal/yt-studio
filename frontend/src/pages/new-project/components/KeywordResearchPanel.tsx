import { useCallback, useEffect, useState } from "react";
import { ChevronRight, Loader2, RefreshCw, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import api from "@/lib/api";
import { cn } from "@/lib/utils";

// ── Live keyword-research preview ────────────────────────────────────────
// Shows the user the autocomplete queries + trending tags Claude is being
// fed, with a Refresh button to re-pull. Cached server-side per channel/day.
interface ResearchPayload {
  niche: string;
  autocomplete: string[];
  trending_titles: string[];
  trending_tags: string[];
  sources: string[];
  fetched_at: number;
  youtube_api_available: boolean;
}

export function KeywordResearchPanel({ channelId }: { channelId: number }) {
  const [data, setData] = useState<ResearchPayload | null>(null);
  const [loading, setLoading] = useState(false);
  const [open, setOpen] = useState(true);

  const load = useCallback(
    async (refresh = false) => {
      setLoading(true);
      try {
        const { data: r } = await api.get<ResearchPayload>(
          `/metadata/research/${channelId}${refresh ? "?refresh=true" : ""}`,
        );
        setData(r);
      } catch {
        // non-fatal
      } finally {
        setLoading(false);
      }
    },
    [channelId],
  );

  useEffect(() => {
    load(false);
  }, [load]);

  const fetchedAgo = data?.fetched_at
    ? Math.floor((Date.now() / 1000 - data.fetched_at) / 60)
    : null;

  return (
    <div className="rounded-lg border border-border/60 bg-card/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between px-4 py-2.5 text-left"
      >
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-medium">Live keyword research</span>
          {data && (
            <span className="text-[11px] text-muted-foreground">
              · {data.autocomplete.length} suggestions
              {data.trending_tags.length > 0
                ? ` · ${data.trending_tags.length} trending tags`
                : ""}
              {fetchedAgo !== null
                ? fetchedAgo < 1
                  ? " · just now"
                  : ` · ${fetchedAgo}m ago`
                : ""}
            </span>
          )}
        </div>
        <ChevronRight
          className={cn(
            "size-4 text-muted-foreground transition-transform",
            open && "rotate-90",
          )}
        />
      </button>

      {open && (
        <div className="space-y-4 border-t border-border/60 px-4 py-3">
          {!data?.youtube_api_available && (
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-200/80">
              YouTube Data API key not configured — only autocomplete data
              is available. Add a key in Settings → YouTube to also pull
              trending tags from top-performing videos in your category.
            </div>
          )}

          {loading && !data && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> Researching…
            </div>
          )}

          {data && (
            <>
              {data.autocomplete.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    What people are searching for right now
                  </Label>
                  <div className="flex flex-wrap gap-1">
                    {data.autocomplete.slice(0, 24).map((q) => (
                      <span
                        key={q}
                        className="rounded-full border border-border/60 bg-muted/50 px-2 py-0.5 text-[11px] text-foreground/80"
                      >
                        {q}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {data.trending_tags.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Most-used tags in trending videos (this category)
                  </Label>
                  <div className="flex flex-wrap gap-1">
                    {data.trending_tags.slice(0, 18).map((t) => (
                      <span
                        key={t}
                        className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[11px] text-primary"
                      >
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              )}

              {data.trending_titles.length > 0 && (
                <div className="space-y-1.5">
                  <Label className="text-xs">
                    Top-performing titles (study patterns; don't copy)
                  </Label>
                  <ul className="space-y-0.5 text-[11px] text-muted-foreground">
                    {data.trending_titles.slice(0, 8).map((t, i) => (
                      <li key={i} className="truncate">
                        · {t}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}

          <div className="flex justify-end">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => load(true)}
              disabled={loading}
            >
              {loading ? (
                <Loader2 className="mr-1.5 size-3 animate-spin" />
              ) : (
                <RefreshCw className="mr-1.5 size-3" />
              )}
              Refresh
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
