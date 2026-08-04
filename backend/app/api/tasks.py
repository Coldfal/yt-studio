from __future__ import annotations

import asyncio
import json
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sse_starlette.sse import EventSourceResponse

from app.database import get_db
from app.models import BackgroundTask
from app.schemas.task import TaskResponse
from app.workers.task_runner import task_runner

router = APIRouter(prefix="/api/tasks", tags=["tasks"])


@router.get("/stream")
async def task_stream() -> EventSourceResponse:
    async def event_generator():
        queue = task_runner.subscribe()
        try:
            while True:
                try:
                    # 15s keepalive — short enough that idle proxies
                    # (some corporate / nginx setups disconnect at 30-60s
                    # idle) never see us go quiet. Phase 3 reliability
                    # work paired with frontend SSE backoff.
                    data = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield {
                        "event": "task_update",
                        "data": json.dumps(data) if isinstance(data, dict) else str(data),
                    }
                except asyncio.TimeoutError:
                    # Comment-style ping: sse_starlette emits `:keepalive\n\n`
                    # which the EventSource ignores but keeps the TCP/HTTP
                    # connection warm.
                    yield {"comment": "keepalive"}
        except asyncio.CancelledError:
            pass
        finally:
            task_runner.unsubscribe(queue)

    return EventSourceResponse(event_generator())


@router.get("/", response_model=list[TaskResponse])
async def list_tasks(
    status: Optional[str] = None,
    task_type: Optional[str] = None,
    project_id: Optional[int] = None,
    channel_id: Optional[int] = None,
    acknowledged: Optional[bool] = None,
    since_days: Optional[int] = None,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
) -> list[TaskResponse]:
    stmt = select(BackgroundTask).order_by(BackgroundTask.created_at.desc())
    if status is not None:
        stmt = stmt.where(BackgroundTask.status == status)
    if task_type is not None:
        stmt = stmt.where(BackgroundTask.task_type == task_type)
    if project_id is not None:
        stmt = stmt.where(BackgroundTask.project_id == project_id)
    if channel_id is not None:
        # Dashboard's per-channel "last generation" diagnostic line
        # filters here. Tasks without channel_id (rare) are excluded.
        stmt = stmt.where(BackgroundTask.channel_id == channel_id)
    if acknowledged is not None:
        # Phase 4 of farm redesign — Fleet triage filters
        # un-acknowledged failures (?acknowledged=false). True returns
        # only dismissed rows; omit to ignore.
        if acknowledged:
            stmt = stmt.where(BackgroundTask.acknowledged_at.isnot(None))
        else:
            stmt = stmt.where(BackgroundTask.acknowledged_at.is_(None))
    if since_days is not None and since_days > 0:
        from datetime import datetime as _dt, timedelta as _td
        cutoff = _dt.utcnow() - _td(days=since_days)
        stmt = stmt.where(BackgroundTask.created_at >= cutoff)
    stmt = stmt.limit(limit)

    result = await db.execute(stmt)
    tasks = result.scalars().all()
    return [TaskResponse.model_validate(t) for t in tasks]


@router.get("/{task_id}", response_model=TaskResponse)
async def get_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    task = await db.get(BackgroundTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    return TaskResponse.model_validate(task)


@router.post("/{task_id}/cancel", response_model=TaskResponse)
async def cancel_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Cancel a task — marks DB row + HARD-KILLS any subprocesses
    registered under this task_id (ffmpeg, visualizer engine, etc.).

    Pre-2026-05-16 this only flipped the DB row. Operator pain: the
    underlying ffmpeg kept running for hours after 'cancel' because
    the wait loops didn't observe the DB status. Now we kill the
    spawned processes too via app.services.process_registry.
    """
    task = await db.get(BackgroundTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")

    # Mark DB first so any further progress updates from the (about-
    # to-die) handler land on a 'cancelled' row, not a 'running' one.
    task.status = "cancelled"
    task.status_message = "Cancelled by operator"
    await db.commit()
    await db.refresh(task)

    # Hard-kill any registered subprocesses for this task. terminate()
    # then SIGKILL after 2 seconds for stubborn ones. Idempotent —
    # no-op if the task isn't currently running anything.
    from app.services.process_registry import kill_task as _kill
    killed = _kill(task_id)
    if killed:
        import logging
        logging.getLogger(__name__).info(
            "cancel_task %d: hard-killed %d subprocess(es)", task_id, killed,
        )
    return TaskResponse.model_validate(task)


@router.post("/{task_id}/retry", response_model=TaskResponse)
async def retry_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Re-enqueue a failed task. Resets status, clears error, keeps the
    original ``result`` blob (which carries the input parameters for
    most task types — e.g. preset_id, url, prompt). Powers the
    "Retry" button in the dashboard's Failed Tasks panel.
    """
    task = await db.get(BackgroundTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    if task.status not in ("failed", "cancelled"):
        raise HTTPException(
            status_code=400,
            detail=f"Cannot retry task in status '{task.status}'",
        )
    task.status = "pending"
    task.error = None
    task.progress = 0.0
    task.status_message = "Queued for retry"
    task.started_at = None
    task.completed_at = None
    await db.commit()
    await db.refresh(task)
    await task_runner.enqueue(task.id)
    return TaskResponse.model_validate(task)


@router.post("/{task_id}/acknowledge", response_model=TaskResponse)
async def acknowledge_task(
    task_id: int,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Operator-dismiss a failed/cancelled task in the Fleet triage
    panel. Sets ``acknowledged_at`` so future triage queries skip it
    while keeping the row for the audit log.
    """
    task = await db.get(BackgroundTask, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="Task not found")
    from datetime import datetime as _dt
    task.acknowledged_at = _dt.utcnow()
    await db.commit()
    await db.refresh(task)
    return TaskResponse.model_validate(task)


@router.post("/acknowledge-all")
async def acknowledge_all_failed(
    status: Optional[str] = "failed",
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Bulk-acknowledge every un-dismissed task in the given status
    (default ``failed``). Powers the Fleet triage 'Clear all' button.

    Rows stay in the table for the audit log — they just stop showing
    up in the triage panel which filters on
    ``acknowledged_at IS NULL``.
    """
    from datetime import datetime as _dt
    from sqlalchemy import update as _sa_update
    stmt = (
        _sa_update(BackgroundTask)
        .where(BackgroundTask.acknowledged_at.is_(None))
        .values(acknowledged_at=_dt.utcnow())
    )
    if status:
        stmt = stmt.where(BackgroundTask.status == status)
    result = await db.execute(stmt)
    await db.commit()
    return {"acknowledged": int(result.rowcount or 0)}
