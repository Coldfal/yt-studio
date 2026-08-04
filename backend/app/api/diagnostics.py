"""Diagnostic endpoints — event-loop lag, subscriber counts, etc."""
from __future__ import annotations

from fastapi import APIRouter, Request

from app.workers.task_runner import task_runner

router = APIRouter(prefix="/api/diagnostics", tags=["diagnostics"])


@router.get("/loop-lag")
async def loop_lag(request: Request) -> dict:
    """Snapshot of the event-loop lag monitor.

    Use this to confirm whether the asyncio main loop is being blocked
    during a compose. If ``max_lag_ms`` stays under ~50ms and
    ``total_stalls`` doesn't grow, the loop is healthy and any
    perceived sluggishness lives in the frontend (Vite/React) or the
    network. If stalls are spiking, the magnitude + frequency tells us
    how bad and the uvicorn log shows when (correlate with task
    activity).
    """
    monitor = getattr(request.app.state, "lag_monitor", None)
    if monitor is None:
        return {"error": "lag monitor not initialised"}
    return monitor.snapshot()


@router.get("/sse-subscribers")
async def sse_subscribers() -> dict:
    """Number of SSE subscriber queues currently held by task_runner.

    Should equal the number of browser tabs / clients listening on
    ``/api/tasks/stream``. If it grows unboundedly across reloads
    we've got a leak (subscribers not unsubscribing on disconnect).
    """
    subs = getattr(task_runner, "_subscribers", [])
    # Each entry is an asyncio.Queue; report its current size so we
    # can also spot stale subscribers whose consumer died but whose
    # queue keeps growing.
    return {
        "count": len(subs),
        "queue_sizes": [getattr(q, "qsize", lambda: 0)() for q in subs],
    }
