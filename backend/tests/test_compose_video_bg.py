"""Tests for the video-background compose path.

When the user picks a video file as the visualizer's "background image",
``compose_service.compose_video`` switches from the static-image render
path to a chromakey-overlay pipeline:
  1. Engine renders normally with no static image (just particles +
     spectrum + text on the solid background colour).
  2. ffmpeg post-processes: chromakey-removes the bg colour, overlays
     the result onto the user's bg video looped to audio length.

These tests exercise the detection + branching logic. The actual
ffmpeg subprocess is mocked — the test fixtures don't have real
visualizer outputs, real bg videos, or a working ffmpeg path.
"""
from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from app.services.compose_service import (
    ComposeError,
    ComposeService,
    _is_video_path,
)


# ── extension detection ──────────────────────────────────────────────────────


@pytest.mark.parametrize(
    "path,expected",
    [
        ("ch1/image/bg.mp4", True),
        ("ch1/image/bg.MP4", True),
        ("ch1/image/bg.mov", True),
        ("ch1/image/bg.webm", True),
        ("ch1/image/bg.mkv", True),
        ("ch1/image/bg.png", False),
        ("ch1/image/bg.jpg", False),
        ("ch1/image/bg.gif", False),
        ("ch1/image/no_extension", False),
    ],
)
def test_is_video_path_recognises_supported_extensions(path, expected):
    assert _is_video_path(path) is expected


# ── chromakey hex sanitisation (via _composite_over_video flow) ──────────────


@pytest.mark.asyncio
async def test_composite_normalises_3char_hex(tmp_path, channel):
    """``#abc`` (CSS shorthand) is expanded to ``aabbcc`` for ffmpeg."""
    vis = tmp_path / "vis.mp4"
    vis.write_bytes(b"x")
    bg = tmp_path / "bg.mp4"
    bg.write_bytes(b"y")

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        result = MagicMock()
        result.returncode = 0
        result.stderr = b""
        # Pretend ffmpeg wrote a non-empty output file
        out_path = Path(cmd[-1])
        out_path.parent.mkdir(parents=True, exist_ok=True)
        out_path.write_bytes(b"composited")
        return result

    svc = ComposeService()
    with patch(
        "app.services.compose_service.subprocess.run", new=fake_run,
    ):
        with patch.object(svc, "_build_filename", new=AsyncMock(return_value="out.mp4")):
            await svc._composite_over_video(
                visualizer_path=vis,
                bg_video_path=bg,
                chromakey_hex="#abc",
                channel_id=channel.id,
                width=1920,
                height=1080,
                fps=30,
                crf=23,
            )

    cmd = captured["cmd"]
    filter_complex = next(
        c for c in cmd if isinstance(c, str) and "colorkey=" in c
    )
    assert "colorkey=0xaabbcc:" in filter_complex


@pytest.mark.asyncio
async def test_composite_falls_back_when_hex_invalid(tmp_path, channel):
    """A bogus chromakey value defaults to ``0x0f0f1a`` (the safe near-black)."""
    vis = tmp_path / "vis.mp4"
    vis.write_bytes(b"x")
    bg = tmp_path / "bg.mp4"
    bg.write_bytes(b"y")

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        result = MagicMock()
        result.returncode = 0
        result.stderr = b""
        Path(cmd[-1]).parent.mkdir(parents=True, exist_ok=True)
        Path(cmd[-1]).write_bytes(b"composited")
        return result

    svc = ComposeService()
    with patch(
        "app.services.compose_service.subprocess.run", new=fake_run,
    ):
        with patch.object(svc, "_build_filename", new=AsyncMock(return_value="out.mp4")):
            await svc._composite_over_video(
                visualizer_path=vis,
                bg_video_path=bg,
                chromakey_hex="not-a-hex",
                channel_id=channel.id,
                width=1920,
                height=1080,
                fps=30,
                crf=23,
            )

    filter_complex = next(
        c for c in captured["cmd"] if isinstance(c, str) and "colorkey=" in c
    )
    assert "colorkey=0x0f0f1a:" in filter_complex


@pytest.mark.asyncio
async def test_composite_uses_stream_loop_for_bg(tmp_path, channel):
    """The bg video must use ``-stream_loop -1`` so a short loop covers
    a long audio track without truncation."""
    vis = tmp_path / "vis.mp4"
    vis.write_bytes(b"x")
    bg = tmp_path / "bg.mp4"
    bg.write_bytes(b"y")

    captured: dict = {}

    def fake_run(cmd, **kwargs):
        captured["cmd"] = cmd
        result = MagicMock()
        result.returncode = 0
        result.stderr = b""
        Path(cmd[-1]).parent.mkdir(parents=True, exist_ok=True)
        Path(cmd[-1]).write_bytes(b"composited")
        return result

    svc = ComposeService()
    with patch(
        "app.services.compose_service.subprocess.run", new=fake_run,
    ):
        with patch.object(svc, "_build_filename", new=AsyncMock(return_value="out.mp4")):
            await svc._composite_over_video(
                visualizer_path=vis,
                bg_video_path=bg,
                chromakey_hex="#0f0f1a",
                channel_id=channel.id,
                width=1920,
                height=1080,
                fps=30,
                crf=23,
            )

    cmd = captured["cmd"]
    # ``-stream_loop -1`` must come before the bg video input
    sl_idx = cmd.index("-stream_loop")
    assert cmd[sl_idx + 1] == "-1"
    # And before the bg video, not the visualizer
    bg_idx = cmd.index(str(bg))
    vis_idx = cmd.index(str(vis))
    assert sl_idx < bg_idx < vis_idx
    # ``-shortest`` caps to visualizer length so the loop terminates
    assert "-shortest" in cmd


@pytest.mark.asyncio
async def test_composite_raises_compose_error_on_ffmpeg_failure(tmp_path, channel):
    """Non-zero ffmpeg exit → ComposeError with stderr tail in the message."""
    vis = tmp_path / "vis.mp4"
    vis.write_bytes(b"x")
    bg = tmp_path / "bg.mp4"
    bg.write_bytes(b"y")

    def fake_run(cmd, **kwargs):
        result = MagicMock()
        result.returncode = 1
        result.stderr = b"some ffmpeg error message"
        return result

    svc = ComposeService()
    with patch(
        "app.services.compose_service.subprocess.run", new=fake_run,
    ):
        with patch.object(svc, "_build_filename", new=AsyncMock(return_value="out.mp4")):
            with pytest.raises(ComposeError, match="some ffmpeg error"):
                await svc._composite_over_video(
                    visualizer_path=vis,
                    bg_video_path=bg,
                    chromakey_hex="#0f0f1a",
                    channel_id=channel.id,
                    width=1920,
                    height=1080,
                    fps=30,
                    crf=23,
                )


# ── compose_video routing — end-to-end branch detection ─────────────────────


@pytest.mark.asyncio
async def test_compose_video_with_video_bg_skips_engine_image(
    tmp_path, channel, monkeypatch,
):
    """When ``image_filepaths[0]`` is an .mp4, the engine is called with
    ``image_filepath=None`` (not the video path) and the post-process step
    runs."""
    from app.config import settings as _settings

    # Set up a video file at the expected location
    bg_rel = f"{channel.id}/image/bg.mp4"
    bg_abs = _settings.assets_dir / bg_rel
    bg_abs.parent.mkdir(parents=True, exist_ok=True)
    bg_abs.write_bytes(b"fake mp4")

    music_rel = f"{channel.id}/music/song.mp3"
    music_abs = _settings.assets_dir / music_rel
    music_abs.parent.mkdir(parents=True, exist_ok=True)
    music_abs.write_bytes(b"fake mp3")

    # Mock the visualizer engine so it doesn't try to spawn Node
    engine_result = {
        "filename": "engine_out.mp4",
        "filepath": f"{channel.id}/composed/engine_out.mp4",
        "duration": 60.0,
        "file_size": 1024,
    }
    engine_out_abs = _settings.assets_dir / engine_result["filepath"]
    engine_out_abs.parent.mkdir(parents=True, exist_ok=True)
    engine_out_abs.write_bytes(b"engine mp4")

    captured_engine_args: dict = {}

    async def fake_render(*args, **kwargs):
        captured_engine_args.update(kwargs)
        return engine_result

    # Mock the composite step too — we don't want a real ffmpeg call here.
    composite_called: dict = {}

    async def fake_composite(self, **kwargs):
        composite_called.update(kwargs)
        out = _settings.assets_dir / f"{channel.id}/composed/composited.mp4"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(b"composited mp4")
        return out

    from app.services.visualizer_engine_service import visualizer_engine_service

    svc = ComposeService()
    with patch.object(
        visualizer_engine_service, "render_video", new=fake_render,
    ):
        with patch.object(
            ComposeService, "_composite_over_video", new=fake_composite,
        ):
            result = await svc.compose_video(
                channel_id=channel.id,
                music_filepath=music_rel,
                image_filepaths=[bg_rel],
                style="spectrum",
                config={"backgroundColor": "#0f0f1a"},
            )

    # Engine was called with image_filepath=None (because video bg detected)
    assert captured_engine_args.get("image_filepath") is None
    # Composite step ran, with the bg video and the engine output
    assert composite_called.get("bg_video_path") == bg_abs
    assert composite_called.get("visualizer_path") == engine_out_abs
    assert composite_called.get("chromakey_hex") == "#0f0f1a"
    # Final result reflects the composited output, not the engine output
    assert "composited.mp4" in result["filepath"]


@pytest.mark.asyncio
async def test_compose_video_with_image_bg_skips_post_process(
    tmp_path, channel,
):
    """When the bg is a regular image, no post-process happens — engine
    output is the final output."""
    from app.config import settings as _settings

    img_rel = f"{channel.id}/image/bg.png"
    img_abs = _settings.assets_dir / img_rel
    img_abs.parent.mkdir(parents=True, exist_ok=True)
    img_abs.write_bytes(b"fake png")

    music_rel = f"{channel.id}/music/song.mp3"
    music_abs = _settings.assets_dir / music_rel
    music_abs.parent.mkdir(parents=True, exist_ok=True)
    music_abs.write_bytes(b"fake mp3")

    engine_result = {
        "filename": "engine_out.mp4",
        "filepath": f"{channel.id}/composed/engine_out.mp4",
        "duration": 60.0,
        "file_size": 1024,
    }
    engine_out_abs = _settings.assets_dir / engine_result["filepath"]
    engine_out_abs.parent.mkdir(parents=True, exist_ok=True)
    engine_out_abs.write_bytes(b"engine mp4")

    captured_engine_args: dict = {}

    async def fake_render(*args, **kwargs):
        captured_engine_args.update(kwargs)
        return engine_result

    composite_call_count = {"n": 0}

    async def fake_composite(self, **kwargs):
        composite_call_count["n"] += 1
        return Path(kwargs["visualizer_path"])

    from app.services.visualizer_engine_service import visualizer_engine_service

    svc = ComposeService()
    with patch.object(
        visualizer_engine_service, "render_video", new=fake_render,
    ):
        with patch.object(
            ComposeService, "_composite_over_video", new=fake_composite,
        ):
            result = await svc.compose_video(
                channel_id=channel.id,
                music_filepath=music_rel,
                image_filepaths=[img_rel],
                style="spectrum",
                config={"backgroundColor": "#0f0f1a"},
            )

    # Engine got the image (NOT None — image bg path)
    assert captured_engine_args.get("image_filepath") == img_rel
    # Composite step did NOT run
    assert composite_call_count["n"] == 0
    # Result is the engine's output verbatim
    assert result == engine_result
