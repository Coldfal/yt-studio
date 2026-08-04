"""Retention sweeps for the BackgroundTask + asset tables.

The plan calls for two layered cleanups, both running daily off the
existing ``automation_scheduler`` loop:

1. **Old-task pruning**: ``BackgroundTask`` rows older than
   ``RETENTION_DAYS`` whose status is ``completed`` or ``cancelled``
   get hard-deleted. Failed rows are kept longer (the dashboard
   ``FailedTasksPanel`` only looks back 7 days, so older failures
   are pure noise — but we keep them around 30 days so the operator
   can still review historical regressions).

2. **Orphaned asset files**: composed-video files in
   ``data/assets/{channel_id}/composed/`` whose backing ``Asset``
   row has been deleted. Surfaces leaks from manual deletes that
   skipped the API.

Both are **best-effort** and **disabled by default** — wired up so a
future scheduler tick can call them, but not yet live in
``automation_scheduler_loop``. That's intentional: this is the kind
of code that wants a manual smoke test on a real DB before being
turned loose on a 60s tick. The corresponding admin endpoint
``POST /api/admin/retention/run`` lets the operator dry-run / trigger
manually first.
"""
from __future__ import annotations

import logging
from datetime import datetime, timedelta
from pathlib import Path
from typing import Any

from sqlalchemy import and_, delete, select

from app.config import settings
from app.database import async_session
from app.models import Asset, BackgroundTask

logger = logging.getLogger(__name__)


# Default retention windows. Generous on purpose — disk is cheap;
# context for "what failed last month" is not. Tweak via the
# kwargs on the public functions if you want a tighter sweep.
COMPLETED_TASK_RETENTION_DAYS = 30
FAILED_TASK_RETENTION_DAYS = 90


async def prune_old_tasks(
    *,
    completed_days: int = COMPLETED_TASK_RETENTION_DAYS,
    failed_days: int = FAILED_TASK_RETENTION_DAYS,
    dry_run: bool = False,
) -> dict[str, int]:
    """Delete ``BackgroundTask`` rows older than the retention window.

    Returns counts: ``{"completed": N, "failed": M, "cancelled": K}``.
    When ``dry_run=True`` the rows are counted but not deleted — useful
    for the admin endpoint to show the operator what the next run
    would do.
    """
    now = datetime.utcnow()
    completed_cutoff = now - timedelta(days=completed_days)
    failed_cutoff = now - timedelta(days=failed_days)

    counts: dict[str, int] = {"completed": 0, "failed": 0, "cancelled": 0}

    async with async_session() as session:
        # Successful + cancelled rows: short retention.
        for status, label in (("completed", "completed"), ("cancelled", "cancelled")):
            count_q = select(BackgroundTask).where(
                and_(
                    BackgroundTask.status == status,
                    BackgroundTask.completed_at.is_not(None),
                    BackgroundTask.completed_at < completed_cutoff,
                )
            )
            rows = (await session.execute(count_q)).scalars().all()
            counts[label] = len(rows)
            if rows and not dry_run:
                ids = [r.id for r in rows]
                await session.execute(
                    delete(BackgroundTask).where(BackgroundTask.id.in_(ids))
                )

        # Failed rows: longer retention so the operator can still
        # diagnose old issues if they recur.
        failed_q = select(BackgroundTask).where(
            and_(
                BackgroundTask.status == "failed",
                BackgroundTask.completed_at.is_not(None),
                BackgroundTask.completed_at < failed_cutoff,
            )
        )
        rows = (await session.execute(failed_q)).scalars().all()
        counts["failed"] = len(rows)
        if rows and not dry_run:
            ids = [r.id for r in rows]
            await session.execute(
                delete(BackgroundTask).where(BackgroundTask.id.in_(ids))
            )

        if not dry_run:
            await session.commit()

    total = sum(counts.values())
    if dry_run:
        logger.info(
            "Retention dry-run would prune %d task rows: %s", total, counts
        )
    else:
        logger.info(
            "Retention pruned %d task rows: %s", total, counts
        )
    return counts


async def find_orphaned_files(
    *,
    asset_type: str = "composed",
) -> list[dict[str, Any]]:
    """Find files on disk under ``data/assets/{channel}/{asset_type}/``
    that have no matching ``Asset`` row.

    Returns a list of ``{"path": str, "size_bytes": int}`` so the
    admin endpoint can preview before the operator confirms deletion.
    Never deletes anything itself — the caller passes the list to
    ``delete_orphaned_files`` to actually act.
    """
    async with async_session() as session:
        rows = (
            await session.execute(
                select(Asset.filepath).where(Asset.asset_type == asset_type)
            )
        ).all()
    known = {r[0] for r in rows if r[0]}

    orphans: list[dict[str, Any]] = []
    base = Path(settings.assets_dir)
    if not base.exists():
        return orphans

    # Walk channel dirs, then the type subdir.
    for channel_dir in base.iterdir():
        if not channel_dir.is_dir():
            continue
        type_dir = channel_dir / asset_type
        if not type_dir.exists():
            continue
        for f in type_dir.iterdir():
            if not f.is_file():
                continue
            rel = f.relative_to(base).as_posix()
            if rel in known:
                continue
            try:
                size = f.stat().st_size
            except OSError:
                size = 0
            orphans.append({"path": rel, "size_bytes": size})
    return orphans


async def delete_orphaned_files(orphans: list[dict[str, Any]]) -> dict[str, int]:
    """Delete the files surfaced by ``find_orphaned_files``. Returns
    ``{"deleted": N, "freed_bytes": M, "errors": K}``."""
    deleted = 0
    freed = 0
    errors = 0
    base = Path(settings.assets_dir)
    for entry in orphans:
        p = base / entry["path"]
        try:
            if p.exists():
                p.unlink()
                deleted += 1
                freed += int(entry.get("size_bytes") or 0)
        except OSError:
            errors += 1
            logger.warning("Failed to delete orphan %s", p, exc_info=True)
    logger.info(
        "Orphan sweep deleted %d files (%d bytes), %d errors",
        deleted, freed, errors,
    )
    return {"deleted": deleted, "freed_bytes": freed, "errors": errors}
