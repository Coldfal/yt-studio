import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Debounced state hook with an explicit "commit" callback.
 *
 * Replaces the ad-hoc ``saveTimerRef = useRef(setTimeout)`` patterns
 * that had drifted across pages (DashboardPage, NewProjectPage) with
 * subtly different cleanup behavior. The hook:
 *
 * - exposes immediate state for the input ``value`` so the UI is
 *   responsive,
 * - calls ``onCommit(value)`` after ``delayMs`` of no further changes,
 * - cancels the pending commit on unmount so navigating away
 *   mid-typing doesn't fire a stale save against the wrong record,
 * - cancels the pending commit when the dependency identity changes
 *   (e.g. switching to a different row) so each row's save is
 *   isolated.
 *
 * Usage:
 *
 *   const [name, setName] = useDebouncedState(
 *     channel.name,
 *     500,
 *     async (next) => api.patch(`/channels/${channel.id}`, { name: next }),
 *     [channel.id],   // re-bind when row changes
 *   );
 *
 *   <Input value={name} onChange={(e) => setName(e.target.value)} />
 *
 * The setter accepts either a value or a setState-style updater
 * function.
 */
export function useDebouncedState<T>(
  initial: T,
  delayMs: number,
  onCommit: (next: T) => void | Promise<void>,
  deps: ReadonlyArray<unknown> = [],
): [T, (next: T | ((prev: T) => T)) => void, () => void] {
  const [value, setValue] = useState<T>(initial);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const commitRef = useRef(onCommit);

  // Keep the callback ref fresh without re-running the debounce cycle.
  useEffect(() => {
    commitRef.current = onCommit;
  }, [onCommit]);

  // Reset the local state + cancel any pending commit when the
  // identity dep changes (e.g. user clicks to a different row).
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    setValue(initial);
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    // initial intentionally NOT in deps — re-binding on `deps` is the contract.
  }, deps);

  // Cancel pending commit on unmount.
  useEffect(() => {
    return () => {
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
    };
  }, []);

  const set = useCallback(
    (next: T | ((prev: T) => T)) => {
      setValue((prev) => {
        const resolved =
          typeof next === "function"
            ? (next as (prev: T) => T)(prev)
            : next;
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void commitRef.current(resolved);
        }, delayMs);
        return resolved;
      });
    },
    [delayMs],
  );

  // Force-flush helper — useful for "save before navigate" handlers.
  const flush = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
      void commitRef.current(value);
    }
  }, [value]);

  return [value, set, flush];
}
