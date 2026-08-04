/**
 * Fleet Calendar — Phase 4 of farm redesign.
 *
 * 7-day calendar grid projecting every active recurring schedule
 * across all channels. Each cell is a day; each cell lists the
 * scheduled compose+upload runs that will fire that day with a
 * "Skip" button so the operator can suppress a specific instance
 * without disturbing the cron expression.
 *
 * The backend's /fleet/schedule endpoint returns a flat list of
 * occurrences; we bucket them client-side by local date so the grid
 * renders in the user's timezone.
 */
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { format, addDays, startOfDay } from "date-fns";
import { Calendar, Loader2, SkipForward, Clock } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import api from "@/lib/api";

interface Occurrence {
  channel_id: number;
  channel_name: string;
  preset_id: number;
  fire_at: string;
  cron: string;
  timezone: string;
}

interface FleetSchedule {
  window_days: number;
  occurrences: Occurrence[];
  now_utc: string;
}

export function FleetCalendar() {
  const qc = useQueryClient();
  const scheduleQ = useQuery<FleetSchedule>({
    queryKey: ["fleet-schedule", 7],
    queryFn: async () => {
      const { data } = await api.get("/automation/fleet/schedule", {
        params: { days: 7 },
      });
      return data;
    },
    staleTime: 60_000,
  });

  const skipMut = useMutation({
    mutationFn: async (presetId: number) => {
      const { data } = await api.post(
        `/automation/presets/${presetId}/skip-next`,
      );
      return data;
    },
    onSuccess: () => {
      toast.success("Skipped — next run shifted");
      qc.invalidateQueries({ queryKey: ["fleet-schedule"] });
    },
    onError: () => toast.error("Couldn't skip the run"),
  });

  /** Group occurrences by local date label. */
  const byDay = useMemo(() => {
    const map = new Map<string, Occurrence[]>();
    for (const occ of scheduleQ.data?.occurrences ?? []) {
      const local = new Date(occ.fire_at);
      const key = format(startOfDay(local), "yyyy-MM-dd");
      const list = map.get(key) ?? [];
      list.push(occ);
      map.set(key, list);
    }
    return map;
  }, [scheduleQ.data]);

  /** Build the 7-day window starting today. */
  const days = useMemo(() => {
    const today = startOfDay(new Date());
    return Array.from({ length: 7 }, (_, i) => addDays(today, i));
  }, []);

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Calendar className="size-4 text-primary" />
          Fleet calendar · next 7 days
        </CardTitle>
        <p className="text-[11px] text-muted-foreground">
          Every recurring schedule projected forward. Click "Skip" on
          an occurrence to bump that specific fire to the next cron
          slot without changing the schedule.
        </p>
      </CardHeader>
      <CardContent className="space-y-2">
        {scheduleQ.isLoading && (
          <div className="flex justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        )}

        {scheduleQ.data && scheduleQ.data.occurrences.length === 0 && (
          <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-6 text-center text-xs text-muted-foreground">
            No recurring schedules active. Set one in a channel's Quick
            Generate settings (Dashboard → ⋮ → Schedule).
          </p>
        )}

        {scheduleQ.data && scheduleQ.data.occurrences.length > 0 && (
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-7">
            {days.map((d) => {
              const key = format(d, "yyyy-MM-dd");
              const occs = byDay.get(key) ?? [];
              const isToday =
                format(d, "yyyy-MM-dd") === format(new Date(), "yyyy-MM-dd");
              return (
                <div
                  key={key}
                  className={`rounded-md border ${
                    isToday ? "border-primary/40 bg-primary/5" : "border-border/50 bg-muted/20"
                  } p-2 text-xs min-h-[160px]`}
                >
                  <div className="mb-1.5 flex items-center justify-between">
                    <span className="font-semibold">{format(d, "EEE")}</span>
                    <span className="text-[10px] text-muted-foreground">
                      {format(d, "MMM d")}
                    </span>
                  </div>
                  {occs.length === 0 ? (
                    <p className="text-[10px] text-muted-foreground/60 italic">
                      Nothing
                    </p>
                  ) : (
                    <ul className="space-y-1">
                      {occs.map((occ, idx) => {
                        const dt = new Date(occ.fire_at);
                        return (
                          <li
                            key={`${occ.preset_id}-${idx}`}
                            className="group rounded border border-border/40 bg-background/40 p-1.5 text-[10px]"
                          >
                            <div className="flex items-center justify-between gap-1">
                              <span className="truncate font-medium">
                                {occ.channel_name}
                              </span>
                              <span className="flex items-center gap-0.5 text-muted-foreground tabular-nums">
                                <Clock className="size-2.5" />
                                {format(dt, "HH:mm")}
                              </span>
                            </div>
                            {idx === 0 && (
                              <button
                                type="button"
                                onClick={() => skipMut.mutate(occ.preset_id)}
                                disabled={skipMut.isPending}
                                className="mt-1 flex items-center gap-0.5 text-[9px] text-muted-foreground hover:text-foreground"
                                title="Skip this occurrence"
                              >
                                <SkipForward className="size-2.5" />
                                Skip next
                              </button>
                            )}
                          </li>
                        );
                      })}
                    </ul>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {scheduleQ.data && (
          <p className="pt-2 text-[10px] text-muted-foreground">
            Showing {scheduleQ.data.occurrences.length} occurrences.{" "}
            <Badge variant="outline" className="ml-1 text-[9px]">
              Skip applies to the next fire on that preset only.
            </Badge>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
