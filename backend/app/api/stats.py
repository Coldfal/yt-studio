"""Per-channel + global stats for the dashboard.

The dashboard needs a single round-trip to render its summary card
(tasks today by status, last successful upload, last failure). This
router gives it.
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import BackgroundTask, Channel, VideoProject

router = APIRouter(prefix="/api/stats", tags=["stats"])


def _utc_today_start() -> datetime:
    """Midnight UTC of today, naive (matches how we store timestamps)."""
    now = datetime.utcnow()
    return now.replace(hour=0, minute=0, second=0, microsecond=0)


@router.get("/channels")
async def channel_stats(
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Return one row per channel with task counts + recency timestamps.

    Shape::

        [
          {
            "channel_id": 1,
            "channel_name": "Lofi Channel",
            "tasks_today": {"completed": 3, "failed": 0, "running": 1, "pending": 0},
            "last_upload_at": "2026-05-04T18:00:00",
            "last_failure_at": "2026-05-03T12:00:00",
            "last_failure_message": "YouTube quota exceeded",
            "last_failure_task_type": "youtube_upload"
          },
          ...
        ]

    Cheap query — one COUNT per (channel, status) bucket plus two
    `last_*` lookups. Safe to call on every dashboard render.
    """
    today_start = _utc_today_start()
    seven_days_ago = datetime.utcnow() - timedelta(days=7)

    channels = (await db.execute(select(Channel))).scalars().all()
    out: list[dict[str, Any]] = []

    for channel in channels:
        # Tasks today, grouped by status
        rows = await db.execute(
            select(BackgroundTask.status, func.count(BackgroundTask.id))
            .where(BackgroundTask.channel_id == channel.id)
            .where(BackgroundTask.created_at >= today_start)
            .group_by(BackgroundTask.status)
        )
        counts: dict[str, int] = {
            "completed": 0,
            "failed": 0,
            "running": 0,
            "pending": 0,
        }
        for status, count in rows.all():
            counts[status or "unknown"] = int(count)

        # Last successful upload — straight from the project row, since
        # uploaded_at is the canonical "this video is live" marker.
        last_upload_row = await db.execute(
            select(VideoProject.uploaded_at)
            .where(VideoProject.channel_id == channel.id)
            .where(VideoProject.uploaded_at.is_not(None))
            .order_by(VideoProject.uploaded_at.desc())
            .limit(1)
        )
        last_upload_at = last_upload_row.scalar_one_or_none()

        # Last failure in the last 7 days (older than that is rarely
        # actionable — surface it but don't search forever).
        last_failure_row = await db.execute(
            select(
                BackgroundTask.completed_at,
                BackgroundTask.error,
                BackgroundTask.task_type,
            )
            .where(BackgroundTask.channel_id == channel.id)
            .where(BackgroundTask.status == "failed")
            .where(BackgroundTask.completed_at >= seven_days_ago)
            .order_by(BackgroundTask.completed_at.desc())
            .limit(1)
        )
        last_failure = last_failure_row.first()

        out.append({
            "channel_id": channel.id,
            "channel_name": channel.name,
            "tasks_today": counts,
            "last_upload_at": (
                last_upload_at.isoformat() if last_upload_at else None
            ),
            "last_failure_at": (
                last_failure[0].isoformat() if last_failure and last_failure[0] else None
            ),
            "last_failure_message": last_failure[1] if last_failure else None,
            "last_failure_task_type": last_failure[2] if last_failure else None,
        })

    return out


@router.get("/storage")
async def storage_stats(
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """Per-channel disk usage breakdown.

    Walks every Asset's ``filepath`` under ``settings.assets_dir`` and
    sums file sizes by ``(channel_id, asset_type)``. Used by the
    Channel detail "Storage" tab today and the Phase 3 retention
    worker tomorrow (it'll honour a per-channel disk cap).

    Sums come from ``Asset.file_size`` rather than ``stat()`` — same
    data, no I/O. Mismatches with disk reality mean the
    ``/api/assets/reconcile`` endpoint should be re-run.

    Shape::

        [
          {
            "channel_id": 1,
            "channel_name": "YomiBeats",
            "total_bytes": 12_345_678_901,
            "asset_count": 92,
            "by_type": {
              "music":    {"bytes": 4_500_000_000, "count": 80},
              "image":    {"bytes":   500_000_000, "count":  6},
              "composed": {"bytes": 7_345_678_901, "count":  6}
            }
          },
          ...
        ]
    """
    from app.models import Asset

    rows = await db.execute(
        select(
            Asset.channel_id,
            Asset.asset_type,
            func.sum(Asset.file_size),
            func.count(Asset.id),
        )
        .group_by(Asset.channel_id, Asset.asset_type)
    )

    # Build by-channel aggregate first.
    by_channel: dict[int, dict[str, Any]] = {}
    for ch_id, asset_type, total_bytes, count in rows.all():
        if ch_id is None:
            continue
        bucket = by_channel.setdefault(int(ch_id), {
            "channel_id": int(ch_id),
            "channel_name": None,
            "total_bytes": 0,
            "asset_count": 0,
            "by_type": {},
        })
        bytes_n = int(total_bytes or 0)
        count_n = int(count or 0)
        bucket["total_bytes"] += bytes_n
        bucket["asset_count"] += count_n
        bucket["by_type"][str(asset_type)] = {
            "bytes": bytes_n,
            "count": count_n,
        }

    # Attach channel names. Single query, then merge.
    channels = (await db.execute(select(Channel))).scalars().all()
    name_by_id = {c.id: c.name for c in channels}
    out: list[dict[str, Any]] = []
    for ch_id, bucket in sorted(by_channel.items()):
        bucket["channel_name"] = name_by_id.get(ch_id)
        out.append(bucket)
    return out


@router.get("/quota/{channel_id}")
async def channel_quota(channel_id: int) -> list[dict[str, Any]]:
    """Per-channel rate-limit bucket snapshot.

    Returns one row per provider with current tokens + capacity +
    seconds-until-full. Used by the upcoming dashboard "Quota" line
    on each channel card so the operator can see when they're about
    to hit a limit.

    Provider-keyed and per-channel — buckets are lazily created on
    first acquire, so a brand-new channel that's never run a task
    shows full capacity for every provider.
    """
    from app.services.rate_limiter import _PROVIDER_BUDGETS, rate_limiter

    out: list[dict[str, Any]] = []
    for provider in _PROVIDER_BUDGETS:
        snap = await rate_limiter.snapshot(
            provider=provider, channel_id=channel_id,
        )
        out.append(snap)
    return out


@router.post("/retention/preview")
async def retention_preview() -> dict[str, Any]:
    """Dry-run a retention sweep — no rows or files are touched.

    Reports what *would* be cleaned: count of expirable
    ``BackgroundTask`` rows by status + the orphan composed-video files
    on disk. Used by the admin UI to show the operator what the next
    run will do before they confirm.
    """
    from app.workers.retention_worker import (
        find_orphaned_files,
        prune_old_tasks,
    )

    task_counts = await prune_old_tasks(dry_run=True)
    orphans = await find_orphaned_files()
    orphan_total_bytes = sum(int(o.get("size_bytes") or 0) for o in orphans)
    return {
        "tasks_to_prune": task_counts,
        "orphan_files": {
            "count": len(orphans),
            "total_bytes": orphan_total_bytes,
            # Cap the list at 50 in the response so a freak case with
            # thousands of orphans doesn't blow up the JSON.
            "sample": orphans[:50],
        },
    }


@router.post("/retention/run")
async def retention_run(body: Optional[dict] = None) -> dict[str, Any]:
    """Execute a retention sweep. Pass ``{"include_orphans": true}``
    in the body to also delete orphaned files (default: tasks only —
    deletion is reversible-ish via DB recovery, file deletion is not).
    """
    from app.workers.retention_worker import (
        delete_orphaned_files,
        find_orphaned_files,
        prune_old_tasks,
    )

    body = body or {}
    include_orphans = bool(body.get("include_orphans", False))

    task_counts = await prune_old_tasks(dry_run=False)
    result: dict[str, Any] = {
        "tasks_pruned": task_counts,
        "orphan_files": None,
    }
    if include_orphans:
        orphans = await find_orphaned_files()
        result["orphan_files"] = await delete_orphaned_files(orphans)
    return result


@router.get("/analytics-runs")
async def analytics_runs(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Per-channel analytics-refresh status for the dashboard's
    freshness pill.

    Returns the most-recent run row for every YouTube-connected
    channel plus a small overall summary the pill can render
    directly:

    {
      "channels": [
        {
          "channel_id": int,
          "channel_name": str,
          "last_run_status": "completed" | "failed" | "running" | None,
          "last_completed_at": ISO datetime | None,
          "minutes_since": int | None,
          "videos_processed": int,
          "analytics_skipped": bool,
        }, ...
      ],
      "summary": {
        "channels_total": int,
        "channels_fresh": int,    # last_completed < 26h ago
        "channels_stale": int,    # last_completed > 26h or never
        "channels_failed": int,   # last attempt failed
        "youngest_completed_at": ISO | None,
        "oldest_completed_at": ISO | None,
      }
    }
    """
    from sqlalchemy import select as _select, func as _sa_func
    from app.models import Channel
    from app.models.analytics import AnalyticsRunLog

    rows = await db.execute(
        _select(Channel.id, Channel.name).where(
            Channel.youtube_credentials_json.isnot(None),
        )
    )
    connected = list(rows.all())
    if not connected:
        return {"channels": [], "summary": {
            "channels_total": 0, "channels_fresh": 0, "channels_stale": 0,
            "channels_failed": 0, "youngest_completed_at": None,
            "oldest_completed_at": None,
        }}

    # Most-recent log row per channel — single query via a window-style
    # MAX(id), exploiting the fact that ids are monotonic by created
    # time on SQLite.
    cids = [r[0] for r in connected]
    latest_id_q = await db.execute(
        _select(AnalyticsRunLog.channel_id, _sa_func.max(AnalyticsRunLog.id))
        .where(AnalyticsRunLog.channel_id.in_(cids))
        .group_by(AnalyticsRunLog.channel_id)
    )
    latest_ids = {cid: lid for cid, lid in latest_id_q.all()}
    if latest_ids:
        log_q = await db.execute(
            _select(AnalyticsRunLog).where(
                AnalyticsRunLog.id.in_(latest_ids.values()),
            )
        )
        logs_by_channel = {
            l.channel_id: l for l in log_q.scalars().all()
        }
    else:
        logs_by_channel = {}

    now = datetime.utcnow()
    fresh_cutoff = now - timedelta(hours=26)
    out: list[dict[str, Any]] = []
    fresh = stale = failed = 0
    youngest: Optional[datetime] = None
    oldest: Optional[datetime] = None
    for cid, cname in connected:
        log = logs_by_channel.get(cid)
        if log is None:
            stale += 1
            out.append({
                "channel_id": cid,
                "channel_name": cname,
                "last_run_status": None,
                "last_completed_at": None,
                "minutes_since": None,
                "videos_processed": 0,
                "analytics_skipped": False,
            })
            continue
        completed = log.completed_at
        is_fresh = completed is not None and completed > fresh_cutoff
        if log.status == "failed":
            failed += 1
        if is_fresh:
            fresh += 1
        else:
            stale += 1
        if completed:
            if youngest is None or completed > youngest:
                youngest = completed
            if oldest is None or completed < oldest:
                oldest = completed
        minutes_since = (
            int((now - completed).total_seconds() // 60)
            if completed else None
        )
        out.append({
            "channel_id": cid,
            "channel_name": cname,
            "last_run_status": log.status,
            "last_completed_at": completed.isoformat() if completed else None,
            "minutes_since": minutes_since,
            "videos_processed": log.videos_processed,
            "analytics_skipped": bool(log.analytics_skipped),
        })

    return {
        "channels": out,
        "summary": {
            "channels_total": len(connected),
            "channels_fresh": fresh,
            "channels_stale": stale,
            "channels_failed": failed,
            "youngest_completed_at": youngest.isoformat() if youngest else None,
            "oldest_completed_at": oldest.isoformat() if oldest else None,
        },
    }


@router.post("/analytics-runs/refresh")
async def trigger_analytics_refresh(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Manually kick off an analytics refresh for a channel.

    Powers the "Refresh now" button on the analytics page. Runs
    synchronously (a typical refresh is ~10–30 s wall time) so the
    caller gets the result inline.
    """
    from app.models import Channel
    from app.services.analytics_refresh_service import refresh_channel_analytics

    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not channel.youtube_credentials_json:
        raise HTTPException(
            status_code=400,
            detail="Channel not connected to YouTube",
        )
    return await refresh_channel_analytics(channel_id)


@router.get("/failed-tasks")
async def recent_failed_tasks(
    days: int = 7,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
) -> list[dict[str, Any]]:
    """All failed tasks across all channels in the last *days* days.

    Powers the "Failed Tasks" panel on the dashboard. Returns the
    minimum needed for a row + a one-click retry link.
    """
    cutoff = datetime.utcnow() - timedelta(days=days)

    rows = await db.execute(
        select(
            BackgroundTask.id,
            BackgroundTask.task_type,
            BackgroundTask.channel_id,
            BackgroundTask.project_id,
            BackgroundTask.error,
            BackgroundTask.completed_at,
            BackgroundTask.created_at,
            Channel.name,
        )
        .join(Channel, Channel.id == BackgroundTask.channel_id, isouter=True)
        .where(BackgroundTask.status == "failed")
        .where(BackgroundTask.created_at >= cutoff)
        .order_by(BackgroundTask.completed_at.desc().nullslast())
        .limit(limit)
    )

    out: list[dict[str, Any]] = []
    for r in rows.all():
        out.append({
            "task_id": r[0],
            "task_type": r[1],
            "channel_id": r[2],
            "project_id": r[3],
            "error": r[4],
            "completed_at": r[5].isoformat() if r[5] else None,
            "created_at": r[6].isoformat() if r[6] else None,
            "channel_name": r[7],
        })

    return out
