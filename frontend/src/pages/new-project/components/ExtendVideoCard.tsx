import { useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Progress } from "@/components/ui/progress";
import { Slider } from "@/components/ui/slider";
import { useAsset, useAssets } from "@/hooks/use-assets";
import { useTask } from "@/hooks/use-tasks";
import api from "@/lib/api";
import { cn } from "@/lib/utils";
import type { VideoProject } from "@/types/index";
import { fmtHM } from "../utils";

/**
 * "Extend by looping" — splice the already-composed video to itself with
 * FFmpeg concat -c copy and trim to a target duration. Way faster than
 * re-rendering the visualizer for the additional length.
 *
 * The target duration can be set freely via a slider, manually via Hh+Mm
 * inputs, or snapped to a track-end boundary so the video doesn't cut mid-song.
 */
export function ExtendVideoCard({
  project,
  onExtended,
}: {
  project: VideoProject;
  onExtended: () => void;
}) {
  const [extending, setExtending] = useState(false);
  const [taskId, setTaskId] = useState<number | null>(null);
  const handledRef = useRef<number | null>(null);

  const { data: composedAsset } = useAsset(
    project.composed_asset_id ?? undefined,
  );
  const sourceDur = composedAsset?.duration_seconds ?? 0;
  const sourceMin = Math.round(sourceDur / 60);

  // Default target: 1 hour past current length, capped at 12h. Stays
  // within bounds when the user types something out of range.
  const minTarget = Math.max(60, Math.ceil(sourceDur) + 1);
  const maxTarget = 12 * 3600;
  const [targetSec, setTargetSec] = useState(
    Math.min(maxTarget, Math.max(minTarget, 3600)),
  );

  // Resolve track durations for snap-point computation. We use the same
  // music asset ids that the project has — the snap points line up with
  // the actual song boundaries inside the composed video.
  const { data: channelMusic } = useAssets({
    channel_id: String(project.channel_id),
    asset_type: "music",
  });
  const trackIds = (project.music_asset_ids ?? (project.music_asset_id ? [project.music_asset_id] : []));
  const tracks = trackIds
    .map((id) => channelMusic?.find((a) => a.id === id))
    .filter((a): a is NonNullable<typeof a> => Boolean(a))
    .map((a) => a.duration_seconds ?? 0)
    .filter((d) => d > 0);

  // Build the set of natural endpoints across the looped video:
  //   loop k starts at k * sourceDur, has track endpoints at:
  //     k*sourceDur + sum(tracks[0..i]) for i = 1..N
  // Continue until we exceed maxTarget. Each entry > sourceDur is a valid
  // snap candidate (must extend past current source length).
  const snapPoints: number[] = [];
  if (sourceDur > 0 && tracks.length > 0) {
    for (let k = 0; k * sourceDur < maxTarget; k++) {
      let acc = k * sourceDur;
      for (const d of tracks) {
        acc += d;
        if (acc <= sourceDur) continue;     // earlier than current length
        if (acc > maxTarget) break;
        snapPoints.push(Math.round(acc));
      }
    }
  }
  // Fallback: if no track durations available, just mark each whole-loop end.
  const fallbackSnaps: number[] = [];
  if (snapPoints.length === 0 && sourceDur > 0) {
    for (let k = 2; k * sourceDur <= maxTarget; k++) {
      fallbackSnaps.push(Math.round(k * sourceDur));
    }
  }
  const allSnaps = snapPoints.length > 0 ? snapPoints : fallbackSnaps;

  const repeats = sourceDur > 0 ? Math.ceil(targetSec / sourceDur) : 0;

  const snapToNearest = () => {
    if (allSnaps.length === 0) return;
    const nearest = allSnaps.reduce((best, cur) =>
      Math.abs(cur - targetSec) < Math.abs(best - targetSec) ? cur : best,
    );
    setTargetSec(nearest);
  };

  // Manual h/m inputs — derived from targetSec, always in sync.
  const hours = Math.floor(targetSec / 3600);
  const minutes = Math.floor((targetSec % 3600) / 60);

  const { data: task } = useTask(taskId ?? undefined);
  useEffect(() => {
    if (!task || handledRef.current === task.id) return;
    if (task.status === "completed") {
      handledRef.current = task.id;
      setExtending(false);
      onExtended();
      toast.success("Video extended");
    }
    if (task.status === "failed") {
      handledRef.current = task.id;
      setExtending(false);
      toast.error(task.error ?? "Extension failed");
    }
  }, [task, onExtended]);

  const handleExtend = async () => {
    if (!project.composed_asset_id) return;
    if (targetSec <= sourceDur) {
      toast.error(
        `Target must be longer than the current video (${sourceMin} min)`,
      );
      return;
    }
    setExtending(true);
    handledRef.current = null;
    try {
      const { data } = await api.post("/compose/extend", {
        project_id: project.id,
        target_duration_seconds: targetSec,
      });
      setTaskId(data.id);
    } catch {
      setExtending(false);
      toast.error("Failed to start extension");
    }
  };

  return (
    <Card className="border-amber-500/30 bg-amber-500/5">
      <CardContent className="space-y-4">
        <div className="flex items-start gap-3">
          <RefreshCw className="mt-0.5 size-4 text-amber-400" />
          <div className="flex-1 space-y-1">
            <p className="text-sm font-medium">Extend video by looping</p>
            <p className="text-xs text-muted-foreground">
              Splice the existing video to itself{" "}
              {repeats > 0 ? `(${repeats}× to fill ${fmtHM(targetSec)})` : ""}{" "}
              and trim to the target length. No re-rendering — finishes in seconds.
              {sourceDur > 0 && ` Source: ${fmtHM(sourceDur)}.`}
            </p>
            <p className="text-[11px] text-muted-foreground/80">
              Output matches your target exactly. The last song may end
              mid-track — to avoid that, use the track-end markers below
              or “Snap to nearest track end” to pick a clean boundary.
            </p>
          </div>
        </div>

        {/* Slider with snap markers below */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label className="text-xs">
              Target duration:{" "}
              <span className="font-mono text-foreground">
                {fmtHM(targetSec)}
              </span>
            </Label>
            {allSnaps.length > 0 && (
              <Button
                size="xs"
                variant="ghost"
                onClick={snapToNearest}
                className="h-6"
              >
                Snap to nearest track end
              </Button>
            )}
          </div>
          <Slider
            min={minTarget}
            max={maxTarget}
            step={1}
            value={[Math.min(maxTarget, Math.max(minTarget, targetSec))]}
            onValueChange={(v) => {
              const val = Array.isArray(v) ? v[0] : v;
              setTargetSec(val);
            }}
          />
          {allSnaps.length > 0 && (
            <div className="relative h-3">
              {allSnaps.map((s) => {
                const pct = ((s - minTarget) / (maxTarget - minTarget)) * 100;
                if (pct < 0 || pct > 100) return null;
                const isCurrent = Math.abs(targetSec - s) < 5;
                return (
                  <button
                    key={s}
                    type="button"
                    onClick={() => setTargetSec(s)}
                    title={`${fmtHM(s)} (track-end boundary)`}
                    className={cn(
                      "absolute -top-0.5 h-2 w-0.5 -translate-x-1/2 cursor-pointer transition",
                      isCurrent
                        ? "bg-amber-400 h-3 w-1"
                        : "bg-muted-foreground/40 hover:bg-amber-400/70",
                    )}
                    style={{ left: `${pct}%` }}
                  />
                );
              })}
            </div>
          )}
          <p className="text-[11px] text-muted-foreground">
            {allSnaps.length > 0
              ? `${allSnaps.length} track-end markers — click any to snap there.`
              : "Drag the slider to any duration."}
          </p>
        </div>

        {/* Manual h/m inputs */}
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1">
            <Label className="text-xs">Hours</Label>
            <Input
              type="number"
              min={0}
              max={12}
              value={hours}
              onChange={(e) => {
                const h = Math.max(0, Math.min(12, parseInt(e.target.value, 10) || 0));
                setTargetSec(
                  Math.min(maxTarget, Math.max(minTarget, h * 3600 + minutes * 60)),
                );
              }}
              className="h-8 w-20"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Minutes</Label>
            <Input
              type="number"
              min={0}
              max={59}
              value={minutes}
              onChange={(e) => {
                const m = Math.max(0, Math.min(59, parseInt(e.target.value, 10) || 0));
                setTargetSec(
                  Math.min(maxTarget, Math.max(minTarget, hours * 3600 + m * 60)),
                );
              }}
              className="h-8 w-20"
            />
          </div>
          <div className="flex-1" />
          <Button
            size="sm"
            onClick={handleExtend}
            disabled={
              extending ||
              !project.composed_asset_id ||
              !sourceDur ||
              targetSec <= sourceDur
            }
          >
            {extending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Extending…
              </>
            ) : (
              <>
                <RefreshCw className="size-3.5" />
                Extend to {fmtHM(targetSec)}
              </>
            )}
          </Button>
        </div>

        {extending && task && (
          <div className="space-y-1">
            <div className="flex items-center justify-between text-xs">
              <span className="text-muted-foreground">
                {task.status_message ?? "Working…"}
              </span>
              <span className="tabular-nums">
                {Math.round(task.progress ?? 0)}%
              </span>
            </div>
            <Progress value={task.progress ?? 0} />
          </div>
        )}
      </CardContent>
    </Card>
  );
}
