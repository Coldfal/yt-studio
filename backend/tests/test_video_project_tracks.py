"""Tests for the VideoProjectTrack m2m table + helpers.

Covers:
- set_project_tracks() writes rows and keeps JSON in sync
- get_project_track_ids() prefers table over JSON, with fallback chain
- CASCADE on project delete removes track rows
- CASCADE on asset delete removes track row, project survives
- Duplicate call to set_project_tracks() replaces rows (idempotent)
"""
from __future__ import annotations

import pytest
from sqlalchemy import select

from app.models import Asset, VideoProject
from app.models.video_project import VideoProjectTrack
from app.services.automation_service._shared import (
    get_project_track_ids,
    set_project_tracks,
)


# ── helpers ───────────────────────────────────────────────────────────────────

async def _make_project(db, channel_id: int, **kwargs) -> VideoProject:
    p = VideoProject(channel_id=channel_id, title="Test", status="draft", **kwargs)
    db.add(p)
    await db.flush()
    return p


async def _make_asset(db, channel_id: int, idx: int = 0) -> Asset:
    a = Asset(
        channel_id=channel_id,
        asset_type="music",
        source="upload",
        filename=f"t{idx}.mp3",
        filepath=f"{channel_id}/music/t{idx}.mp3",
        file_size=100_000,
        duration_seconds=120.0,
        mime_type="audio/mpeg",
        title=f"Track {idx}",
    )
    db.add(a)
    await db.flush()
    return a


# ── set_project_tracks() ──────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_set_project_tracks_creates_rows(db, channel):
    """set_project_tracks inserts one row per asset at the right position."""
    assets = [await _make_asset(db, channel.id, i) for i in range(3)]
    project = await _make_project(db, channel.id)

    await set_project_tracks(db, project.id, [a.id for a in assets])
    await db.commit()

    rows = (
        await db.execute(
            select(VideoProjectTrack)
            .where(VideoProjectTrack.project_id == project.id)
            .order_by(VideoProjectTrack.position)
        )
    ).scalars().all()

    assert len(rows) == 3
    assert [r.asset_id for r in rows] == [a.id for a in assets]
    assert [r.position for r in rows] == [0, 1, 2]


@pytest.mark.asyncio
async def test_set_project_tracks_syncs_json_column(db, channel):
    """set_project_tracks also keeps music_asset_ids JSON in sync."""
    assets = [await _make_asset(db, channel.id, i) for i in range(2)]
    project = await _make_project(db, channel.id)

    await set_project_tracks(db, project.id, [a.id for a in assets])
    await db.commit()
    await db.refresh(project)

    assert project.music_asset_ids == [a.id for a in assets]


@pytest.mark.asyncio
async def test_set_project_tracks_replaces_on_second_call(db, channel):
    """Calling set_project_tracks twice replaces previous rows."""
    a0 = await _make_asset(db, channel.id, 0)
    a1 = await _make_asset(db, channel.id, 1)
    project = await _make_project(db, channel.id)

    await set_project_tracks(db, project.id, [a0.id, a1.id])
    await db.commit()

    # Replace with single track
    await set_project_tracks(db, project.id, [a1.id])
    await db.commit()

    rows = (
        await db.execute(
            select(VideoProjectTrack).where(VideoProjectTrack.project_id == project.id)
        )
    ).scalars().all()

    assert len(rows) == 1
    assert rows[0].asset_id == a1.id
    assert rows[0].position == 0


@pytest.mark.asyncio
async def test_set_project_tracks_empty_list(db, channel):
    """Setting an empty list clears all track rows and sets JSON to []."""
    asset = await _make_asset(db, channel.id)
    project = await _make_project(db, channel.id)

    await set_project_tracks(db, project.id, [asset.id])
    await db.commit()

    await set_project_tracks(db, project.id, [])
    await db.commit()

    rows = (
        await db.execute(
            select(VideoProjectTrack).where(VideoProjectTrack.project_id == project.id)
        )
    ).scalars().all()
    assert rows == []

    await db.refresh(project)
    assert project.music_asset_ids == []


# ── CASCADE behaviours ────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_cascade_delete_project_removes_tracks(db, channel):
    """Deleting a VideoProject removes its VideoProjectTrack rows (CASCADE)."""
    asset = await _make_asset(db, channel.id)
    project = await _make_project(db, channel.id)
    await set_project_tracks(db, project.id, [asset.id])
    await db.commit()

    project_id = project.id
    await db.delete(project)
    await db.commit()

    remaining = (
        await db.execute(
            select(VideoProjectTrack).where(
                VideoProjectTrack.project_id == project_id
            )
        )
    ).scalars().all()
    assert remaining == []


@pytest.mark.asyncio
async def test_cascade_delete_asset_removes_track_row_not_project(db, channel):
    """Deleting an Asset removes its track row but leaves the project intact."""
    a0 = await _make_asset(db, channel.id, 0)
    a1 = await _make_asset(db, channel.id, 1)
    project = await _make_project(db, channel.id)
    await set_project_tracks(db, project.id, [a0.id, a1.id])
    await db.commit()

    # Delete the first asset
    await db.delete(a0)
    await db.commit()

    # Project still exists
    reloaded = await db.get(VideoProject, project.id)
    assert reloaded is not None

    # Only the track row for a0 is gone
    rows = (
        await db.execute(
            select(VideoProjectTrack)
            .where(VideoProjectTrack.project_id == project.id)
            .order_by(VideoProjectTrack.position)
        )
    ).scalars().all()
    assert len(rows) == 1
    assert rows[0].asset_id == a1.id


# ── get_project_track_ids() ───────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_track_ids_from_m2m_table(db, channel):
    """Returns ordered IDs from the m2m table when rows are present."""
    assets = [await _make_asset(db, channel.id, i) for i in range(3)]
    project = await _make_project(db, channel.id)
    await set_project_tracks(db, project.id, [a.id for a in assets])
    await db.commit()

    ids = await get_project_track_ids(db, project)
    assert ids == [a.id for a in assets]


@pytest.mark.asyncio
async def test_get_track_ids_json_fallback(db, channel):
    """Falls back to music_asset_ids JSON when no m2m rows exist."""
    assets = [await _make_asset(db, channel.id, i) for i in range(2)]
    # Set JSON column manually, skip writing to the table
    project = await _make_project(
        db, channel.id, music_asset_ids=[a.id for a in assets]
    )
    await db.commit()

    ids = await get_project_track_ids(db, project)
    assert ids == [a.id for a in assets]


@pytest.mark.asyncio
async def test_get_track_ids_single_fk_fallback(db, channel):
    """Falls back to legacy music_asset_id FK when neither table nor JSON exist."""
    asset = await _make_asset(db, channel.id)
    project = await _make_project(db, channel.id, music_asset_id=asset.id)
    await db.commit()

    ids = await get_project_track_ids(db, project)
    assert ids == [asset.id]


@pytest.mark.asyncio
async def test_get_track_ids_empty_when_nothing_set(db, channel):
    """Returns [] when there is no track data anywhere."""
    project = await _make_project(db, channel.id)
    await db.commit()

    ids = await get_project_track_ids(db, project)
    assert ids == []


@pytest.mark.asyncio
async def test_m2m_table_takes_precedence_over_json(db, channel):
    """m2m rows win over a stale JSON column (CASCADE pruning scenario)."""
    a0 = await _make_asset(db, channel.id, 0)
    a1 = await _make_asset(db, channel.id, 1)
    project = await _make_project(db, channel.id)
    await set_project_tracks(db, project.id, [a0.id, a1.id])
    await db.commit()

    # Artificially corrupt the JSON column with a stale extra ID
    project.music_asset_ids = [a0.id, a1.id, 99999]
    await db.commit()

    # get_project_track_ids should still return only the m2m rows
    ids = await get_project_track_ids(db, project)
    assert ids == [a0.id, a1.id]
