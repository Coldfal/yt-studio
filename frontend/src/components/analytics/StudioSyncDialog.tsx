/**
 * Studio Sync dialog — Phase 6 of farm redesign.
 *
 * The public YouTube Analytics API doesn't expose per-video CTR or
 * impressions for regular channels. They only live in YouTube Studio.
 * This dialog accepts scraped Studio rows in either CSV or JSON form
 * and POSTs them to the backend, which UPSERTs them into today's
 * VideoAnalyticsSnapshot rows and triggers a bandit recompute.
 *
 * The operator has two paths:
 *   (a) Manual: open Studio, copy the table, paste here as CSV.
 *   (b) Assisted: ask Claude in this session to use the Claude in
 *       Chrome MCP to scrape Studio + paste the resulting JSON here.
 * Either way, the operator reviews the parsed rows before submitting.
 */
import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  AlertCircle,
  Cloud,
  Loader2,
  Wand2,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import api from "@/lib/api";

interface ParsedRow {
  video_id: string;
  impressions?: number | null;
  ctr_pct?: number | null;
  avg_view_percentage?: number | null;
  raw?: string;
}

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channelId: number;
  channelName: string;
}

/**
 * Parse CSV/TSV/JSON pasted into the textarea into a list of rows.
 * Accepted formats:
 *   - JSON array of objects with {video_id, impressions, ctr_pct, ...}
 *   - CSV/TSV with a header row including at least video_id and ctr_pct.
 *     Common Studio CSV columns: "Video", "Impressions",
 *     "Impressions click-through rate (%)".
 */
function parseInput(text: string): ParsedRow[] {
  const trimmed = text.trim();
  if (!trimmed) return [];

  // Try JSON first.
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed);
      const arr = Array.isArray(parsed) ? parsed : [parsed];
      return arr
        .map((r) => normalizeRow(r))
        .filter((r): r is ParsedRow => r != null);
    } catch {
      // fall through to CSV
    }
  }

  // CSV / TSV. Detect separator from header line.
  const lines = trimmed.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length < 2) return [];
  const header = lines[0];
  const sep = header.includes("\t") ? "\t" : ",";
  const cols = header.split(sep).map((c) => c.trim().toLowerCase());

  const findCol = (...keys: string[]) => {
    for (const k of keys) {
      const i = cols.findIndex((c) => c.includes(k));
      if (i !== -1) return i;
    }
    return -1;
  };

  const vidIdx = findCol("video id", "videoid", "video_id");
  const titleIdx = findCol("video", "title");
  const imprIdx = findCol("impressions");
  const ctrIdx = findCol("ctr", "click-through");
  const retIdx = findCol("retention", "average percentage", "view percentage");

  const out: ParsedRow[] = [];
  for (const line of lines.slice(1)) {
    const cells = line.split(sep);
    let vid =
      vidIdx >= 0 ? cells[vidIdx]?.trim() : titleIdx >= 0 ? cells[titleIdx]?.trim() : "";
    if (!vid) continue;
    // If Studio's "Video" column contains a video URL or "title (id)",
    // extract the 11-char YouTube id; else use the trimmed cell.
    const idMatch = vid.match(/[a-zA-Z0-9_-]{11}/);
    if (idMatch && vid.length > 11) {
      vid = idMatch[0];
    }
    const num = (i: number): number | null => {
      if (i < 0 || i >= cells.length) return null;
      const v = cells[i]?.replace(/[%,\s]/g, "");
      const n = Number(v);
      return Number.isFinite(n) ? n : null;
    };
    out.push({
      video_id: vid,
      impressions: num(imprIdx),
      ctr_pct: num(ctrIdx),
      avg_view_percentage: num(retIdx),
      raw: line,
    });
  }
  return out;
}

function normalizeRow(r: Record<string, unknown>): ParsedRow | null {
  const vid =
    (r.video_id as string) ?? (r.videoId as string) ?? (r.id as string) ?? "";
  if (!vid) return null;
  const num = (k: string): number | null => {
    const v = r[k];
    if (v == null) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  return {
    video_id: String(vid),
    impressions: num("impressions"),
    ctr_pct: num("ctr_pct") ?? (num("ctr") != null ? (num("ctr") as number) * 100 : null),
    avg_view_percentage: num("avg_view_percentage") ?? num("retention"),
  };
}

export function StudioSyncDialog({
  open,
  onOpenChange,
  channelId,
  channelName,
}: Props) {
  const qc = useQueryClient();
  const [text, setText] = useState("");
  const parsed = useMemo(() => parseInput(text), [text]);
  const validRows = parsed.filter(
    (r) => r.impressions != null || r.ctr_pct != null,
  );

  const submit = useMutation({
    mutationFn: async () => {
      const { data } = await api.post(
        `/analytics/studio-sync/${channelId}`,
        {
          rows: validRows.map((r) => ({
            video_id: r.video_id,
            impressions: r.impressions ?? null,
            ctr_pct: r.ctr_pct ?? null,
            avg_view_percentage:
              r.avg_view_percentage != null
                ? r.avg_view_percentage > 1
                  ? r.avg_view_percentage / 100
                  : r.avg_view_percentage
                : null,
          })),
        },
      );
      return data as { updated: number; created: number; skipped: number };
    },
    onSuccess: (s) => {
      toast.success(
        `Studio sync: ${s.updated} updated, ${s.created} created, ${s.skipped} skipped`,
      );
      qc.invalidateQueries({ queryKey: ["analytics-recent"] });
      qc.invalidateQueries({ queryKey: ["analytics-overview"] });
      qc.invalidateQueries({ queryKey: ["bandit-decisions"] });
      onOpenChange(false);
      setText("");
    },
    onError: () => toast.error("Studio sync failed"),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[920px] max-h-[90vh] gap-0 p-0 overflow-hidden">
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2">
            <Cloud className="size-4 text-primary" />
            Sync from YouTube Studio · {channelName}
          </DialogTitle>
          <DialogDescription>
            YouTube&apos;s public API doesn&apos;t expose per-video CTR
            or impressions. Paste scraped Studio data here and the
            backend will fold it into today&apos;s snapshots + recompute
            the bandit.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[72vh]">
          <div className="space-y-4 p-4">
            <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-[11px]">
              <p className="flex items-center gap-1.5 font-medium text-amber-200/90">
                <AlertCircle className="size-3.5" />
                How to get the data
              </p>
              <ol className="mt-1 ml-4 list-decimal space-y-1 text-muted-foreground">
                <li>
                  Open YouTube Studio →{" "}
                  <strong>Analytics → Content</strong>. Set the date
                  range to <strong>Last 28 days</strong>.
                </li>
                <li>
                  Click <strong>Export</strong> →{" "}
                  <strong>Comma-separated values</strong>. Open the CSV.
                </li>
                <li>
                  Copy the rows (with header) and paste below. Or ask
                  this Claude session to scrape via the Chrome MCP and
                  paste the resulting JSON.
                </li>
              </ol>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="studio-paste" className="text-xs">
                Paste CSV or JSON
              </Label>
              <Textarea
                id="studio-paste"
                rows={10}
                placeholder={
                  '"Video","Impressions","Impressions click-through rate (%)"\n' +
                  '"my-title (abc123def45)",1820,7.3\n' +
                  "...\n\n" +
                  "OR JSON array:\n" +
                  '[{"video_id":"abc123","impressions":1820,"ctr_pct":7.3}]'
                }
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="font-mono text-[10px]"
              />
              <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                <span>
                  {parsed.length} parsed
                </span>
                <Badge variant="outline" className="text-[9px] py-0">
                  {validRows.length} with usable signal
                </Badge>
                {parsed.length > validRows.length && (
                  <Badge variant="outline" className="text-[9px] py-0">
                    {parsed.length - validRows.length} missing CTR/imps
                  </Badge>
                )}
              </div>
            </div>

            {validRows.length > 0 && (
              <div className="rounded-md border border-border bg-muted/10 p-2 text-[10px]">
                <p className="mb-1 font-medium">Preview (first 8)</p>
                <div className="overflow-x-auto">
                  <table className="w-full text-left">
                    <thead className="text-muted-foreground">
                      <tr>
                        <th className="pr-3">video_id</th>
                        <th className="pr-3">imps</th>
                        <th className="pr-3">CTR %</th>
                        <th className="pr-3">retention %</th>
                      </tr>
                    </thead>
                    <tbody>
                      {validRows.slice(0, 8).map((r) => (
                        <tr key={r.video_id}>
                          <td className="pr-3 font-mono">{r.video_id}</td>
                          <td className="pr-3 tabular-nums">
                            {r.impressions ?? "—"}
                          </td>
                          <td className="pr-3 tabular-nums">
                            {r.ctr_pct != null ? r.ctr_pct.toFixed(1) : "—"}
                          </td>
                          <td className="pr-3 tabular-nums">
                            {r.avg_view_percentage != null
                              ? Number(r.avg_view_percentage).toFixed(1)
                              : "—"}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="border-t bg-muted/40 p-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={submit.isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={() => submit.mutate()}
            disabled={submit.isPending || validRows.length === 0}
          >
            {submit.isPending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Syncing…
              </>
            ) : (
              <>
                <Wand2 className="size-4" />
                Sync {validRows.length} row{validRows.length === 1 ? "" : "s"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
