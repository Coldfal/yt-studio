import { useEffect, useRef, useState } from "react";

/** SSE task_update events are partial – they may not carry every BackgroundTask field. */
export type TaskUpdateEvent = Record<string, unknown>;

/**
 * Subscribe to the backend's `/api/tasks/stream` SSE endpoint with
 * exponential-backoff reconnection.
 *
 * Why backoff matters here: a backend restart, a flaky proxy, or a
 * locally suspended laptop drops the EventSource. Without backoff
 * we either reconnect aggressively (slamming a server that's still
 * coming up) or wait too long (sluggish progress bars on tasks that
 * are actually firing). Schedule:
 *
 *   1s → 2s → 4s → 8s → 16s → 30s (capped)
 *
 * On every successful connection (`onopen` fires) the backoff resets
 * to 1s — so a brief blip after a long-stable session doesn't pay
 * the full reconnect ladder.
 *
 * Each delay also carries ~25% jitter so multiple tabs don't
 * thundering-herd reconnect at the same instant after a server
 * restart.
 */
export function useTaskSSE(onTaskUpdate: (event: TaskUpdateEvent) => void) {
  const [connected, setConnected] = useState(false);
  const callbackRef = useRef(onTaskUpdate);
  callbackRef.current = onTaskUpdate;

  useEffect(() => {
    let eventSource: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let unmounted = false;
    /** 0-indexed; resets to 0 on every successful onopen. */
    let attempt = 0;

    const BASE_DELAY_MS = 1_000;
    const MAX_DELAY_MS = 30_000;

    function nextDelay(): number {
      const exp = Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS);
      // 25% jitter on top — never below the base, never above 1.25× the cap.
      const jitter = Math.random() * 0.25 * exp;
      return Math.round(exp + jitter);
    }

    function connect() {
      if (unmounted) return;

      eventSource = new EventSource("/api/tasks/stream");

      eventSource.onopen = () => {
        if (unmounted) return;
        setConnected(true);
        // Successful connection — reset backoff so the next blip
        // starts at 1s again. Otherwise after a long-running session
        // the first reconnect would be 30s slow.
        attempt = 0;
      };

      eventSource.addEventListener("task_update", (event: MessageEvent) => {
        try {
          const data: TaskUpdateEvent = JSON.parse(event.data);
          callbackRef.current(data);
        } catch {
          // Ignore malformed events
        }
      });

      eventSource.onerror = () => {
        if (unmounted) return;
        setConnected(false);
        eventSource?.close();
        eventSource = null;
        const delay = nextDelay();
        attempt = Math.min(attempt + 1, 10); // cap so 2**attempt doesn't overflow
        reconnectTimer = setTimeout(connect, delay);
      };
    }

    connect();

    return () => {
      unmounted = true;
      eventSource?.close();
      if (reconnectTimer) clearTimeout(reconnectTimer);
    };
  }, []);

  return { connected };
}
