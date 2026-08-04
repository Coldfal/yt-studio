import { Card, CardContent } from "@/components/ui/card";

/**
 * 9-card pulse-animated skeleton shown while the asset grid is loading.
 * Matches the ``sm:grid-cols-2 lg:grid-cols-3`` layout of the live grid
 * so there's no visual jump on hydrate.
 */
export function LoadingSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 9 }).map((_, i) => (
        <Card key={i}>
          <CardContent className="flex items-center gap-3">
            <div className="size-12 animate-pulse rounded-lg bg-muted" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-24 animate-pulse rounded bg-muted" />
              <div className="h-3 w-16 animate-pulse rounded bg-muted" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}
