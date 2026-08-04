import { useNavigate } from "react-router-dom";
import { AlertTriangle, RefreshCw, ExternalLink } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";

/**
 * Reusable failure card. Maps known error patterns to actionable buttons —
 * "Reconnect YouTube" for invalid_grant, "Install Claude Code" for CLI not
 * found, plain "Retry" for unknown FFmpeg / generic errors. Centralises the
 * error-to-action mapping so individual pages don't have to repeat it.
 */
export interface TaskFailureCardProps {
  /** Error message returned by the backend task. */
  error: string;
  /** Optional channel id for "Reconnect YouTube" navigation. */
  channelId?: number | null;
  /** Optional retry handler — when present, a "Retry" button is shown. */
  onRetry?: () => void;
  /** Tighter rendering (used inside small cards). */
  compact?: boolean;
}

interface ErrorAction {
  /** Human-readable explanation prepended to the raw error. */
  hint?: string;
  /** Button label. */
  buttonLabel: string;
  /** Click handler — typically navigates somewhere. */
  onClick: (navigate: ReturnType<typeof useNavigate>, channelId: number | null) => void;
}

function mapError(error: string, channelId: number | null | undefined): ErrorAction | null {
  const e = error.toLowerCase();

  if (e.includes("invalid_grant") || e.includes("token has been expired")
      || e.includes("authorization expired") || e.includes("revoked")) {
    return {
      hint: "Your YouTube authorization expired or was revoked.",
      buttonLabel: channelId ? "Reconnect YouTube" : "Reconnect",
      onClick: (nav, cid) => {
        if (cid) nav(`/channels/${cid}`);
        else nav("/channels");
      },
    };
  }

  if (e.includes("claude code cli") || e.includes("claude not found")
      || e.includes("not on path") && e.includes("claude")) {
    return {
      hint: "The Claude Code CLI isn't reachable.",
      buttonLabel: "Open Settings",
      onClick: (nav) => nav("/settings"),
    };
  }

  if (e.includes("rate limit") || e.includes("rate-limit")) {
    return {
      hint: "Rate limit hit — wait a minute and retry.",
      buttonLabel: "Retry",
      onClick: () => { /* no-op; caller's onRetry handles it */ },
    };
  }

  if (e.includes("ffmpeg")) {
    return {
      hint: "Render failed (FFmpeg).",
      buttonLabel: "Retry",
      onClick: () => { /* no-op; caller's onRetry handles it */ },
    };
  }

  return null;
}

export function TaskFailureCard({
  error,
  channelId,
  onRetry,
  compact,
}: TaskFailureCardProps) {
  const navigate = useNavigate();
  const action = mapError(error, channelId ?? null);

  return (
    <Card className="border-destructive/40 bg-destructive/5">
      <CardContent className={compact ? "space-y-2 py-3 text-xs" : "space-y-2 py-3 text-sm"}>
        <p className="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle className={compact ? "size-3" : "size-4"} />
          {action?.hint ?? "Task failed"}
        </p>
        <p className="text-muted-foreground line-clamp-3">{error}</p>
        <div className="flex flex-wrap items-center gap-2">
          {action && action.buttonLabel !== "Retry" && (
            <Button
              size="sm"
              variant="default"
              onClick={() => action.onClick(navigate, channelId ?? null)}
            >
              <ExternalLink className="size-3.5" />
              {action.buttonLabel}
            </Button>
          )}
          {onRetry && (
            <Button size="sm" variant="outline" onClick={onRetry}>
              <RefreshCw className="size-3.5" />
              Retry
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
