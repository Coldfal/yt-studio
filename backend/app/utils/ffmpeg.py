from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path

from app.config import settings

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _ffmpeg() -> str:
    return settings.ffmpeg_path


def _ffprobe() -> str:
    return settings.ffprobe_path


def _escape_path_for_filter(path: str) -> str:
    """Escape colons in Windows paths for use inside FFmpeg filter strings.

    FFmpeg filter graphs use ``:`` as a separator, so a literal colon in a
    Windows drive letter (``C:``) must be escaped as ``C\\:``.
    """
    # Only touch the drive-letter colon (e.g. C: -> C\:)
    if len(path) >= 2 and path[1] == ":":
        return path[0] + "\\:" + path[2:]
    return path


def _audio_fade_filter(duration: float, fade_in: float, fade_out: float) -> str:
    """Build an afade filter string for the given durations."""
    parts: list[str] = []
    if fade_in > 0:
        parts.append(f"afade=t=in:st=0:d={fade_in}")
    if fade_out > 0:
        fade_start = max(duration - fade_out, 0)
        parts.append(f"afade=t=out:st={fade_start}:d={fade_out}")
    return ",".join(parts) if parts else "anull"


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------

def get_audio_duration(filepath: str, ffprobe_path: str | None = None) -> float:
    """Return the duration of *filepath* in seconds using ffprobe."""
    probe = ffprobe_path or _ffprobe()
    cmd = [
        probe,
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "json",
        filepath,
    ]
    logger.debug("Running ffprobe: %s", " ".join(cmd))
    result = subprocess.run(cmd, capture_output=True, text=True, check=True)
    data = json.loads(result.stdout)
    return float(data["format"]["duration"])


def build_loop_cmd(
    image_path: str | Path,
    audio_path: str | Path,
    output_path: str | Path,
    config: dict,
) -> list[str]:
    """Build an FFmpeg command that loops a short video and audio to a target duration.

    Despite the parameter name ``image_path``, this expects a video file (MP4).
    Both the video and audio inputs are looped with ``-stream_loop -1`` and
    cut to the target duration with ``-t``.

    ``config`` keys (all optional, shown with defaults):
        target_duration     3600        (seconds, default 1 hour)
        output_width        1920
        output_height       1080
        audio_fade_in       2.0
        audio_fade_out      5.0
    """
    target = config.get("target_duration", 3600)
    w = config.get("output_width", 1920)
    h = config.get("output_height", 1080)
    fade_in = config.get("audio_fade_in", 2.0)
    fade_out = config.get("audio_fade_out", 5.0)

    audio_filter = _audio_fade_filter(float(target), fade_in, fade_out)
    video_filter = (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"
    )

    cmd = [
        _ffmpeg(), "-y",
        "-stream_loop", "-1", "-i", str(image_path),
        "-stream_loop", "-1", "-i", str(audio_path),
        "-t", str(int(target)),
        "-filter_complex",
        f"[0:v]{video_filter}[v];[1:a]{audio_filter}[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        str(output_path),
    ]
    return cmd


def build_ken_burns_cmd(
    image_path: str | Path,
    audio_path: str | Path,
    output_path: str | Path,
    config: dict,
) -> list[str]:
    """Build an FFmpeg command list for a Ken Burns zoom/pan effect video.

    ``config`` keys (all optional, shown with defaults):
        zoom_start      1.0
        zoom_end        1.3
        output_width    1920
        output_height   1080
        output_fps      30
        audio_fade_in   2.0
        audio_fade_out  5.0
    """
    zoom_start = config.get("zoom_start", 1.0)
    zoom_end = config.get("zoom_end", 1.3)
    w = config.get("output_width", 1920)
    h = config.get("output_height", 1080)
    fps = config.get("output_fps", 30)
    fade_in = config.get("audio_fade_in", 2.0)
    fade_out = config.get("audio_fade_out", 5.0)

    # Determine audio length so we can set the number of zoompan frames
    duration = get_audio_duration(str(audio_path))
    total_frames = int(duration * fps)

    # Scale image to 2x output resolution first, then apply zoompan
    # zoompan: z interpolates linearly from zoom_start -> zoom_end
    # d = total number of frames, s = output size
    scale_w = w * 2
    scale_h = h * 2
    zoom_expr = f"{zoom_start}+({zoom_end}-{zoom_start})*on/{total_frames}"
    video_filter = (
        f"scale={scale_w}:{scale_h}:force_original_aspect_ratio=increase,"
        f"crop={scale_w}:{scale_h},"
        f"zoompan=z='{zoom_expr}':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'"
        f":d={total_frames}:s={w}x{h}:fps={fps}"
    )

    audio_filter = _audio_fade_filter(duration, fade_in, fade_out)

    cmd = [
        _ffmpeg(), "-y",
        "-loop", "1", "-i", str(image_path),
        "-i", str(audio_path),
        "-filter_complex",
        f"[0:v]{video_filter}[v];[1:a]{audio_filter}[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        str(output_path),
    ]
    return cmd


def build_static_cmd(
    image_path: str | Path,
    audio_path: str | Path,
    output_path: str | Path,
    config: dict,
) -> list[str]:
    """Build an FFmpeg command for a static image combined with audio.

    ``config`` keys (all optional, shown with defaults):
        output_width    1920
        output_height   1080
        audio_fade_in   2.0
        audio_fade_out  5.0
    """
    w = config.get("output_width", 1920)
    h = config.get("output_height", 1080)
    fade_in = config.get("audio_fade_in", 2.0)
    fade_out = config.get("audio_fade_out", 5.0)

    duration = get_audio_duration(str(audio_path))
    audio_filter = _audio_fade_filter(duration, fade_in, fade_out)

    video_filter = (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color=black"
    )

    cmd = [
        _ffmpeg(), "-y",
        "-loop", "1", "-i", str(image_path),
        "-i", str(audio_path),
        "-filter_complex",
        f"[0:v]{video_filter}[v];[1:a]{audio_filter}[a]",
        "-map", "[v]", "-map", "[a]",
        "-c:v", "libx264", "-preset", "medium", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-b:a", "192k",
        "-shortest",
        str(output_path),
    ]
    return cmd


# NOTE: The old build_waveform_cmd (FFmpeg showwaves/showfreqs based) and its
# helper _resolve_wave_colors were removed when the "spectrum" style migrated
# to the Node.js visualizer engine sidecar. See:
#   backend/app/services/visualizer_engine_service.py
#   backend/visualizer_engine/
