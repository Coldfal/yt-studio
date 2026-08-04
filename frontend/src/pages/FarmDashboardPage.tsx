/**
 * Farm Dashboard — Phase 4 of farm redesign.
 *
 * Multi-channel control room. Three stacked panels:
 *   1. Fleet calendar (7-day grid of scheduled runs)
 *   2. Failed task triage (last 7 days of failures + retry/dismiss)
 *   3. Channel quota stack (live rate-limit bars per channel)
 *
 * Doesn't replace the per-channel Dashboard — that's still the
 * fastest way to fire a one-off Generate. This page is where the
 * operator checks "is anything broken / what's running tonight".
 */
import { Tractor } from "lucide-react";
import { FleetCalendar } from "@/components/farm/FleetCalendar";
import { FailedTaskTriage } from "@/components/farm/FailedTaskTriage";
import { ChannelQuotaStack } from "@/components/farm/ChannelQuotaStack";

export default function FarmDashboardPage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-bold">
          <Tractor className="size-6 text-primary" />
          Farm
        </h1>
        <p className="mt-1 text-sm text-muted-foreground">
          Fleet-wide overview: scheduled runs, failures to triage, and
          per-channel quota headroom.
        </p>
      </div>

      <FleetCalendar />

      <div className="grid gap-4 lg:grid-cols-2">
        <FailedTaskTriage />
        <ChannelQuotaStack />
      </div>
    </div>
  );
}
