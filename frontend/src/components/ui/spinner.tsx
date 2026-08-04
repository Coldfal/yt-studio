import * as React from "react";
import { Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Canonical loading indicator. Replaces the inline ``<Loader2 className="size-4 animate-spin" />``
 * pattern that drifted across pages with subtly different sizing and
 * spacing. Picks the right Tailwind size class from a sane scale,
 * rather than each caller spelling out ``size-3`` / ``size-4`` /
 * ``size-5``.
 *
 * Common compositions:
 *
 *   <Spinner />                           // default size-4, inherits text color
 *   <Spinner size="sm" />                 // size-3, for tight inline spots
 *   <Spinner size="lg" className="text-primary" />
 *   <Spinner label="Loading channels…" /> // visible text + icon
 *
 * For full-page loading states use ``<Spinner.Page />`` which
 * includes the standard centering + height + muted text styling
 * that pages used to copy-paste.
 */
const SIZE_CLASSES = {
  xs: "size-2.5",
  sm: "size-3",
  md: "size-4",
  lg: "size-5",
  xl: "size-6",
} as const;

export type SpinnerSize = keyof typeof SIZE_CLASSES;

export interface SpinnerProps extends React.HTMLAttributes<HTMLSpanElement> {
  size?: SpinnerSize;
  /** Visible text rendered next to the icon. */
  label?: React.ReactNode;
}

export function Spinner({
  size = "md",
  label,
  className,
  ...rest
}: SpinnerProps) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "inline-flex items-center gap-2 text-muted-foreground",
        className,
      )}
      {...rest}
    >
      <Loader2 className={cn("animate-spin", SIZE_CLASSES[size])} aria-hidden />
      {label && <span>{label}</span>}
      {!label && <span className="sr-only">Loading…</span>}
    </span>
  );
}

/** Centered full-card / full-section loading state. */
function SpinnerPage({
  label = "Loading…",
  className,
}: {
  label?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-40 items-center justify-center text-muted-foreground",
        className,
      )}
    >
      <Spinner size="lg" label={label} />
    </div>
  );
}

Spinner.Page = SpinnerPage;
