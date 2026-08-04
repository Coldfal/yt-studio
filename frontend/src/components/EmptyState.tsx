import type { LucideIcon } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Reusable empty-state card with an icon, two lines of guidance, and
 * a primary action. Replaces ad-hoc "Nothing here yet" copy across pages.
 */
export interface EmptyStateProps {
  icon: LucideIcon;
  title: string;
  description?: string;
  actionLabel?: string;
  onAction?: () => void;
  secondaryLabel?: string;
  onSecondary?: () => void;
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  actionLabel,
  onAction,
  secondaryLabel,
  onSecondary,
}: EmptyStateProps) {
  return (
    <Card>
      <CardContent className="flex flex-col items-center justify-center gap-3 py-12 text-center">
        <Icon className="size-10 text-muted-foreground/60" />
        <div>
          <p className="text-base font-medium">{title}</p>
          {description && (
            <p className="mt-1 max-w-sm text-sm text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {(actionLabel || secondaryLabel) && (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            {secondaryLabel && (
              <Button variant="outline" onClick={onSecondary}>
                {secondaryLabel}
              </Button>
            )}
            {actionLabel && <Button onClick={onAction}>{actionLabel}</Button>}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
