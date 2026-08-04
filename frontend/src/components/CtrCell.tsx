import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { MousePointerClick } from "lucide-react";
import { toast } from "sonner";

import api from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Inline-editable CTR cell, shared across the Performance tab and
 * the cross-channel Analytics page recent-videos table.
 *
 * Why operator-entered: YouTube doesn't expose per-video CTR via the
 * public Analytics API for regular channels (only YouTube Studio
 * does), so the only path for this signal to reach our title-token
 * bandit is operator entry. Click → number input pre-filled with
 * the current value → type the percent (e.g. ``8.3``) → Enter saves
 * / Escape cancels / blank + Enter clears.
 *
 * Persists in ``video_manual_metrics`` keyed on
 * (youtube_video_id) — survives page reloads and gets folded into
 * the bandit's score on the next nightly recompute.
 *
 * After saving, invalidates the channel's manual-metrics query AND
 * the cross-channel ``analytics-recent`` query so both views
 * refresh without a manual reload.
 */
export function CtrCell({
  videoId,
  channelId,
  ctr,
}: {
  videoId: string;
  channelId: number;
  ctr: number | null;
}) {
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(
    ctr != null ? (ctr * 100).toFixed(1) : "",
  );
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const trimmed = draft.trim();
    let payload: number | null = null;
    if (trimmed === "") {
      payload = null;
    } else {
      const n = Number(trimmed);
      if (!isFinite(n) || n < 0 || n > 100) {
        toast.error("Enter a number 0..100 (percent), or blank to clear");
        return;
      }
      payload = n / 100;
    }
    setSaving(true);
    try {
      await api.post("/youtube/manual-metrics", {
        youtube_video_id: videoId,
        channel_id: channelId,
        ctr: payload,
        notes: null,
      });
      // Refresh every view that surfaces CTR — per-channel
      // Performance tab and the cross-channel Analytics page.
      queryClient.invalidateQueries({
        queryKey: ["channel-manual-metrics", channelId],
      });
      queryClient.invalidateQueries({ queryKey: ["analytics-recent"] });
      setEditing(false);
    } catch {
      toast.error("Couldn't save CTR");
    } finally {
      setSaving(false);
    }
  };

  if (editing) {
    return (
      <span
        className="inline-flex items-center gap-1"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          type="number"
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={save}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setDraft(ctr != null ? (ctr * 100).toFixed(1) : "");
              setEditing(false);
            }
          }}
          className="h-6 w-14 rounded border border-primary/40 bg-background px-1 text-xs"
          step="0.1"
          min="0"
          max="100"
          disabled={saving}
        />
        <span className="text-[10px] text-muted-foreground">%</span>
      </span>
    );
  }

  if (ctr == null) {
    return (
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setEditing(true);
        }}
        className="text-muted-foreground/40 hover:text-primary hover:underline"
        title="Click to enter CTR (operator-entered, not API-derived)"
      >
        —
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        setEditing(true);
      }}
      className={cn(
        "inline-flex items-center gap-1 hover:underline",
        ctr >= 0.06
          ? "text-green-500"
          : ctr >= 0.04
            ? "text-yellow-500"
            : "text-muted-foreground",
      )}
      title="Click to edit. CTR is operator-entered (Google blocks per-video CTR via the API)."
    >
      <MousePointerClick className="size-3" />
      {(ctr * 100).toFixed(1)}%
    </button>
  );
}
