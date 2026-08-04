"""Tests for the ``POST /api/assets/scan-disk`` endpoint.

The inverse of reconcile: this one creates Asset rows for files that
exist on disk but don't have a DB row yet (e.g. user drops mp3s into
``data/assets/2/music/`` via Windows Explorer).

Mocks ``get_audio_duration`` so tests don't need a real ffprobe binary
or real audio files.
"""
from __future__ import annotations

from unittest.mock import patch

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.config import settings
from app.main import app
from app.models import Asset, Channel


def _write(channel_id: int, type_name: str, filename: str, content: bytes = b"x") -> str:
    """Create a real file in the channel's asset folder. Returns its
    relative path (same shape as Asset.filepath)."""
    folder = settings.assets_dir / str(channel_id) / type_name
    folder.mkdir(parents=True, exist_ok=True)
    path = folder / filename
    path.write_bytes(content)
    return f"{channel_id}/{type_name}/{filename}"


# ── Validation ───────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scan_disk_requires_channel_id(db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post("/api/assets/scan-disk")
    assert resp.status_code == 400
    assert "channel_id" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_scan_disk_unknown_channel_404(db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/scan-disk", params={"channel_id": 99999},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_scan_disk_rejects_unsupported_asset_type(db, channel: Channel):
    """asset_type=composed isn't allowed (composed is engine-produced)."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/scan-disk",
            params={"channel_id": channel.id, "asset_type": "composed"},
        )
    assert resp.status_code == 400


# ── Adoption: empty + happy paths ────────────────────────────────────────────


@pytest.mark.asyncio
async def test_scan_disk_empty_folder_zero_adopted(db, channel: Channel):
    """No files on disk → 0 adopted, 0 scanned."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/scan-disk",
            params={"channel_id": channel.id, "asset_type": "music"},
        )
    assert resp.status_code == 200
    assert resp.json() == {
        "scanned": 0,
        "adopted": 0,
        "skipped_existing": 0,
        "skipped_unsupported": 0,
        "adopted_ids": [],
    }


@pytest.mark.asyncio
async def test_scan_disk_adopts_unreferenced_audio(db, channel: Channel):
    """An mp3 dropped manually into the music folder gets a row + duration."""
    _write(channel.id, "music", "manual_drop.mp3")

    with patch(
        "app.utils.audio.get_audio_duration", return_value=180.5,
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.post(
                "/api/assets/scan-disk",
                params={"channel_id": channel.id, "asset_type": "music"},
            )

    assert resp.status_code == 200
    body = resp.json()
    assert body["scanned"] == 1
    assert body["adopted"] == 1
    assert len(body["adopted_ids"]) == 1

    # Verify the row landed correctly
    from app.database import async_session
    async with async_session() as fresh:
        row = await fresh.get(Asset, body["adopted_ids"][0])
        assert row is not None
        assert row.channel_id == channel.id
        assert row.asset_type == "music"
        assert row.filename == "manual_drop.mp3"
        assert row.filepath == f"{channel.id}/music/manual_drop.mp3"
        assert row.source == "manual"
        assert row.duration_seconds == 180.5
        assert row.file_size and row.file_size > 0
        assert row.folder_id is None


@pytest.mark.asyncio
async def test_scan_disk_skips_existing_rows(db, channel: Channel):
    """Files that already have a row aren't re-adopted (idempotent)."""
    rel = _write(channel.id, "music", "already_known.mp3")
    db.add(
        Asset(
            channel_id=channel.id,
            asset_type="music",
            source="upload",
            filename="already_known.mp3",
            filepath=rel,
            file_size=100,
        )
    )
    await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/scan-disk",
            params={"channel_id": channel.id, "asset_type": "music"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["scanned"] == 1
    assert body["adopted"] == 0
    assert body["skipped_existing"] == 1


@pytest.mark.asyncio
async def test_scan_disk_skips_wrong_extensions(db, channel: Channel):
    """A .txt file in the music folder is NOT adopted."""
    _write(channel.id, "music", "readme.txt", b"notes")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/scan-disk",
            params={"channel_id": channel.id, "asset_type": "music"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["scanned"] == 1
    assert body["adopted"] == 0
    assert body["skipped_unsupported"] == 1


@pytest.mark.asyncio
async def test_scan_disk_handles_image_folder(db, channel: Channel):
    """PNG dropped in image folder gets a row with image asset_type."""
    _write(channel.id, "image", "bg.png")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/scan-disk",
            params={"channel_id": channel.id, "asset_type": "image"},
        )
    assert resp.status_code == 200
    body = resp.json()
    assert body["adopted"] == 1
    from app.database import async_session
    async with async_session() as fresh:
        row = await fresh.get(Asset, body["adopted_ids"][0])
        assert row.asset_type == "image"
        assert row.filename == "bg.png"
        assert row.duration_seconds is None  # images have no duration


@pytest.mark.asyncio
async def test_scan_disk_no_asset_type_scans_all(db, channel: Channel):
    """Without asset_type, scan-disk walks every supported type folder."""
    _write(channel.id, "music", "song.mp3")
    _write(channel.id, "image", "pic.png")

    with patch(
        "app.utils.audio.get_audio_duration", return_value=60.0,
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.post(
                "/api/assets/scan-disk",
                params={"channel_id": channel.id},
            )
    assert resp.status_code == 200
    body = resp.json()
    assert body["adopted"] == 2  # one music, one image

    # Verify both made it in
    from app.database import async_session
    async with async_session() as fresh:
        rows = (
            await fresh.execute(
                select(Asset).where(Asset.channel_id == channel.id)
            )
        ).scalars().all()
        types = sorted(r.asset_type for r in rows)
        assert types == ["image", "music"]


@pytest.mark.asyncio
async def test_scan_disk_idempotent(db, channel: Channel):
    """Running twice in a row only adopts on the first call."""
    _write(channel.id, "music", "track.mp3")

    transport = ASGITransport(app=app)
    with patch(
        "app.utils.audio.get_audio_duration", return_value=60.0,
    ):
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            first = await ac.post(
                "/api/assets/scan-disk",
                params={"channel_id": channel.id, "asset_type": "music"},
            )
            second = await ac.post(
                "/api/assets/scan-disk",
                params={"channel_id": channel.id, "asset_type": "music"},
            )

    assert first.json()["adopted"] == 1
    assert second.json()["adopted"] == 0
    assert second.json()["skipped_existing"] == 1
