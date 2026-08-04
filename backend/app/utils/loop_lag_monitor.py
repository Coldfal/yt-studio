"""Asyncio event-loop lag monitor.

Background coroutine that wakes every ~100ms via ``asyncio.sleep(0.1)``
and measures how long it actually took. If the actual delta is much
larger than the scheduled delta, the event loop was blocked by
synchronous work — either CPU-bound Python on the loop thread or a
blocking I/O call that wasn't run in an executor.

This pinpoints the operator-reported "app slow during compose" issue.
If the loop never stalls during a compose, the slowness is on the
frontend (React Query re-renders, Vite HMR overhead) or the database.
If it DOES stall, the log tells us where to look (correlate timestamps
with what's running).

Usage::

    monitor = LoopLagMonitor()
    asyncio.create_task(monitor.run())
    # ... later:
    stats = monitor.snapshot()
    # → {"max_lag_ms": 423, "stalls": [(timestamp, lag_ms), ...], "total_stalls": 17}

The monitor itself is cheap (~10 wakeups/sec, ~50 µs each) so leaving
it on in production is fine — the cost is invisible compared to the
slowness it diagnoses.
"""
from __future__ import annotations

import asyncio
import logging
import time
from collections import deque
from typing import Deque, Tuple

logger = logging.getLogger(__name__)

# How often we check. 100ms is a reasonable trade-off: small enough to
# catch sub-second stalls, infrequent enough that the monitor itself
# doesn't add measurable overhead.
_CHECK_INTERVAL_S = 0.1

# Anything beyond this is "abnormal" and gets logged + recorded.
# The first ~10ms over the scheduled interval is just OS scheduling
# noise; below that isn't interesting. 150ms means the loop was
# blocked for >50ms, which is the threshold where a human starts
# noticing UI lag.
_STALL_THRESHOLD_S = 0.15

# Number of recent stalls to keep for the /diagnostics endpoint.
_MAX_HISTORY = 200


class LoopLagMonitor:
    def __init__(self) -> None:
        # Each entry: (unix_timestamp, lag_ms)
        self._stalls: Deque[Tuple[float, float]] = deque(maxlen=_MAX_HISTORY)
        self._total_stalls = 0
        self._max_lag_ms = 0.0
        self._started_at = time.time()
        self._sample_count = 0

    async def run(self) -> None:
        logger.info("Event-loop lag monitor started (check interval=%.0fms, stall threshold=%.0fms)",
                    _CHECK_INTERVAL_S * 1000, _STALL_THRESHOLD_S * 1000)
        while True:
            start = time.monotonic()
            try:
                await asyncio.sleep(_CHECK_INTERVAL_S)
            except asyncio.CancelledError:
                logger.info("Event-loop lag monitor stopped")
                return
            elapsed = time.monotonic() - start
            self._sample_count += 1
            if elapsed > _STALL_THRESHOLD_S:
                lag_ms = (elapsed - _CHECK_INTERVAL_S) * 1000
                ts = time.time()
                self._stalls.append((ts, lag_ms))
                self._total_stalls += 1
                if lag_ms > self._max_lag_ms:
                    self._max_lag_ms = lag_ms
                # Log at WARNING for noticeable stalls so they're easy
                # to spot in the uvicorn log without scrolling.
                logger.warning(
                    "Event-loop stalled %.0fms (sample #%d total stalls=%d)",
                    lag_ms, self._sample_count, self._total_stalls,
                )

    def snapshot(self) -> dict:
        """Return a JSON-friendly snapshot of the lag history."""
        uptime_s = time.time() - self._started_at
        return {
            "uptime_seconds": round(uptime_s, 1),
            "sample_count": self._sample_count,
            "total_stalls": self._total_stalls,
            "max_lag_ms": round(self._max_lag_ms, 1),
            "stall_threshold_ms": _STALL_THRESHOLD_S * 1000,
            "check_interval_ms": _CHECK_INTERVAL_S * 1000,
            "recent_stalls": [
                {"timestamp": round(ts, 1), "lag_ms": round(lag_ms, 1)}
                for ts, lag_ms in list(self._stalls)
            ],
        }
