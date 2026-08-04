"""Shared pytest fixtures.

Tests run against an isolated **in-memory SQLite** database — never the
operator's real ``data/studio.db``. This file:

- Patches ``settings.db_path`` and ``settings.assets_dir`` to a temp
  directory before SQLAlchemy is imported anywhere.
- Provides a fresh schema per test via ``async_session`` fixture.
- Pre-builds a ``channel`` + ``preset`` + a couple of ``Asset`` rows so
  individual tests can stay focused on one behavior at a time.
- Provides a ``patched_services`` fixture that replaces the heavy
  external integrations (FFmpeg, Suno, OpenAI, YouTube, Claude) with
  thin stubs so handlers can be exercised without spawning subprocesses
  or hitting the network.
"""
from __future__ import annotations

import asyncio
import json
import os
import tempfile
from pathlib import Path
from typing import AsyncIterator, Iterator
from unittest.mock import AsyncMock, MagicMock

import pytest

# ── Isolation: rewrite settings BEFORE any app module is imported ────
# pytest collects this file before tests; we mutate env vars and the
# settings paths so the rest of the app never sees the operator's
# real data dir.
_TMP_DIR = Path(tempfile.mkdtemp(prefix="ytstudio_tests_"))
os.environ["YTS_DEBUG"] = "false"

# Late-imported on purpose — must happen AFTER env is set.
from app import config as _app_config  # noqa: E402

_app_config.settings.data_dir = _TMP_DIR
_app_config.settings.db_path = _TMP_DIR / "test.db"
_app_config.settings.assets_dir = _TMP_DIR / "assets"
_app_config.settings.key_path = _TMP_DIR / "studio.key"
(_TMP_DIR / "assets").mkdir(parents=True, exist_ok=True)

# Now safe to import the rest.
from app.database import Base, async_session, engine  # noqa: E402
from app.models import (  # noqa: E402
    AppSetting,
    Asset,
    AutomationPreset,
    BackgroundTask,
    Channel,
    VideoProject,
)


@pytest.fixture(scope="session", autouse=True)
def _build_schema() -> Iterator[None]:
    """Create the schema once, drop it at session end."""
    async def _create() -> None:
        async with engine.begin() as conn:
            await conn.run_sync(Base.metadata.create_all)

    asyncio.get_event_loop_policy().get_event_loop().run_until_complete(_create()) \
        if False else asyncio.new_event_loop().run_until_complete(_create())
    yield


@pytest.fixture(autouse=True)
async def _truncate_tables() -> AsyncIterator[None]:
    """Wipe rows + asset files between tests so order doesn't matter.

    Tests that drop files into ``settings.assets_dir/{channel}/...``
    (e.g. the scan-disk and reassign-channel tests) would otherwise
    leave artefacts that the next test counts as "already there",
    breaking ``scanned`` / ``adopted`` assertions.
    """
    yield
    async with async_session() as session:
        for table in reversed(Base.metadata.sorted_tables):
            await session.execute(table.delete())
        await session.commit()

    # Wipe asset files but leave the assets_dir directory itself in place
    # so subsequent tests don't have to mkdir it.
    import shutil
    assets_dir = _app_config.settings.assets_dir
    if assets_dir.exists():
        for entry in assets_dir.iterdir():
            try:
                if entry.is_dir():
                    shutil.rmtree(entry, ignore_errors=True)
                else:
                    entry.unlink()
            except OSError:
                pass


@pytest.fixture
async def db():
    """Hand a fresh AsyncSession to a test."""
    async with async_session() as session:
        yield session


@pytest.fixture
async def channel(db) -> Channel:
    """A minimal Channel row tests can attach things to."""
    ch = Channel(name="Test Channel", niche="lofi")
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return ch


@pytest.fixture
async def preset(db, channel: Channel) -> AutomationPreset:
    """An AutomationPreset wired to ``channel``."""
    p = AutomationPreset(
        channel_id=channel.id,
        name="Test Preset",
        is_active=True,
        is_primary=True,
        music_folder_path="",
        image_folder_path="",
        target_duration_seconds=600,
        audio_extensions=json.dumps(["mp3"]),
        video_style="spectrum",
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p


@pytest.fixture
async def music_assets(db, channel: Channel) -> list[Asset]:
    """Three music Assets in the channel library."""
    rows = []
    for i in range(3):
        a = Asset(
            channel_id=channel.id,
            asset_type="music",
            source="upload",
            filename=f"track_{i}.mp3",
            filepath=f"{channel.id}/music/track_{i}.mp3",
            file_size=1_000_000,
            duration_seconds=180.0,
            mime_type="audio/mpeg",
            title=f"Track {i}",
        )
        db.add(a)
        rows.append(a)
    await db.commit()
    for a in rows:
        await db.refresh(a)
    return rows


@pytest.fixture
async def image_assets(db, channel: Channel) -> list[Asset]:
    """Two image Assets in the channel library."""
    rows = []
    for i in range(2):
        a = Asset(
            channel_id=channel.id,
            asset_type="image",
            source="upload",
            filename=f"img_{i}.png",
            filepath=f"{channel.id}/images/img_{i}.png",
            file_size=500_000,
            mime_type="image/png",
        )
        db.add(a)
        rows.append(a)
    await db.commit()
    for a in rows:
        await db.refresh(a)
    return rows


@pytest.fixture
async def video_project(db, channel: Channel) -> VideoProject:
    """A draft VideoProject for the channel."""
    p = VideoProject(
        channel_id=channel.id,
        title="Test Project",
        status="draft",
    )
    db.add(p)
    await db.commit()
    await db.refresh(p)
    return p


@pytest.fixture
async def background_task(db, channel: Channel) -> BackgroundTask:
    """A pending BackgroundTask wired to ``channel``."""
    t = BackgroundTask(
        task_type="metadata_generation",
        status="pending",
        channel_id=channel.id,
        result={"source": "test"},
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)
    return t


@pytest.fixture
def patched_services(mocker) -> dict:
    """Replace FFmpeg / external APIs with stubs.

    Returns a dict so individual tests can override default behavior::

        async def test_compose(patched_services, ...):
            patched_services["compose"].return_value = {"filepath": ...}
    """
    compose = AsyncMock(return_value={
        "filename": "out.mp4",
        "filepath": "1/composed/out.mp4",
        "file_size": 12345,
        "duration": 60.0,
    })
    extend = AsyncMock(return_value={
        "filename": "extended.mp4",
        "filepath": "1/composed/extended.mp4",
        "file_size": 45678,
        "duration": 600.0,
    })
    youtube_upload = AsyncMock(return_value={
        "video_id": "abc123",
        "url": "https://youtu.be/abc123",
    })
    claude_metadata = AsyncMock(return_value={
        "title": "Generated Title",
        "description": "Generated description.",
        "tags": ["a", "b"],
        "category_id": "10",
    })
    suno_generate = AsyncMock(return_value={
        "title": "Suno Track",
        "duration": 120,
        "temp_filepath": None,
    })

    mocker.patch(
        "app.services.compose_service.compose_service.compose_video",
        new=compose,
    )
    mocker.patch(
        "app.services.compose_service.compose_service.extend_video",
        new=extend,
    )
    mocker.patch(
        "app.services.youtube_service.youtube_service.upload_video",
        new=youtube_upload,
    )
    mocker.patch(
        "app.services.claude_cli_service.claude_cli_service.generate_metadata",
        new=claude_metadata,
    )
    mocker.patch(
        "app.services.suno_service.suno_service.generate",
        new=suno_generate,
    )

    return {
        "compose": compose,
        "extend": extend,
        "youtube_upload": youtube_upload,
        "claude_metadata": claude_metadata,
        "suno_generate": suno_generate,
    }
