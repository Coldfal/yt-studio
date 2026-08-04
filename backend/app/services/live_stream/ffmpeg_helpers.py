"""FFmpeg helpers for live RTMP streaming.

Pure functions. They don't touch ``StreamManager`` state, so they're
trivially unit-testable. The manager imports them and wires them
into the streaming pipeline.
"""
from __future__ import annotations

import asyncio
import subprocess
from typing import List

from app.config import settings


def build_ffmpeg_cmd(
    rtmp_url: str,
    audio_path: str,
    image_path: str,
) -> List[str]:
    """Build the FFmpeg command for the static-image RTMP stream.

    The command:
    - loops the background image (single-frame video source)
    - loops the merged audio track infinitely
    - encodes h264 + AAC at 1080p / 30fps / 3 Mbps for YouTube Live
    - muxes to FLV and pushes to ``rtmp_url``

    Used by the legacy "static image + merged audio" path. The
    visualizer-engine path builds its own command in
    ``StreamManager._launch_visualizer_stream``.
    """
    return [
        settings.ffmpeg_path,
        "-re",
        "-loop", "1",
        "-i", image_path,
        "-stream_loop", "-1",
        "-i", audio_path,
        "-c:v", "libx264",
        "-preset", "veryfast",
        "-tune", "stillimage",
        "-g", "60",
        "-keyint_min", "60",
        "-b:v", "3000k",
        "-maxrate", "3000k",
        "-bufsize", "6000k",
        "-pix_fmt", "yuv420p",
        "-vf", "scale=1920:1080:force_original_aspect_ratio=decrease,pad=1920:1080:(ow-iw)/2:(oh-ih)/2",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "44100",
        "-f", "flv",
        rtmp_url,
    ]


async def stop_ffmpeg(process: subprocess.Popen) -> None:
    """Gracefully stop an FFmpeg process.

    Strategy:
    1. Write ``q\\n`` to stdin (FFmpeg's clean-shutdown signal —
       finalises the stream so YouTube doesn't see a dropped feed).
    2. Wait up to 5 seconds for the process to exit.
    3. If still alive, ``terminate()`` (SIGTERM on POSIX, equivalent
       on Windows) and wait 3 seconds.
    4. If still alive, ``kill()`` — last resort, may corrupt the
       trailing FLV chunk but the stream is over anyway.
    """
    if process.poll() is not None:
        return  # Already exited

    # Step 1: graceful 'q'
    try:
        if process.stdin:
            process.stdin.write(b"q\n")
            process.stdin.flush()
    except (BrokenPipeError, OSError):
        # stdin already closed; fall through to terminate()
        pass

    loop = asyncio.get_running_loop()

    # Step 2: wait for graceful exit
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, process.wait),
            timeout=5.0,
        )
        return
    except asyncio.TimeoutError:
        pass

    # Step 3: terminate
    process.terminate()
    try:
        await asyncio.wait_for(
            loop.run_in_executor(None, process.wait),
            timeout=3.0,
        )
        return
    except asyncio.TimeoutError:
        pass

    # Step 4: hard kill
    process.kill()


def create_black_image(path: str, width: int, height: int) -> None:
    """Write a solid-black PNG at ``path``.

    Fallback background when the user didn't pick an image and we
    don't want to fail the stream over it. Pillow handles this in
    one call; no FFmpeg subprocess needed.
    """
    from PIL import Image

    img = Image.new("RGB", (width, height), (0, 0, 0))
    img.save(path, format="PNG")
