"""Tests for the ``file_exists`` field on AssetResponse.

The Library surfaces missing-file rows in the UI so the user can review
them before a render fails. Computed on every list/get response by
checking the actual filesystem (no DB column).
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient

from app.config import settings
from app.main import app
from app.models import Asset, Channel


async def _make_asset_with_file(db, channel: Channel, idx: int = 0) -> Asset:
    """Create an Asset row + write the file on disk."""
    a = Asset(
        channel_id=channel.id,
        asset_type="music",
        source="upload",
        filename=f"f{idx}.mp3",
        filepath=f"{channel.id}/music/f{idx}.mp3",
        file_size=1000,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)

    abs_path = settings.assets_dir / a.filepath
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(b"fake mp3 contents")
    return a


async def _make_asset_without_file(db, channel: Channel, idx: int = 99) -> Asset:
    """Create an Asset row whose filepath does NOT exist on disk."""
    a = Asset(
        channel_id=channel.id,
        asset_type="music",
        source="upload",
        filename=f"orphan{idx}.mp3",
        filepath=f"{channel.id}/music/orphan{idx}.mp3",
        file_size=1000,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return a  # No file written


@pytest.mark.asyncio
async def test_list_assets_marks_existing_files_true(db, channel: Channel):
    """Files on disk → file_exists=True."""
    await _make_asset_with_file(db, channel, idx=1)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(f"/api/assets/?channel_id={channel.id}")

    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["file_exists"] is True


@pytest.mark.asyncio
async def test_list_assets_marks_missing_files_false(db, channel: Channel):
    """Row pointing at non-existent file → file_exists=False."""
    await _make_asset_without_file(db, channel, idx=1)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(f"/api/assets/?channel_id={channel.id}")

    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 1
    assert rows[0]["file_exists"] is False


@pytest.mark.asyncio
async def test_list_assets_mixed_files(db, channel: Channel):
    """Mixed bag — true for present files, false for orphans."""
    await _make_asset_with_file(db, channel, idx=10)
    await _make_asset_with_file(db, channel, idx=11)
    await _make_asset_without_file(db, channel, idx=12)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(f"/api/assets/?channel_id={channel.id}")

    assert resp.status_code == 200
    rows = resp.json()
    assert len(rows) == 3
    by_filename = {r["filename"]: r["file_exists"] for r in rows}
    assert by_filename["f10.mp3"] is True
    assert by_filename["f11.mp3"] is True
    assert by_filename["orphan12.mp3"] is False


@pytest.mark.asyncio
async def test_get_single_asset_includes_file_exists(db, channel: Channel):
    """GET /assets/{id} response includes the field too."""
    asset = await _make_asset_without_file(db, channel, idx=20)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(f"/api/assets/{asset.id}")

    assert resp.status_code == 200
    assert resp.json()["file_exists"] is False


@pytest.mark.asyncio
async def test_file_exists_flips_when_file_deleted(db, channel: Channel, tmp_path):
    """Existence is recomputed on every response, not cached."""
    asset = await _make_asset_with_file(db, channel, idx=30)

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        first = await ac.get(f"/api/assets/{asset.id}")
        assert first.json()["file_exists"] is True

        # Delete the file out from under it
        (settings.assets_dir / asset.filepath).unlink()

        second = await ac.get(f"/api/assets/{asset.id}")
        assert second.json()["file_exists"] is False
