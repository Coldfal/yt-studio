"""Reusable audio utilities: merge, duration probing, folder scanning."""
from __future__ import annotations

import subprocess
import sys
import tempfile
from pathlib import Path
from typing import List

from app.config import settings


def merge_audio_files(
    audio_paths: List[Path],
    output_path: Path,
) -> None:
    """Concatenate audio files using FFmpeg concat demuxer (no re-encoding overhead).

    Raises RuntimeError on failure.
    """
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, encoding="utf-8"
    ) as f:
        for p in audio_paths:
            escaped = str(p.resolve()).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
        concat_file = f.name

    startupinfo = None
    if sys.platform == "win32":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0

    cmd = [
        settings.ffmpeg_path or "ffmpeg",
        "-f", "concat",
        "-safe", "0",
        "-i", concat_file,
        "-acodec", "libmp3lame",
        "-ab", "192k",
        "-y",
        str(output_path),
    ]

    try:
        result = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
            timeout=600,
        )
        if result.returncode != 0:
            stderr = result.stderr.decode("utf-8", errors="replace")
            raise RuntimeError(f"FFmpeg merge failed: {stderr[-500:]}")
    finally:
        Path(concat_file).unlink(missing_ok=True)

    if not output_path.exists():
        raise RuntimeError("Merge completed but output file was not created")


def get_audio_duration(filepath: str) -> float:
    """Return duration in seconds using ffprobe. Returns 0.0 on failure."""
    startupinfo = None
    if sys.platform == "win32":
        startupinfo = subprocess.STARTUPINFO()
        startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startupinfo.wShowWindow = 0

    cmd = [
        settings.ffprobe_path or "ffprobe",
        "-v", "error",
        "-show_entries", "format=duration",
        "-of", "default=noprint_wrappers=1:nokey=1",
        filepath,
    ]
    try:
        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            startupinfo=startupinfo,
            timeout=30,
        )
        return float(result.stdout.strip())
    except (ValueError, subprocess.TimeoutExpired):
        return 0.0


def scan_audio_folder(
    folder_path: str,
    extensions: List[str],
) -> List[dict]:
    """Scan a folder for audio files and return a list of {filename, filepath, duration_seconds}.

    Duration probing is synchronous — caller should run in executor for async.
    """
    folder = Path(folder_path)
    if not folder.is_dir():
        raise FileNotFoundError(f"Not a directory: {folder}")

    files = []
    for ext in extensions:
        files.extend(folder.glob(f"*.{ext}"))
        files.extend(folder.glob(f"*.{ext.upper()}"))

    # Deduplicate (glob patterns might overlap if e.g. ext="MP3" and "mp3")
    seen = set()
    unique_files = []
    for f in sorted(files):
        if f.resolve() not in seen:
            seen.add(f.resolve())
            unique_files.append(f)

    result = []
    for f in unique_files:
        dur = get_audio_duration(str(f))
        result.append({
            "filename": f.name,
            "filepath": str(f.resolve()),
            "duration_seconds": dur,
        })
    return result
