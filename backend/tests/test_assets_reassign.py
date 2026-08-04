"""Tests for ``PUT /api/assets/reassign-channel``.

Pins the bug-fix from the demoaudio cleanup: there used to be no UI
or API to reassign an Asset to a different channel, so when the
YouTube download flow tagged 19 tracks with the wrong channel, the
operator had to delete + re-upload. The endpoint now moves the file
on disk + updates the row.
"""
from __future__ import annotations

import pytest

from app.config import settings
from app.api.assets import reassign_assets_channel
from app.models import Asset, Channel


pytestmark = pytest.mark.asyncio


async def _make_target_channel(db) -> Channel:
    ch = Channel(name="Other Channel", niche="ambient")
    db.add(ch)
    await db.commit()
    await db.refresh(ch)
    return ch


async def _make_asset_with_file(db, channel: Channel, name: str = "track.mp3") -> Asset:
    """Create an Asset row + matching file on disk under the test tmp dir."""
    rel = f"{channel.id}/music/{name}"
    abs_path = settings.assets_dir / rel
    abs_path.parent.mkdir(parents=True, exist_ok=True)
    abs_path.write_bytes(b"fake mp3 bytes")

    a = Asset(
        channel_id=channel.id,
        asset_type="music",
        source="upload",
        filename=name,
        filepath=rel,
        file_size=len(b"fake mp3 bytes"),
        mime_type="audio/mpeg",
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)
    return a


async def test_reassign_moves_file_and_updates_row(db, channel, music_assets):
    target = await _make_target_channel(db)
    src_asset = await _make_asset_with_file(db, channel, "to_move.mp3")

    response = await reassign_assets_channel(
        payload={"asset_ids": [src_asset.id], "channel_id": target.id},
        db=db,
    )

    assert len(response) == 1
    moved = response[0]
    assert moved.channel_id == target.id
    # New filepath sits under the target channel's directory.
    assert moved.filepath.startswith(f"{target.id}/music/")
    # File on disk follows the row.
    new_abs = settings.assets_dir / moved.filepath
    assert new_abs.exists()
    # Old file is gone.
    old_abs = settings.assets_dir / f"{channel.id}/music/to_move.mp3"
    assert not old_abs.exists()


async def test_reassign_to_same_channel_is_noop(db, channel):
    src_asset = await _make_asset_with_file(db, channel, "stay.mp3")
    response = await reassign_assets_channel(
        payload={"asset_ids": [src_asset.id], "channel_id": channel.id},
        db=db,
    )
    assert len(response) == 1
    # Path should still resolve under the original channel.
    assert response[0].filepath == src_asset.filepath
    # File stays where it was.
    assert (settings.assets_dir / src_asset.filepath).exists()


async def test_reassign_rejects_missing_target_channel(db, channel):
    src_asset = await _make_asset_with_file(db, channel, "x.mp3")
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await reassign_assets_channel(
            payload={"asset_ids": [src_asset.id], "channel_id": 99999},
            db=db,
        )
    assert exc.value.status_code == 404


async def test_reassign_requires_asset_ids(db, channel):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await reassign_assets_channel(
            payload={"asset_ids": [], "channel_id": channel.id},
            db=db,
        )
    assert exc.value.status_code == 400


async def test_reassign_handles_missing_file_on_disk(db, channel):
    """Asset row points to a file that's been deleted out from under us.
    Endpoint should still update the DB row so the UI shows it under
    the right channel; reconcile pass cleans up the broken filepath."""
    target = await _make_target_channel(db)
    a = Asset(
        channel_id=channel.id,
        asset_type="music",
        source="upload",
        filename="ghost.mp3",
        filepath=f"{channel.id}/music/ghost.mp3",  # never exists on disk
        file_size=0,
        mime_type="audio/mpeg",
    )
    db.add(a)
    await db.commit()
    await db.refresh(a)

    response = await reassign_assets_channel(
        payload={"asset_ids": [a.id], "channel_id": target.id},
        db=db,
    )
    assert len(response) == 1
    assert response[0].channel_id == target.id


async def test_reassign_bulk_multiple_assets(db, channel):
    target = await _make_target_channel(db)
    a1 = await _make_asset_with_file(db, channel, "bulk1.mp3")
    a2 = await _make_asset_with_file(db, channel, "bulk2.mp3")
    a3 = await _make_asset_with_file(db, channel, "bulk3.mp3")

    response = await reassign_assets_channel(
        payload={"asset_ids": [a1.id, a2.id, a3.id], "channel_id": target.id},
        db=db,
    )
    assert len(response) == 3
    assert all(r.channel_id == target.id for r in response)
    # All three files moved to the target channel's dir.
    for r in response:
        assert (settings.assets_dir / r.filepath).exists()
