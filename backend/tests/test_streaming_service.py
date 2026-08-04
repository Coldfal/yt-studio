"""Tests for streaming_service.

Covers the bits that don't actually spawn FFmpeg or call YouTube:
- Validation in start_stream (early-exit branches)
- recover_on_startup DB sweep
- stop_stream when there's no active in-memory context (DB-only)
- get_active_channels
- The pure FFmpeg command builder
- The YouTube broadcast helpers (mocked googleapiclient)
- _create_black_image fallback

The full _setup_and_launch / _launch_*_stream pipelines aren't tested
here — they spawn subprocesses and orchestrate too much state. They
have manual smoke testing through the Live page, and the helpers
this file covers ARE the load-bearing pieces underneath.
"""
from __future__ import annotations

import json
from pathlib import Path
from unittest.mock import MagicMock, patch

import pytest

from app.models import Channel
from app.models.live_stream import LiveStream
from app.services.streaming_service import StreamManager


# ── Fixtures ─────────────────────────────────────────────────────────────────


@pytest.fixture
async def channel_with_creds(db, channel: Channel) -> Channel:
    """A channel with encrypted YouTube credentials."""
    from app.utils.crypto import encrypt
    creds = json.dumps({
        "token": "tok",
        "refresh_token": "rtok",
        "client_id": "cid",
        "client_secret": "csec",
        "scopes": ["https://www.googleapis.com/auth/youtube"],
    })
    channel.youtube_credentials_json = encrypt(creds)
    await db.commit()
    await db.refresh(channel)
    return channel


# ── Validation tests ─────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_start_stream_rejects_when_channel_already_streaming(
    db, channel: Channel,
):
    """Starting a second stream on the same channel raises."""
    sm = StreamManager()
    # Simulate active stream by stuffing the dict directly
    sm._active[channel.id] = MagicMock()

    with pytest.raises(ValueError, match="already has an active stream"):
        await sm.start_stream(
            channel_id=channel.id,
            title="t",
            description="d",
            target_duration_hours=1.0,
            music_folder_path="/tmp",
        )


@pytest.mark.asyncio
async def test_start_stream_rejects_without_audio_source():
    """Need composed_asset_id, music_folder_path, or use_channel_music_assets."""
    sm = StreamManager()
    with pytest.raises(ValueError, match="Provide composed_asset_id"):
        await sm.start_stream(
            channel_id=1,
            title="t",
            description="d",
            target_duration_hours=1.0,
        )


@pytest.mark.asyncio
async def test_start_stream_rejects_when_channel_not_found(db):
    """Channel must exist."""
    sm = StreamManager()
    with pytest.raises(ValueError, match="not found"):
        await sm.start_stream(
            channel_id=99999,
            title="t",
            description="d",
            target_duration_hours=1.0,
            music_folder_path="/tmp",
        )


@pytest.mark.asyncio
async def test_start_stream_rejects_when_no_youtube_creds(
    db, channel: Channel,
):
    """Channel must have YouTube OAuth set up."""
    sm = StreamManager()
    with pytest.raises(ValueError, match="no YouTube credentials"):
        await sm.start_stream(
            channel_id=channel.id,
            title="t",
            description="d",
            target_duration_hours=1.0,
            music_folder_path="/tmp",
        )


# ── Recovery + introspection ─────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recover_on_startup_marks_orphaned_streams_failed(
    db, channel: Channel,
):
    """Streams in preparing/starting/live get marked failed on startup."""
    for status in ("preparing", "starting", "live"):
        s = LiveStream(
            channel_id=channel.id,
            status=status,
            title=f"{status} stream",
            target_duration_hours=1.0,
        )
        db.add(s)
    await db.commit()

    sm = StreamManager()
    await sm.recover_on_startup()

    # recover_on_startup opens its own session; read from a fresh one too
    # so we don't see stale identity-map cached rows.
    from sqlalchemy import select
    from app.database import async_session
    async with async_session() as fresh:
        rows = (
            await fresh.execute(
                select(LiveStream).where(LiveStream.channel_id == channel.id)
            )
        ).scalars().all()

    statuses = sorted(r.status for r in rows)
    assert statuses == ["failed", "failed", "failed"]
    assert all(r.error == "Server restarted" for r in rows)
    assert all(r.stopped_at is not None for r in rows)


@pytest.mark.asyncio
async def test_recover_on_startup_leaves_terminal_streams_alone(
    db, channel: Channel,
):
    """Already-stopped or already-failed streams aren't touched."""
    for status in ("stopped", "failed"):
        s = LiveStream(
            channel_id=channel.id,
            status=status,
            title=f"{status} stream",
            target_duration_hours=1.0,
        )
        db.add(s)
    await db.commit()

    sm = StreamManager()
    await sm.recover_on_startup()

    # Read from a fresh session — recover_on_startup wrote in its own
    from sqlalchemy import select
    from app.database import async_session
    async with async_session() as fresh:
        rows = (
            await fresh.execute(
                select(LiveStream).where(LiveStream.channel_id == channel.id)
            )
        ).scalars().all()

    # Both should keep their original status; neither should have a synthetic error
    assert sorted(r.status for r in rows) == ["failed", "stopped"]
    assert all(r.error != "Server restarted" for r in rows)


@pytest.mark.asyncio
async def test_get_active_channels_empty():
    sm = StreamManager()
    assert sm.get_active_channels() == []


@pytest.mark.asyncio
async def test_get_active_channels_after_start():
    sm = StreamManager()
    sm._active[5] = MagicMock()
    sm._active[7] = MagicMock()
    assert sorted(sm.get_active_channels()) == [5, 7]


# ── stop_stream non-active path ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stop_stream_marks_db_when_not_active(db, channel: Channel):
    """If a LiveStream row exists but isn't in _active, just flip it stopped."""
    s = LiveStream(
        channel_id=channel.id,
        status="live",  # stale; the worker died but row is still 'live'
        title="ghost",
        target_duration_hours=1.0,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)

    sm = StreamManager()
    # _active is empty → the early-exit branch fires
    await sm.stop_stream(s.id)

    await db.refresh(s)
    assert s.status == "stopped"
    assert s.stopped_at is not None


@pytest.mark.asyncio
async def test_stop_stream_raises_when_id_unknown(db):
    """Stopping a non-existent stream raises."""
    sm = StreamManager()
    with pytest.raises(ValueError, match="not found"):
        await sm.stop_stream(99999)


# ── FFmpeg command builder ───────────────────────────────────────────────────


def test_build_ffmpeg_cmd_includes_required_flags():
    sm = StreamManager()
    cmd = sm._build_ffmpeg_cmd(
        rtmp_url="rtmp://a.rtmp.youtube.com/live2/abc",
        audio_path="C:/Music/track.mp3",
        image_path="C:/Images/bg.png",
    )

    # The exact ffmpeg path comes from settings; everything else is fixed
    assert "-loop" in cmd
    assert "-stream_loop" in cmd  # so audio loops past the first track
    assert "-c:v" in cmd
    assert "libx264" in cmd
    assert "-c:a" in cmd
    assert "aac" in cmd
    assert "-f" in cmd
    assert "flv" in cmd  # RTMP requires FLV mux
    # The two inputs and the output URL all need to be there
    assert "C:/Images/bg.png" in cmd
    assert "C:/Music/track.mp3" in cmd
    assert "rtmp://a.rtmp.youtube.com/live2/abc" in cmd


def test_build_ffmpeg_cmd_pads_to_1080p():
    """The image is scaled + letterboxed to 1920×1080 — verify the vf string."""
    sm = StreamManager()
    cmd = sm._build_ffmpeg_cmd(
        rtmp_url="rtmp://x", audio_path="a.mp3", image_path="i.png",
    )
    vf_index = cmd.index("-vf")
    vf = cmd[vf_index + 1]
    assert "1920:1080" in vf
    assert "force_original_aspect_ratio=decrease" in vf
    assert "pad=" in vf


# ── _create_black_image fallback ─────────────────────────────────────────────


def test_create_black_image_writes_valid_png(tmp_path):
    out = tmp_path / "fallback.png"
    StreamManager._create_black_image(str(out), 320, 240)

    assert out.exists()
    # PNG magic number
    with open(out, "rb") as f:
        assert f.read(8) == b"\x89PNG\r\n\x1a\n"
    # Sanity: PIL can re-open it at the right dimensions
    from PIL import Image
    with Image.open(out) as img:
        assert img.size == (320, 240)
        assert img.mode == "RGB"


# ── YouTube broadcast helpers ────────────────────────────────────────────────


def test_create_youtube_broadcast_and_stream_creates_and_binds():
    """Verify the three-call flow (broadcast.insert → stream.insert → bind)."""
    yt = MagicMock()
    # liveBroadcasts().insert().execute() returns a broadcast resource
    yt.liveBroadcasts.return_value.insert.return_value.execute.return_value = {
        "id": "bc-123",
    }
    # liveStreams().insert().execute() returns a stream resource with cdn info
    yt.liveStreams.return_value.insert.return_value.execute.return_value = {
        "id": "st-456",
        "cdn": {
            "ingestionInfo": {
                "ingestionAddress": "rtmp://a.rtmp.youtube.com/live2",
                "streamName": "my-stream-key",
            },
        },
    }
    yt.liveBroadcasts.return_value.bind.return_value.execute.return_value = {}

    creds = MagicMock()
    sm = StreamManager()

    with patch("app.services.live_stream.youtube_live_api.build", return_value=yt):
        broadcast_id, stream_id, rtmp_url = sm._create_youtube_broadcast_and_stream(
            credentials=creds,
            title="Test",
            description="A test stream",
        )

    assert broadcast_id == "bc-123"
    assert stream_id == "st-456"
    assert rtmp_url == "rtmp://a.rtmp.youtube.com/live2/my-stream-key"

    # The broadcast body should carry our title + description
    insert_call = yt.liveBroadcasts.return_value.insert.call_args
    body = insert_call.kwargs["body"]
    assert body["snippet"]["title"] == "Test"
    assert body["snippet"]["description"] == "A test stream"
    assert body["status"]["privacyStatus"] == "public"
    assert body["contentDetails"]["enableAutoStart"] is True

    # bind() must be called with the matching broadcast + stream ids
    bind_call = yt.liveBroadcasts.return_value.bind.call_args
    assert bind_call.kwargs["id"] == "bc-123"
    assert bind_call.kwargs["streamId"] == "st-456"


@pytest.mark.asyncio
async def test_transition_broadcast_complete_calls_youtube_transition(
    db, channel_with_creds: Channel,
):
    """When the stream has a broadcast_id, transition fires."""
    s = LiveStream(
        channel_id=channel_with_creds.id,
        status="stopping",
        title="t",
        target_duration_hours=1.0,
        broadcast_id="bc-789",
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)

    yt = MagicMock()
    yt.liveBroadcasts.return_value.transition.return_value.execute.return_value = {}

    sm = StreamManager()
    with patch("app.services.live_stream.youtube_live_api.build", return_value=yt):
        await sm._transition_broadcast_complete(s.id)

    transition_call = yt.liveBroadcasts.return_value.transition.call_args
    assert transition_call.kwargs["broadcastStatus"] == "complete"
    assert transition_call.kwargs["id"] == "bc-789"


@pytest.mark.asyncio
async def test_transition_broadcast_complete_noop_without_broadcast_id(
    db, channel: Channel,
):
    """No broadcast_id on the row → no YouTube call attempted."""
    s = LiveStream(
        channel_id=channel.id,
        status="stopping",
        title="t",
        target_duration_hours=1.0,
        broadcast_id=None,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)

    yt = MagicMock()
    sm = StreamManager()
    with patch("app.services.live_stream.youtube_live_api.build", return_value=yt):
        await sm._transition_broadcast_complete(s.id)

    yt.liveBroadcasts.assert_not_called()
