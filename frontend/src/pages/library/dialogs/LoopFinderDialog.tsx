import { useState } from "react";
import { Loader2, Repeat, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import api from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import type { Asset } from "@/types/index";

interface LoopCandidate {
  loop_start_seconds: number;
  loop_end_seconds: number;
  loop_start_samples: number;
  loop_end_samples: number;
  score: number;
  duration_seconds: number;
}

function fmt(t: number): string {
  const m = Math.floor(t / 60);
  const s = (t - m * 60).toFixed(2);
  return `${m}:${s.padStart(5, "0")}`;
}

/**
 * Analyse a music asset for seamless loop points (PyMusicLooper) and,
 * once the user picks one, export an extended copy to a target length
 * with a small crossfade. The export becomes a new ``music`` asset on
 * the same channel + folder, so it shows up in the library next to the
 * original. The original is left untouched.
 */
export function LoopFinderDialog({
  asset,
  open,
  onOpenChange,
}: {
  asset: Asset | null;
  open: boolean;
  onOpenChange: (next: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const [analyzing, setAnalyzing] = useState(false);
  const [candidates, setCandidates] = useState<LoopCandidate[]>([]);
  const [selectedIdx, setSelectedIdx] = useState<number | null>(null);
  const [exporting, setExporting] = useState(false);
  // Default to 1 hour — the most common ask for ambient/lofi looping.
  const [targetMinutes, setTargetMinutes] = useState(60);

  const analyze = async () => {
    if (!asset) return;
    setCandidates([]);
    setSelectedIdx(null);
    setAnalyzing(true);
    try {
      const { data } = await api.post(`/loops/${asset.id}/analyze`, {});
      setCandidates(data as LoopCandidate[]);
      if ((data as LoopCandidate[]).length > 0) setSelectedIdx(0);
      else toast.warning("No loop candidates found in this track");
    } catch (err) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Analysis failed";
      toast.error(typeof msg === "string" ? msg : "Analysis failed");
    } finally {
      setAnalyzing(false);
    }
  };

  const doExport = async () => {
    if (!asset || selectedIdx == null) return;
    const c = candidates[selectedIdx];
    setExporting(true);
    try {
      const { data } = await api.post(`/loops/${asset.id}/export`, {
        loop_start_samples: c.loop_start_samples,
        loop_end_samples: c.loop_end_samples,
        target_duration_seconds: Math.max(60, targetMinutes * 60),
        fade_seconds: 0.05,
      });
      toast.success(`Exported "${data.title}" — ${(data.file_size / 1_000_000).toFixed(1)} MB`);
      // Refresh the library list so the new asset shows up immediately.
      queryClient.invalidateQueries({ queryKey: ["assets"] });
      onOpenChange(false);
    } catch (err) {
      const msg =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Export failed";
      toast.error(typeof msg === "string" ? msg : "Export failed");
    } finally {
      setExporting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Repeat className="size-4 text-primary" />
            Seamless loop — {asset?.title || asset?.filename}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">
            PyMusicLooper finds musically-coherent positions inside the
            track where the audio can repeat without an audible seam.
            Pick a candidate and a target length, and we'll export a
            new looped audio asset on the same channel.
          </p>

          {!analyzing && candidates.length === 0 && (
            <Button
              onClick={analyze}
              disabled={!asset}
              className="w-full"
              variant="outline"
            >
              <Sparkles className="mr-2 size-3.5" />
              Analyze track
            </Button>
          )}

          {analyzing && (
            <div className="flex items-center justify-center gap-2 rounded-md border border-border/50 bg-muted/20 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Analysing… (typical 5–20 s)
            </div>
          )}

          {candidates.length > 0 && (
            <div className="space-y-2">
              <Label className="text-xs">Loop candidates (best first)</Label>
              <div className="max-h-64 space-y-1 overflow-y-auto pr-1">
                {candidates.map((c, idx) => {
                  const selected = selectedIdx === idx;
                  const scorePct = Math.round(c.score * 100);
                  return (
                    <button
                      key={idx}
                      type="button"
                      onClick={() => setSelectedIdx(idx)}
                      className={cn(
                        "flex w-full items-center justify-between gap-2 rounded border px-2 py-1.5 text-left text-xs transition",
                        selected
                          ? "border-primary bg-primary/10"
                          : "border-border/50 hover:border-primary/60",
                      )}
                    >
                      <div className="flex flex-col">
                        <span className="font-medium">
                          {fmt(c.loop_start_seconds)} → {fmt(c.loop_end_seconds)}
                        </span>
                        <span className="text-[10px] text-muted-foreground">
                          loop body {fmt(c.duration_seconds)}
                        </span>
                      </div>
                      <span
                        className={cn(
                          "rounded px-1.5 py-0.5 text-[10px] font-mono",
                          scorePct >= 90
                            ? "bg-green-500/20 text-green-400"
                            : scorePct >= 75
                              ? "bg-yellow-500/20 text-yellow-400"
                              : "bg-muted text-muted-foreground",
                        )}
                      >
                        {scorePct}%
                      </span>
                    </button>
                  );
                })}
              </div>

              <div className="grid grid-cols-[1fr_auto] items-center gap-2 pt-2">
                <div className="space-y-1">
                  <Label className="text-xs">Target length (minutes)</Label>
                  <Input
                    type="number"
                    min={1}
                    max={600}
                    value={targetMinutes}
                    onChange={(e) => setTargetMinutes(Number(e.target.value))}
                    className="h-8 text-sm"
                  />
                </div>
                <Button
                  size="sm"
                  onClick={doExport}
                  disabled={selectedIdx == null || exporting}
                >
                  {exporting ? (
                    <Loader2 className="mr-2 size-3.5 animate-spin" />
                  ) : (
                    <Repeat className="mr-2 size-3.5" />
                  )}
                  {exporting ? "Exporting…" : "Export looped"}
                </Button>
              </div>
              <p className="text-[10px] text-muted-foreground">
                Output is WAV (lossless source for downstream encoding).
                A 50 ms crossfade is applied at every loop seam.
              </p>
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
