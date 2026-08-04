"""Simple automation scheduler that polls the DB for due presets.

Runs as an asyncio task started alongside the task_runner in main.py.
Every 60 seconds, it checks for active presets where ``next_run_at`` has
passed, creates a BackgroundTask for each, and advances ``next_run_at``
to the next cron occurrence.
"""
from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timedelta, timezone

from croniter import croniter
from sqlalchemy import select, text as _sa_text

from app.database import async_session, engine
from app.models import AutomationPreset, BackgroundTask

logger = logging.getLogger(__name__)

# How often to attempt a SQLite VACUUM. SQLite reclaims space lazily when
# rows are deleted; running VACUUM monthly keeps `studio.db` from drifting
# into multi-GB territory after retention sweeps in Phase 3.
_VACUUM_INTERVAL = timedelta(days=30)
_last_vacuum_at: datetime | None = None

# Daily retention sweep. Drops old completed/cancelled tasks (>30d)
# and old failed tasks (>90d). Orphan-file cleanup is intentionally
# NOT in the auto-tick — it deletes files from disk and we want the
# operator to confirm via the admin endpoint until the dry-run habit
# is established.
_RETENTION_INTERVAL = timedelta(days=1)
_last_retention_at: datetime | None = None

# Per-channel analytics refresh. Runs once per channel per ~24h.
# Cheap when nothing's due (single SELECT joined to AnalyticsRunLog).
# When a channel IS due, the actual refresh is YouTube-API-bound
# (~10 quota units, a few seconds wall time per channel) so we run
# them sequentially within a tick to avoid swamping the API.
_ANALYTICS_REFRESH_INTERVAL = timedelta(hours=20)

# Stuck-task watchdog. Marks long-running tasks as ``failed`` when
# their ``updated_at`` hasn't moved in this many minutes, so they
# stop blocking per-task-type concurrency budgets and surface in
# the dashboard's FailedTasksPanel where the user can hit Retry.
# YouTube uploads stall the most often (network blips during a
# resumable session), so the threshold is sized for them: 5 min of
# total silence is way longer than a normal chunk transfer (~30 s
# per 10 MB chunk on a typical home connection).
_STUCK_THRESHOLDS = {
    "youtube_upload":      timedelta(minutes=5),
    "video_composition":   timedelta(minutes=20),
    "video_extend":        timedelta(minutes=15),
    "metadata_generation": timedelta(minutes=5),
    "youtube_audio_download": timedelta(minutes=15),
    # Catch-all for any other task_type. Generous so we don't
    # false-positive a slow but legitimate run.
    "_default":            timedelta(minutes=30),
}


async def _maybe_vacuum() -> None:
    """Run `VACUUM` if it hasn't run in the last 30 days. Best-effort."""
    global _last_vacuum_at
    now = datetime.utcnow()
    if _last_vacuum_at is not None and (now - _last_vacuum_at) < _VACUUM_INTERVAL:
        return
    try:
        # VACUUM cannot run inside a transaction, so use a raw connection
        # with autocommit isolation.
        async with engine.connect() as conn:
            await conn.execution_options(isolation_level="AUTOCOMMIT")
            await conn.execute(_sa_text("VACUUM"))
        _last_vacuum_at = now
        logger.info("SQLite VACUUM completed")
    except Exception as exc:
        logger.warning("VACUUM skipped: %s", exc)


async def _maybe_refresh_analytics() -> None:
    """Refresh YouTube analytics for any channel whose last completed
    run was > ``_ANALYTICS_REFRESH_INTERVAL`` ago.

    Only YouTube-connected channels qualify. Each refresh is bounded
    (~10 quota units, < 30s wall time on a healthy connection) so
    running them sequentially in one tick is fine — the tick won't
    drift much even if a few channels need work.

    The refresh service writes its own AnalyticsRunLog row, so this
    function just decides WHO to refresh and orchestrates the calls.
    """
    from app.models import AnalyticsRunLog, Channel
    from sqlalchemy import select as _select, func as _sa_func
    from app.services.analytics_refresh_service import refresh_channel_analytics

    cutoff = datetime.utcnow() - _ANALYTICS_REFRESH_INTERVAL
    async with async_session() as session:
        # Connected channels whose most-recent completed run is
        # missing or older than the cutoff. Also include channels
        # whose last attempt FAILED — we want to retry tomorrow,
        # not give up forever.
        ch_rows = await session.execute(
            _select(Channel.id).where(
                Channel.youtube_credentials_json.isnot(None),
            )
        )
        channel_ids = [r[0] for r in ch_rows.all()]
        if not channel_ids:
            return

        # Compute per-channel max completed_at for "completed" rows.
        last_completed: dict[int, datetime] = {}
        rows = await session.execute(
            _select(
                AnalyticsRunLog.channel_id,
                _sa_func.max(AnalyticsRunLog.completed_at),
            )
            .where(
                AnalyticsRunLog.channel_id.in_(channel_ids),
                AnalyticsRunLog.status == "completed",
            )
            .group_by(AnalyticsRunLog.channel_id)
        )
        for cid, ts in rows.all():
            if ts:
                last_completed[cid] = ts

    due: list[int] = [
        cid for cid in channel_ids
        if last_completed.get(cid) is None or last_completed[cid] < cutoff
    ]
    if not due:
        return

    logger.info(
        "Analytics refresh tick: %d/%d channels due",
        len(due), len(channel_ids),
    )
    for cid in due:
        try:
            result = await refresh_channel_analytics(cid)
            logger.info(
                "Analytics refresh channel=%d → %s (%d videos%s)",
                cid, result["status"], result["videos_processed"],
                " — analytics skipped" if result["analytics_skipped"] else "",
            )
        except Exception:
            # The service catches its own exceptions and logs the
            # failed run; this outer guard exists only so a totally
            # unexpected raise (e.g. DB connection) doesn't kill the
            # whole scheduler tick.
            logger.exception(
                "Unexpected error refreshing analytics for channel %d", cid,
            )
            continue

        # Right after a successful snapshot UPSERT, recompute the
        # channel's title-token bandit. Cheap (one SELECT + N small
        # UPSERTs over a few hundred rows max), and keeps the
        # bandit's classifications in sync with today's data.
        try:
            from app.services.title_bandit_service import recompute_token_stats
            summary = await recompute_token_stats(cid)
            logger.info(
                "Title bandit channel=%d → tokens=%d winners=%d cold=%d",
                cid, summary["tokens_tracked"],
                summary["winners"], summary["cold"],
            )
        except Exception:
            logger.exception(
                "Title bandit recompute failed for channel %d (non-fatal)",
                cid,
            )
        # And the per-track aggregate. Same shape: cheap recompute,
        # walks the channel's projects + latest snapshots and
        # attributes views/retention to each project's first track.
        try:
            from app.services.track_performance_service import (
                recompute_track_stats,
            )
            t_summary = await recompute_track_stats(cid)
            logger.info(
                "Track performance channel=%d → tracks=%d videos=%d",
                cid, t_summary["tracks_tracked"],
                t_summary["videos_attributed"],
            )
        except Exception:
            logger.exception(
                "Track performance recompute failed for channel %d (non-fatal)",
                cid,
            )


async def _sweep_stuck_tasks() -> None:
    """Mark tasks whose ``updated_at`` hasn't moved in a while as
    ``failed``. Cheap on every tick — one ranged SELECT and N small
    UPDATEs (typically zero rows; even a busy backend has only a
    handful of running tasks at any moment).

    The progress callback is the heartbeat: every ``status_message``
    write bumps ``updated_at``. So a task that's truly making forward
    progress will never get reaped. A YouTube upload that stalled at
    8% with no writes for 65 minutes (the case that surfaced this
    helper) gets marked failed within ~6 min and shows up in the
    Failed Tasks panel for one-click retry.

    Important: marking the row failed does NOT cancel the underlying
    Python coroutine — that requires the run_in_executor thread to
    actually finish or be interrupted. The DB row simply goes
    ``failed`` so admission control unblocks. If the in-flight thread
    later succeeds it'll overwrite ``status`` back to ``completed``,
    which is fine — the duplicate-upload guard added separately
    catches the "second copy slipped through" case for YouTube.
    """
    now = datetime.utcnow()
    try:
        async with async_session() as session:
            running = await session.execute(
                select(BackgroundTask).where(
                    BackgroundTask.status == "running",
                )
            )
            for task in running.scalars().all():
                threshold = _STUCK_THRESHOLDS.get(
                    task.task_type, _STUCK_THRESHOLDS["_default"],
                )
                if not task.updated_at:
                    continue
                idle = now - task.updated_at
                if idle < threshold:
                    continue
                logger.warning(
                    "Stuck-task watchdog: marking task %d (%s) as failed "
                    "after %s of silence (threshold %s). Was at %.1f%%: %r",
                    task.id, task.task_type, idle, threshold,
                    task.progress or 0.0, task.status_message,
                )
                task.status = "failed"
                task.error = (
                    f"Marked failed by watchdog: no progress in "
                    f"{int(idle.total_seconds() / 60)} min "
                    f"(threshold {int(threshold.total_seconds() / 60)} min)"
                )
                task.completed_at = now
            await session.commit()
    except Exception:
        logger.exception("stuck-task watchdog tick failed (non-fatal)")


async def _maybe_retention_sweep() -> None:
    """Run a daily task-row prune. File orphans are NOT touched here —
    the admin endpoint still has to be invoked manually for those.

    Cheap on every tick: the helper short-circuits unless the daily
    interval has elapsed since the last successful sweep.
    """
    global _last_retention_at
    now = datetime.utcnow()
    if (
        _last_retention_at is not None
        and (now - _last_retention_at) < _RETENTION_INTERVAL
    ):
        return
    try:
        from app.workers.retention_worker import prune_old_tasks
        counts = await prune_old_tasks(dry_run=False)
        _last_retention_at = now
        logger.info(
            "Daily retention sweep pruned %d tasks: %s",
            sum(counts.values()), counts,
        )
    except Exception as exc:
        logger.warning("Retention sweep skipped: %s", exc)


def compute_next_run(cron_expr: str, tz_name: str = "UTC") -> datetime:
    """Compute the next occurrence from a cron expression, returned as UTC datetime."""
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore[no-redef]

    tz = ZoneInfo(tz_name)
    now_local = datetime.now(tz)
    cron = croniter(cron_expr, now_local)
    next_local = cron.get_next(datetime)
    return next_local.astimezone(timezone.utc).replace(tzinfo=None)


async def automation_scheduler_loop() -> None:
    """Poll every 60 seconds for due automation presets and enqueue them."""
    from app.workers.task_runner import task_runner

    logger.info("Automation scheduler started")
    while True:
        await asyncio.sleep(60)
        try:
            # Cheap on every tick: the helper short-circuits unless the
            # 30-day interval has elapsed.
            await _maybe_vacuum()
        except Exception:
            logger.exception("VACUUM tick failed (non-fatal)")
        try:
            # Cheap on every tick: short-circuits unless 24h have
            # elapsed since the last successful run.
            await _maybe_retention_sweep()
        except Exception:
            logger.exception("Retention sweep tick failed (non-fatal)")
        # Stuck-task watchdog runs every tick. The helper itself is
        # cheap (one SELECT against a tiny "running" set) and the
        # whole point is to react quickly when a task stalls.
        await _sweep_stuck_tasks()
        try:
            # Per-channel analytics refresh — short-circuits unless
            # at least one channel's last successful run is > 20h ago.
            await _maybe_refresh_analytics()
        except Exception:
            logger.exception("Analytics refresh tick failed (non-fatal)")
        try:
            async with async_session() as session:
                now = datetime.utcnow()
                result = await session.execute(
                    select(AutomationPreset).where(
                        AutomationPreset.is_active == True,  # noqa: E712
                        AutomationPreset.next_run_at != None,  # noqa: E711
                        AutomationPreset.next_run_at <= now,
                    )
                )
                due_presets = result.scalars().all()

                for preset in due_presets:
                    # Skip if this channel already has an automation_run
                    # in flight. Two presets on the same channel firing in
                    # the same minute (or a previous run still spinning
                    # because the host was slow) would otherwise stack and
                    # publish duplicates. Cheap query, single row count.
                    in_flight_q = await session.execute(
                        select(BackgroundTask.id).where(
                            BackgroundTask.task_type == "automation_run",
                            BackgroundTask.channel_id == preset.channel_id,
                            BackgroundTask.status.in_(("pending", "running")),
                        ).limit(1)
                    )
                    if in_flight_q.scalar_one_or_none() is not None:
                        logger.info(
                            "Scheduler skipping preset %d (%s) — channel %d "
                            "already has an automation_run pending/running",
                            preset.id, preset.name, preset.channel_id,
                        )
                        # Still advance next_run_at so we don't refire the
                        # same window every minute until the in-flight job
                        # finishes.
                        if preset.schedule_cron:
                            preset.next_run_at = compute_next_run(
                                preset.schedule_cron, preset.schedule_timezone
                            )
                            await session.commit()
                        continue

                    logger.info(
                        "Scheduler triggering automation preset %d (%s)",
                        preset.id,
                        preset.name,
                    )
                    # ``quick=True`` routes the task through the same
                    # ``quick_generate`` code path the dashboard's "Generate
                    # now" button uses. One code path, one bug surface.
                    # ``channel_id`` is included so quick_generate can
                    # resolve the preset's channel without an extra fetch.
                    task = BackgroundTask(
                        task_type="automation_run",
                        status="pending",
                        channel_id=preset.channel_id,
                        result={
                            "preset_id": preset.id,
                            "quick": True,
                            "channel_id": preset.channel_id,
                        },
                    )
                    session.add(task)
                    await session.flush()

                    # Advance next_run_at
                    if preset.schedule_cron:
                        preset.next_run_at = compute_next_run(
                            preset.schedule_cron, preset.schedule_timezone
                        )
                    else:
                        # No cron = one-shot; deactivate after running
                        preset.is_active = False
                        preset.next_run_at = None

                    await session.commit()
                    await task_runner.enqueue(task.id)

        except Exception:
            logger.exception("Automation scheduler error")
