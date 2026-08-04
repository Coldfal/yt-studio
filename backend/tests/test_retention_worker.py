"""Tests for the Phase 3 retention worker.

Pins the basic invariants:
- Old completed/cancelled tasks get pruned past the short window.
- Old failed tasks get pruned past the longer window.
- Recent tasks are kept regardless of status.
- ``dry_run=True`` doesn't mutate.
- Orphan-file detection finds files without matching Asset rows.
"""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.config import settings
from app.models import Asset, BackgroundTask
from app.workers.retention_worker import (
    delete_orphaned_files,
    find_orphaned_files,
    prune_old_tasks,
)


pytestmark = pytest.mark.asyncio


async def test_prune_keeps_recent_tasks_regardless_of_status(db, channel):
    now = datetime.utcnow()
    # Recent in every status — none should get pruned.
    for status in ("completed", "failed", "cancelled", "running", "pending"):
        db.add(BackgroundTask(
            task_type="metadata_generation",
            status=status,
            channel_id=channel.id,
            completed_at=now - timedelta(days=1),
        ))
    await db.commit()

    counts = await prune_old_tasks()
    assert counts == {"completed": 0, "failed": 0, "cancelled": 0}


async def test_prune_drops_old_completed_and_cancelled(db, channel):
    # Old enough to be expired (default 30-day completed retention).
    old_when = datetime.utcnow() - timedelta(days=45)
    for status in ("completed", "cancelled"):
        db.add(BackgroundTask(
            task_type="metadata_generation",
            status=status,
            channel_id=channel.id,
            completed_at=old_when,
        ))
    # And one old failed row — but 45d isn't past the 90d failed retention,
    # so it should NOT be pruned.
    db.add(BackgroundTask(
        task_type="youtube_upload",
        status="failed",
        channel_id=channel.id,
        completed_at=old_when,
    ))
    await db.commit()

    counts = await prune_old_tasks()
    assert counts["completed"] == 1
    assert counts["cancelled"] == 1
    assert counts["failed"] == 0  # 45d < 90d retention


async def test_prune_drops_very_old_failed(db, channel):
    very_old = datetime.utcnow() - timedelta(days=120)
    db.add(BackgroundTask(
        task_type="youtube_upload",
        status="failed",
        channel_id=channel.id,
        completed_at=very_old,
    ))
    await db.commit()

    counts = await prune_old_tasks()
    assert counts["failed"] == 1


async def test_prune_dry_run_does_not_mutate(db, channel):
    old_when = datetime.utcnow() - timedelta(days=45)
    db.add(BackgroundTask(
        task_type="metadata_generation",
        status="completed",
        channel_id=channel.id,
        completed_at=old_when,
    ))
    await db.commit()

    counts = await prune_old_tasks(dry_run=True)
    assert counts["completed"] == 1

    # Row still there.
    from sqlalchemy import select, func
    total = (await db.execute(select(func.count(BackgroundTask.id)))).scalar_one()
    assert total == 1


async def test_find_orphans_returns_files_without_asset_row(db, channel):
    # Real Asset row + matching file — should be excluded from orphans.
    real_path = settings.assets_dir / f"{channel.id}/composed/real.mp4"
    real_path.parent.mkdir(parents=True, exist_ok=True)
    real_path.write_bytes(b"video bytes")
    db.add(Asset(
        channel_id=channel.id,
        asset_type="composed",
        source="composed",
        filename="real.mp4",
        filepath=f"{channel.id}/composed/real.mp4",
        file_size=len(b"video bytes"),
        mime_type="video/mp4",
    ))
    await db.commit()

    # Orphan file — no matching Asset row.
    orphan_path = settings.assets_dir / f"{channel.id}/composed/orphan.mp4"
    orphan_path.write_bytes(b"orphaned bytes")

    orphans = await find_orphaned_files(asset_type="composed")
    paths = {o["path"] for o in orphans}
    assert f"{channel.id}/composed/orphan.mp4" in paths
    assert f"{channel.id}/composed/real.mp4" not in paths


async def test_delete_orphans_removes_files(db, channel):
    p = settings.assets_dir / f"{channel.id}/composed/to_delete.mp4"
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(b"goodbye")
    assert p.exists()

    result = await delete_orphaned_files([
        {"path": f"{channel.id}/composed/to_delete.mp4", "size_bytes": 7},
    ])
    assert result["deleted"] == 1
    assert result["freed_bytes"] == 7
    assert result["errors"] == 0
    assert not p.exists()


async def test_delete_orphans_handles_missing_files_gracefully(db, channel):
    # File doesn't exist — shouldn't raise, just count zero.
    result = await delete_orphaned_files([
        {"path": f"{channel.id}/composed/never_existed.mp4", "size_bytes": 100},
    ])
    assert result["deleted"] == 0
    assert result["freed_bytes"] == 0
    assert result["errors"] == 0
