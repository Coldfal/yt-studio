"""Automation service unit tests.

Track-selection logic and the library-image picker — both pure-ish
functions that don't need FFmpeg or external APIs.
"""
from __future__ import annotations

import pytest

from app.models import Asset, VideoProject
from app.services.automation_service import _select_tracks, automation_service


# Note: only async tests need the asyncio mark. Apply per-test below.


# ── _select_tracks ───────────────────────────────────────────────────


def _make_files(durations: list[float]) -> list[dict]:
    return [
        {"filename": f"t{i}.mp3", "filepath": f"/m/t{i}.mp3", "duration_seconds": d}
        for i, d in enumerate(durations)
    ]


def test_select_tracks_returns_exact_count_when_num_tracks_set():
    files = _make_files([180, 180, 180, 180, 180])
    selected = _select_tracks(files, target_seconds=600, num_tracks=3)
    assert len(selected) == 3


def test_select_tracks_clamps_num_tracks_to_available():
    # Asking for 10 from a pool of 3 should just return the 3.
    files = _make_files([180, 180, 180])
    selected = _select_tracks(files, target_seconds=600, num_tracks=10)
    assert len(selected) == 3


def test_select_tracks_fits_to_target_when_num_tracks_unset():
    # Target 600s, tolerance 300s -> should stop near 300s minimum.
    files = _make_files([180] * 20)
    selected = _select_tracks(files, target_seconds=600, tolerance=0)
    total = sum(f["duration_seconds"] for f in selected)
    assert total >= 600


def test_select_tracks_raises_when_pool_empty():
    with pytest.raises(ValueError, match="No audio files"):
        _select_tracks([], target_seconds=600)


def test_select_tracks_raises_when_durations_all_zero():
    files = _make_files([0, 0, 0])
    with pytest.raises(ValueError, match="valid duration"):
        _select_tracks(files, target_seconds=600)


def test_select_tracks_raises_when_total_below_60s():
    # Single 30s file: not enough material for any video.
    files = _make_files([30])
    with pytest.raises(ValueError, match="Not enough audio"):
        _select_tracks(files, target_seconds=600)


# ── _select_image_from_library ───────────────────────────────────────


@pytest.mark.asyncio
async def test_select_image_returns_pinned_when_valid(db, channel, image_assets):
    pinned = image_assets[1]
    chosen = await automation_service._select_image_from_library(
        channel_id=channel.id, pinned_id=pinned.id,
    )
    assert chosen is not None
    assert chosen.id == pinned.id


@pytest.mark.asyncio
async def test_select_image_ignores_pinned_from_other_channel(db, channel, image_assets):
    # Create an image on a different channel; passing its id should be ignored.
    from app.models import Channel

    other = Channel(name="Other Channel", niche="ambient")
    db.add(other)
    await db.commit()
    await db.refresh(other)

    foreign = Asset(
        channel_id=other.id,
        asset_type="image",
        source="upload",
        filename="foreign.png",
        filepath=f"{other.id}/images/foreign.png",
        file_size=1,
        mime_type="image/png",
    )
    db.add(foreign)
    await db.commit()
    await db.refresh(foreign)

    chosen = await automation_service._select_image_from_library(
        channel_id=channel.id, pinned_id=foreign.id,
    )
    # Must fall back to one of the channel's own images, not the foreign one.
    assert chosen is not None
    assert chosen.channel_id == channel.id


@pytest.mark.asyncio
async def test_select_image_returns_none_when_library_empty(db, channel):
    chosen = await automation_service._select_image_from_library(channel_id=channel.id)
    assert chosen is None


@pytest.mark.asyncio
async def test_select_image_allows_reuse_of_previously_published(db, channel, image_assets):
    """Phase 0 of farm redesign removed the no-reuse rotation. The
    picker is now a simple random pick across the channel's
    role=background images — a previously-published image is just as
    eligible as a fresh one. This freed the operator from "I can never
    reuse my favourite background" frustration.

    Test: with one image already in a published project, the picker
    over many trials lands on BOTH images, not just the unused one.
    """
    used = image_assets[0]

    vp = VideoProject(
        channel_id=channel.id,
        title="Already published",
        youtube_video_id="published123",
        image_asset_ids=[used.id],
    )
    db.add(vp)
    await db.commit()

    chosen_ids: set[int] = set()
    for _ in range(40):
        chosen = await automation_service._select_image_from_library(channel.id)
        assert chosen is not None
        chosen_ids.add(chosen.id)
        # Reuse is fine — no assertion against the used image.

    # Across 40 trials random.choice should hit both images. If the
    # rotation logic ever creeps back in this assertion catches it.
    assert len(chosen_ids) >= 2, (
        f"Expected reuse across trials, only saw {chosen_ids}"
    )
