"""Tests for the per-channel folder model.

Covers the invariants that make the channel-first Library safe:
- Folder rows MUST have a channel_id (NOT NULL).
- Folder names are unique per (channel_id, asset_type).
- Move-to-folder rejects asset/folder channel mismatches.
- Move-to-folder rejects asset/folder asset_type mismatches.
- Reassigning an asset across channels strips its folder_id.
"""
from __future__ import annotations

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.main import app
from app.models import Asset, Channel
from app.models.asset import AssetFolder


# ── Helpers ──────────────────────────────────────────────────────────────────


async def _make_channel(db, name: str = "Test") -> Channel:
    ch = Channel(name=name, niche="lofi")
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return ch


async def _make_folder(
    db, channel_id: int, asset_type: str = "music", name: str = "Lofi",
) -> AssetFolder:
    f = AssetFolder(channel_id=channel_id, asset_type=asset_type, name=name)
    db.add(f)
    await db.commit()
    await db.refresh(f)
    return f


async def _make_asset(
    db, channel_id: int, asset_type: str = "music", folder_id: int | None = None,
    idx: int = 0,
) -> Asset:
    a = Asset(
        channel_id=channel_id,
        asset_type=asset_type,
        source="upload",
        filename=f"f{idx}.mp3",
        filepath=f"{channel_id}/{asset_type}/f{idx}.mp3",
        file_size=1000,
        folder_id=folder_id,
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return a


# ── Model invariants ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_folder_requires_channel_id(db, channel: Channel):
    """A folder created without channel_id raises IntegrityError on commit."""
    f = AssetFolder(asset_type="music", name="Orphan")  # no channel_id
    db.add(f)
    with pytest.raises(IntegrityError):
        await db.commit()


@pytest.mark.asyncio
async def test_folder_uniqueness_within_channel_type(db, channel: Channel):
    """(channel_id, asset_type, name) must be unique."""
    await _make_folder(db, channel.id, "music", "Lofi")
    with pytest.raises(IntegrityError):
        await _make_folder(db, channel.id, "music", "Lofi")


@pytest.mark.asyncio
async def test_folder_same_name_allowed_across_channels(db):
    """YomiBeats's 'Lofi' and ZenTaoSounds's 'Lofi' are separate rows."""
    yomi = await _make_channel(db, "YomiBeats")
    zen = await _make_channel(db, "ZenTaoSounds")
    f1 = await _make_folder(db, yomi.id, "music", "Lofi")
    f2 = await _make_folder(db, zen.id, "music", "Lofi")
    assert f1.id != f2.id
    assert f1.channel_id == yomi.id
    assert f2.channel_id == zen.id


@pytest.mark.asyncio
async def test_folder_same_name_allowed_across_types(db, channel: Channel):
    """Music/Lofi and Image/Lofi within one channel are separate rows."""
    f1 = await _make_folder(db, channel.id, "music", "Lofi")
    f2 = await _make_folder(db, channel.id, "image", "Lofi")
    assert f1.id != f2.id
    assert f1.asset_type == "music"
    assert f2.asset_type == "image"


@pytest.mark.asyncio
async def test_folder_cascades_when_channel_deleted(db, channel: Channel):
    """Deleting a channel removes its folders (and assets via existing CASCADE)."""
    f = await _make_folder(db, channel.id, "music", "Lofi")
    folder_id = f.id
    await db.delete(channel)
    await db.commit()

    # New session to dodge identity-map cache
    from app.database import async_session
    async with async_session() as fresh:
        remaining = (
            await fresh.execute(
                select(AssetFolder).where(AssetFolder.id == folder_id)
            )
        ).scalar_one_or_none()
    assert remaining is None


# ── /api/assets/move endpoint invariants ─────────────────────────────────────


@pytest.mark.asyncio
async def test_move_rejects_cross_channel(db):
    """Moving an asset into a folder from a DIFFERENT channel fails 400."""
    yomi = await _make_channel(db, "YomiBeats")
    zen = await _make_channel(db, "ZenTaoSounds")
    asset = await _make_asset(db, yomi.id, "music")
    folder = await _make_folder(db, zen.id, "music", "Lofi")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.put(
            "/api/assets/move",
            json={"asset_ids": [asset.id], "folder_id": folder.id},
        )
    assert resp.status_code == 400
    assert "channel" in resp.json()["detail"].lower()

    # Asset's folder_id must NOT have been written
    await db.refresh(asset)
    assert asset.folder_id is None


@pytest.mark.asyncio
async def test_move_rejects_type_mismatch(db, channel: Channel):
    """Moving a music asset into an image folder fails 400."""
    asset = await _make_asset(db, channel.id, "music")
    folder = await _make_folder(db, channel.id, "image", "Backgrounds")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.put(
            "/api/assets/move",
            json={"asset_ids": [asset.id], "folder_id": folder.id},
        )
    assert resp.status_code == 400


@pytest.mark.asyncio
async def test_move_within_same_channel_succeeds(db, channel: Channel):
    """Same channel, same asset_type → moves cleanly."""
    asset = await _make_asset(db, channel.id, "music")
    folder = await _make_folder(db, channel.id, "music", "Lofi")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.put(
            "/api/assets/move",
            json={"asset_ids": [asset.id], "folder_id": folder.id},
        )
    assert resp.status_code == 200

    from app.database import async_session
    async with async_session() as fresh:
        a = await fresh.get(Asset, asset.id)
        assert a.folder_id == folder.id


# ── /api/assets/reassign-channel strips folder_id ────────────────────────────


@pytest.mark.asyncio
async def test_reassign_channel_strips_folder(db, tmp_path, monkeypatch):
    """An asset's folder_id is cleared when its channel changes."""
    yomi = await _make_channel(db, "YomiBeats")
    zen = await _make_channel(db, "ZenTaoSounds")
    folder = await _make_folder(db, yomi.id, "music", "Lofi")
    asset = await _make_asset(db, yomi.id, "music", folder_id=folder.id)

    # The endpoint moves files on disk — make sure the source dir + file
    # exist so the move call doesn't fail outright.
    from app.config import settings
    src_abs = settings.assets_dir / asset.filepath
    src_abs.parent.mkdir(parents=True, exist_ok=True)
    src_abs.write_bytes(b"fake mp3")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.put(
            "/api/assets/reassign-channel",
            json={"asset_ids": [asset.id], "channel_id": zen.id},
        )
    assert resp.status_code == 200

    from app.database import async_session
    async with async_session() as fresh:
        a = await fresh.get(Asset, asset.id)
        assert a.channel_id == zen.id
        assert a.folder_id is None  # stripped

    # The original folder still exists on the OLD channel — only the
    # asset's link to it was severed.
    async with async_session() as fresh:
        f = await fresh.get(AssetFolder, folder.id)
        assert f is not None
        assert f.channel_id == yomi.id


# ── /api/assets/folders POST validates channel_id ────────────────────────────


@pytest.mark.asyncio
async def test_create_folder_requires_channel_id(db, channel: Channel):
    """POST /folders without channel_id returns 400."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/folders",
            json={"asset_type": "music", "name": "Lofi"},
        )
    assert resp.status_code == 400
    assert "channel_id" in resp.json()["detail"]


@pytest.mark.asyncio
async def test_create_folder_rejects_unknown_channel(db):
    """POST /folders with bogus channel_id returns 404."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/folders",
            json={"channel_id": 99999, "asset_type": "music", "name": "Lofi"},
        )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_create_folder_rejects_duplicate(db, channel: Channel):
    """POST /folders with an existing (channel, type, name) returns 409."""
    await _make_folder(db, channel.id, "music", "Lofi")
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post(
            "/api/assets/folders",
            json={
                "channel_id": channel.id, "asset_type": "music", "name": "Lofi",
            },
        )
    assert resp.status_code == 409


@pytest.mark.asyncio
async def test_list_folders_filters_by_channel(db):
    """GET /folders?channel_id=N returns only that channel's folders."""
    yomi = await _make_channel(db, "YomiBeats")
    zen = await _make_channel(db, "ZenTaoSounds")
    await _make_folder(db, yomi.id, "music", "YomiLofi")
    await _make_folder(db, zen.id, "music", "ZenLofi")
    await _make_folder(db, zen.id, "image", "ZenBackgrounds")

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(f"/api/assets/folders?channel_id={zen.id}")
    assert resp.status_code == 200
    names = sorted(f["name"] for f in resp.json())
    assert names == ["ZenBackgrounds", "ZenLofi"]
