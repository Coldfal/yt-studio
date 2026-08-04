"""Stats endpoint smoke tests."""
from __future__ import annotations

from datetime import datetime, timedelta

import pytest

from app.api.stats import channel_stats, recent_failed_tasks
from app.models import BackgroundTask, VideoProject


pytestmark = pytest.mark.asyncio


async def test_channel_stats_returns_one_row_per_channel(db, channel):
    rows = await channel_stats(db=db)
    assert len(rows) == 1
    assert rows[0]["channel_id"] == channel.id
    assert rows[0]["channel_name"] == channel.name


async def test_channel_stats_counts_tasks_today(db, channel):
    # Inject one of each status, all created today.
    for status in ("completed", "completed", "failed", "running", "pending"):
        db.add(BackgroundTask(
            task_type="metadata_generation",
            status=status,
            channel_id=channel.id,
        ))
    await db.commit()

    rows = await channel_stats(db=db)
    counts = rows[0]["tasks_today"]
    assert counts["completed"] == 2
    assert counts["failed"] == 1
    assert counts["running"] == 1
    assert counts["pending"] == 1


async def test_channel_stats_reports_last_upload(db, channel):
    when = datetime.utcnow() - timedelta(hours=2)
    db.add(VideoProject(
        channel_id=channel.id,
        title="Published",
        youtube_video_id="abc",
        uploaded_at=when,
    ))
    # An older one — must be ignored in favor of the recent one.
    db.add(VideoProject(
        channel_id=channel.id,
        title="Older",
        youtube_video_id="def",
        uploaded_at=when - timedelta(days=3),
    ))
    await db.commit()

    rows = await channel_stats(db=db)
    assert rows[0]["last_upload_at"] is not None
    # ISO string starts with the year+month+day of `when`.
    assert rows[0]["last_upload_at"].startswith(when.strftime("%Y-%m-%dT%H"))


async def test_failed_tasks_endpoint_returns_recent_failures(db, channel):
    db.add(BackgroundTask(
        task_type="youtube_upload",
        status="failed",
        channel_id=channel.id,
        error="quota exceeded",
        completed_at=datetime.utcnow() - timedelta(hours=1),
    ))
    db.add(BackgroundTask(
        task_type="metadata_generation",
        status="failed",
        channel_id=channel.id,
        error="claude timeout",
        completed_at=datetime.utcnow() - timedelta(hours=2),
    ))
    # Successful task — must be filtered out.
    db.add(BackgroundTask(
        task_type="metadata_generation",
        status="completed",
        channel_id=channel.id,
    ))
    await db.commit()

    rows = await recent_failed_tasks(days=7, limit=50, db=db)
    assert len(rows) == 2
    errors = {r["error"] for r in rows}
    assert errors == {"quota exceeded", "claude timeout"}


async def test_failed_tasks_endpoint_filters_by_window(db, channel):
    # Older than the window — must be excluded.
    db.add(BackgroundTask(
        task_type="youtube_upload",
        status="failed",
        channel_id=channel.id,
        error="ancient",
        created_at=datetime.utcnow() - timedelta(days=30),
        completed_at=datetime.utcnow() - timedelta(days=30),
    ))
    await db.commit()

    rows = await recent_failed_tasks(days=7, limit=50, db=db)
    assert rows == []
