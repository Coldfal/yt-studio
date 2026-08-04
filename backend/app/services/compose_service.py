from __future__ import annotations

import asyncio
import logging
import re
import subprocess
import sys
from functools import partial
from pathlib import Path
from typing import Callable, Optional
from uuid import uuid4

from app.config import settings
from app.utils.ffmpeg import (
    build_ken_burns_cmd,
    build_loop_cmd,
    build_static_cmd,
    get_audio_duration,
)
from app.utils.file_utils import get_asset_dir, build_video_filename

logger = logging.getLogger(__name__)

# Supported composition styles and their command builders
_STYLE_BUILDERS = {
    "ken_burns": build_ken_burns_cmd,
    "static": build_static_cmd,
    "loop": build_loop_cmd,
}

# Regex to match FFmpeg progress lines like  time=00:01:30.45
_TIME_RE = re.compile(r"time=(\d{2}):(\d{2}):(\d{2})\.(\d{2,3})")

# Extensions the video-background path treats as motion sources. Anything
# not in this set falls through to the static-image path. Kept narrow so a
# wrong file type doesn't accidentally trigger the slower post-process.
_VIDEO_BG_EXTENSIONS = {".mp4", ".mov", ".webm", ".mkv"}


def _is_video_path(path: str | Path) -> bool:
    """``True`` when ``path`` points at a video file we know how to loop
    as a visualizer background. Used by ``compose_video`` to branch
    between the static-image render path and the ffmpeg-overlay path."""
    return Path(path).suffix.lower() in _VIDEO_BG_EXTENSIONS


class ComposeError(Exception):
    """Raised when FFmpeg composition fails."""


class ComposeService:
    """Orchestrates FFmpeg-based video composition from audio + images."""

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def compose_video(
        self,
        channel_id: int,
        music_filepath: str,
        image_filepaths: list[str],
        style: str,
        config: dict,
        music_filepaths: Optional[list[str]] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
        max_duration_seconds: Optional[float] = None,
    ) -> dict:
        """Compose a video from audio + images using FFmpeg.

        Parameters
        ----------
        channel_id:
            The channel that owns the assets.
        music_filepath:
            Path to the audio file, relative to ``settings.assets_dir``.
        image_filepaths:
            Paths to image files, relative to ``settings.assets_dir``.
            For *ken_burns*, *static*, and *spectrum* styles only the first
            image is used.
        style:
            One of ``"ken_burns"``, ``"static"``, ``"loop"``, ``"spectrum"``.
        config:
            Style-specific options forwarded to the FFmpeg command builder.
        on_progress:
            Optional **synchronous** callback invoked with ``(fraction, message)``
            as FFmpeg encodes.  *fraction* is in ``[0.0, 1.0]``.

        Returns
        -------
        dict
            ``{"filepath": str, "filename": str, "duration": float, "file_size": int}``
            where *filepath* is relative to ``settings.assets_dir``.

        Raises
        ------
        ComposeError
            If FFmpeg exits with a non-zero return code.
        ValueError
            If the style is unsupported or required files are missing.
        FileNotFoundError
            If an input file does not exist on disk.
        """

        # --- 1. Validate style ------------------------------------------------
        # The "spectrum" style delegates to the Node.js visualizer engine
        # sidecar — it has its own rendering pipeline (Canvas 2D + FFmpeg MJPEG
        # pipe), so it short-circuits the filter-graph-based pipeline used by
        # the other styles.
        if style == "spectrum":
            from app.services.visualizer_engine_service import (
                visualizer_engine_service,
            )

            # Multi-track support: use the full list if provided, else fall
            # back to the single music_filepath for backwards compatibility.
            music_paths = (
                list(music_filepaths) if music_filepaths else [music_filepath]
            )

            # Hard-cap path: when the caller asks for a video shorter than
            # the natural audio length, concatenate the selected tracks and
            # cut the result at ``max_duration_seconds``. Two callers hit
            # this today: the dashboard's "10s test" short-render preview,
            # and quick_generate's ``target_duration`` hard cap (e.g. user
            # picks 30 min target but the selected tracks total 60 min).
            # We bail out fast when the audio is already shorter than the
            # cap — extend_video handles padding after compose.
            if max_duration_seconds and max_duration_seconds > 0 and music_paths:
                loop_trim = asyncio.get_running_loop()
                abs_paths = [self._resolve_asset(p) for p in music_paths]
                track_durs: list[float] = []
                for ap in abs_paths:
                    d = await loop_trim.run_in_executor(
                        None, get_audio_duration,
                        str(ap), settings.ffprobe_path,
                    )
                    track_durs.append(float(d or 0.0))
                total_dur = sum(track_durs)

                if total_dur > max_duration_seconds + 0.5:
                    import tempfile
                    tmp_dir = Path(tempfile.gettempdir()) / "yts_trim"
                    tmp_dir.mkdir(parents=True, exist_ok=True)
                    cap = int(max_duration_seconds)
                    n = len(abs_paths)
                    trimmed = tmp_dir / f"trim_{cap}s_{n}t_{abs_paths[0].stem}.m4a"

                    # 5s linear fade-out at the end of the cap so the audio
                    # doesn't end on a hard cut mid-bar. Clamp the start so
                    # we don't request a negative timestamp on tiny caps
                    # (the dashboard's 10s test).
                    fade_start = max(0.0, float(max_duration_seconds) - 5.0)
                    afade_filter = f"afade=t=out:st={fade_start}:d=5"

                    # Single track: feed it directly. Multiple tracks: write a
                    # concat-demuxer list file and stream them in order. Either
                    # way we re-encode to m4a so the cut lands exactly on the
                    # requested timestamp (concat + -c copy is keyframe-aligned,
                    # not sample-accurate).
                    list_path: Path | None = None
                    # ``-vn`` is critical: many .mp3 sources carry an
                    # embedded album-art JPEG that ffmpeg treats as a
                    # video stream. Writing to ``.m4a`` (ipod container)
                    # then fails with "codec not currently supported in
                    # container". ``-vn`` drops the album art entirely
                    # so only the audio stream lands in the output.
                    if n == 1:
                        cmd = [
                            settings.ffmpeg_path, "-y",
                            "-i", str(abs_paths[0]),
                            "-vn",
                            "-t", str(float(max_duration_seconds)),
                            "-af", afade_filter,
                            "-c:a", "aac", "-b:a", "128k",
                            str(trimmed),
                        ]
                    else:
                        list_path = tmp_dir / f"trim_{cap}s_{n}t_{abs_paths[0].stem}.txt"
                        with open(list_path, "w", encoding="utf-8") as lf:
                            for ap in abs_paths:
                                # ffmpeg concat list: quote literal '
                                p = str(ap).replace("'", "'\\''")
                                lf.write(f"file '{p}'\n")
                        cmd = [
                            settings.ffmpeg_path, "-y",
                            "-f", "concat", "-safe", "0",
                            "-i", str(list_path),
                            "-vn",
                            "-t", str(float(max_duration_seconds)),
                            "-af", afade_filter,
                            "-c:a", "aac", "-b:a", "128k",
                            str(trimmed),
                        ]

                    trim_proc = await asyncio.create_subprocess_exec(
                        *cmd,
                        stdout=asyncio.subprocess.DEVNULL,
                        stderr=asyncio.subprocess.PIPE,
                    )
                    _stdout, stderr = await trim_proc.communicate()
                    if trim_proc.returncode != 0:
                        logger.warning(
                            "Audio cap failed (rc=%s): %s",
                            trim_proc.returncode,
                            (stderr or b"").decode("utf-8", errors="replace")[:300],
                        )
                    else:
                        # Replace music_paths with a single absolute path —
                        # the engine accepts absolute paths just fine
                        # (visualizer_engine_service passes them through).
                        music_paths = [str(trimmed)]
                        logger.info(
                            "Capped audio to %.1fs (was %.1fs across %d track(s))",
                            float(max_duration_seconds), total_dur, n,
                        )

            # NOTE: previously we'd loop the audio sequence here when the user
            # set loop_to_target so the compose step rendered a multi-hour
            # video in one pass. The new flow renders the natural audio length
            # only and then runs the fast video_extend pipeline after compose
            # (FFmpeg concat + -c copy, no re-encoding) — much faster.
            # The block below is intentionally retained as dead code so legacy
            # automation that still relies on the old behavior keeps a clear
            # reference. To re-enable, change `False` to `config.get("loop_to_target")`.
            if False and config.get("loop_to_target"):
                target = int(config.get("target_duration", 3600))
                if target > 0 and music_paths:
                    loop_ex = asyncio.get_running_loop()
                    total_dur = 0.0
                    for p in music_paths:
                        abs_p = self._resolve_asset(p)
                        d = await loop_ex.run_in_executor(
                            None, get_audio_duration,
                            str(abs_p), settings.ffprobe_path,
                        )
                        total_dur += float(d or 0.0)
                    if total_dur > 0:
                        import math
                        repeats = max(1, math.ceil(target / total_dur))
                        music_paths = music_paths * repeats
                        logger.info(
                            "Looping sequence of %d track(s) %d× to reach target %.0fs (total=%.1fs)",
                            len(music_paths) // repeats, repeats, target, total_dur,
                        )

            # Resolve a built-in overlay (e.g. the bundled Subscribe
            # animation) when the config references one but no explicit
            # overlay_filepath was provided. This lets a saved
            # VisualizerPreset that has overlayEnabled+overlayBuiltin
            # render correctly server-side without any extra plumbing.
            #
            # Backward-compat: presets saved before ``overlayBuiltin`` was
            # introduced just have ``overlayEnabled: true``. Since we ship
            # exactly one built-in (subscribe), default to it.
            overlay_fp = config.get("overlay_filepath")
            if not overlay_fp:
                builtin = config.get("overlayBuiltin")
                if builtin == "subscribe" or (
                    builtin is None and config.get("overlayEnabled")
                ):
                    overlay_fp = str(
                        settings.data_dir / "builtin" / "subscribe-animation.png"
                    )

            # Defensive: log loudly when the overlay file is missing
            # instead of silently passing None to the engine. The
            # engine's `_resolve_asset` swallows missing-file errors,
            # which is what hid the bug where `data_dir/builtin/`
            # didn't exist at all (and the user's videos shipped
            # without the subscribe overlay for weeks).
            if (
                config.get("overlayEnabled")
                and overlay_fp
                and not Path(overlay_fp).exists()
            ):
                logger.warning(
                    "Subscribe overlay enabled but file missing on disk: %s "
                    "(overlay will be silently skipped). Confirm the file "
                    "lives under settings.data_dir/builtin/.",
                    overlay_fp,
                )

            # ── Detect video-background mode ──────────────────────────
            # When the picked "image" is actually a video file, the
            # visualizer engine can't decode it (its tryLoadImage only
            # handles still images). Branch to the looping-bg path:
            #   1. Render visualizer normally with NO static image —
            #      engine fills the canvas with config.backgroundColor
            #      and draws particles/spectrum/text on top.
            #   2. Post-process with ffmpeg: chromakey-strip the bg
            #      color, overlay onto the bg video looped to the
            #      audio length.
            # Side effect: the user's backgroundColor in the visualizer
            # editor doubles as the chromakey colour during this mode
            # — they should pick something that doesn't collide with
            # their particle/text colours. Default ``#0f0f1a`` is a
            # near-black tone that works for typical configs.
            bg_video_path: Optional[Path] = None
            first_bg = image_filepaths[0] if image_filepaths else None
            if first_bg and _is_video_path(first_bg):
                resolved = self._resolve_asset(first_bg)
                if resolved.exists():
                    bg_video_path = resolved
                    logger.info(
                        "Compose: detected video background at %s — switching "
                        "to chromakey-overlay pipeline",
                        bg_video_path,
                    )
                else:
                    logger.warning(
                        "Compose: image_filepaths[0] looks like a video "
                        "(%s) but file not found on disk; falling back "
                        "to no-bg static render",
                        first_bg,
                    )

            engine_image = (
                None
                if bg_video_path is not None
                else (image_filepaths[0] if image_filepaths else None)
            )
            engine_result = await visualizer_engine_service.render_video(
                channel_id=channel_id,
                music_filepaths=music_paths,
                image_filepath=engine_image,
                logo_filepath=config.get("logo_filepath"),
                overlay_filepath=overlay_fp,
                config=config,
                preset_id=config.get("presetId", "trap-nation"),
                width=int(config.get("output_width", 1920)),
                height=int(config.get("output_height", 1080)),
                fps=int(config.get("output_fps", 30)),
                crf=int(config.get("crf", 23)),
                on_progress=on_progress,
            )

            if bg_video_path is None:
                return engine_result

            # ── Post-process: composite visualizer over looping bg video ─
            self._report(on_progress, 0.95, "Compositing over background video...")
            engine_output = self._resolve_asset(engine_result["filepath"])
            chromakey_color = (
                config.get("backgroundColor") or "#0f0f1a"
            )
            composited = await self._composite_over_video(
                visualizer_path=engine_output,
                bg_video_path=bg_video_path,
                chromakey_hex=chromakey_color,
                channel_id=channel_id,
                width=int(config.get("output_width", 1920)),
                height=int(config.get("output_height", 1080)),
                fps=int(config.get("output_fps", 30)),
                crf=int(config.get("crf", 23)),
            )
            self._report(on_progress, 1.0, "Done")
            # Reuse engine_result's duration (audio-derived) — composite
            # MP4 has identical length by design (we cap with `-shortest`).
            return {
                "filename": composited.name,
                "filepath": composited.relative_to(settings.assets_dir).as_posix(),
                "file_size": composited.stat().st_size,
                "duration": engine_result.get("duration", 0),
            }

        builder = _STYLE_BUILDERS.get(style)
        if builder is None:
            raise ValueError(
                f"Unsupported composition style '{style}'. "
                f"Expected one of: {', '.join(_STYLE_BUILDERS)}, spectrum"
            )

        if not image_filepaths:
            raise ValueError("At least one image filepath is required.")

        # --- 2. Resolve absolute paths ----------------------------------------
        audio_path = self._resolve_asset(music_filepath)
        image_path = self._resolve_asset(image_filepaths[0])

        # --- 3. Get audio duration (blocking I/O, run in executor) ------------
        self._report(on_progress, 0.0, "Probing audio duration...")
        duration = await asyncio.get_running_loop().run_in_executor(
            None,
            get_audio_duration,
            str(audio_path),
            settings.ffprobe_path,
        )
        logger.info("Audio duration: %.2f s", duration)

        # For loop style, the output duration is the target, not the audio length
        if style == "loop":
            duration = float(config.get("target_duration", 3600))
            logger.info("Loop target duration: %.0f s", duration)

        # --- 4. Generate output path ------------------------------------------
        # Build a meaningful filename so files on disk reflect the channel
        # context (e.g. "yomibeats_japanese-lofi_2026-05-04_a3f.mp4") instead
        # of an opaque hex blob.
        output_dir = get_asset_dir(channel_id, "composed")
        filename = await self._build_filename(channel_id, suffix=style)
        output_path = output_dir / filename

        # --- 5. Build FFmpeg command ------------------------------------------
        self._report(on_progress, 0.0, "Building FFmpeg command...")
        cmd = builder(
            image_path=str(image_path),
            audio_path=str(audio_path),
            output_path=str(output_path),
            config=config,
        )
        logger.info("FFmpeg command: %s", " ".join(cmd))

        # --- 6. Run FFmpeg via subprocess.Popen in a thread executor ----------
        #     asyncio.create_subprocess_exec raises NotImplementedError on
        #     Windows + Python 3.9 (SelectorEventLoop).  Using Popen in a
        #     background thread avoids the issue entirely.
        self._report(on_progress, 0.0, "Starting FFmpeg...")
        loop = asyncio.get_running_loop()
        return_code, stderr_lines = await loop.run_in_executor(
            None,
            partial(
                self._run_ffmpeg_sync,
                cmd=cmd,
                duration=duration,
                on_progress=on_progress,
            ),
        )

        # --- 7. Check return code ---------------------------------------------
        if return_code != 0:
            stderr_text = "\n".join(stderr_lines[-50:])  # last 50 lines
            logger.error(
                "FFmpeg exited with code %d. stderr:\n%s",
                return_code,
                stderr_text,
            )
            raise ComposeError(
                f"FFmpeg exited with code {return_code}:\n{stderr_text}"
            )

        # --- 8. Gather output metadata ----------------------------------------
        if not output_path.exists():
            raise ComposeError(
                "FFmpeg reported success but no output file was created."
            )

        file_size = output_path.stat().st_size
        relative_path = output_path.relative_to(settings.assets_dir).as_posix()

        self._report(on_progress, 1.0, "Composition complete.")
        logger.info(
            "Composed video: %s (%.2f s, %d bytes)",
            relative_path,
            duration,
            file_size,
        )

        return {
            "filepath": relative_path,
            "filename": filename,
            "duration": duration,
            "file_size": file_size,
        }

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _run_ffmpeg_sync(
        self,
        cmd: list[str],
        duration: float,
        on_progress: Optional[Callable[[float, str], None]],
    ) -> tuple:
        """Run FFmpeg synchronously (called from a thread executor).

        Returns ``(return_code, stderr_lines)``.

        FFmpeg writes progress stats to stderr using ``\\r`` (carriage return)
        to overwrite the current line.  A naive ``readline()`` blocks until a
        ``\\n`` appears, which may only happen once encoding completes.  We
        therefore read raw bytes in small chunks and split on both ``\\r`` and
        ``\\n`` so that progress updates are parsed in real time.
        """
        # On Windows, hide the console window that would otherwise pop up
        startupinfo = None
        if sys.platform == "win32":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0  # SW_HIDE

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
        )

        # Register with the per-task process registry so the cancel
        # endpoint can hard-kill this ffmpeg if the operator clicks
        # Stop. Auto-no-op when there's no current task_id (ad-hoc
        # script use). Unregistered in the finally block below.
        from app.services.process_registry import register as _register_proc, unregister as _unregister_proc
        _register_proc(process, label="ffmpeg")

        stderr_lines: list[str] = []
        assert process.stderr is not None

        # Use the raw (unbuffered) stream so read() returns whatever
        # bytes are immediately available instead of waiting to fill
        # an internal buffer.  This is critical for real-time progress.
        raw_stderr = process.stderr.raw  # type: ignore[union-attr]

        buf = b""
        last_reported = -1.0  # avoid spamming identical updates
        while True:
            chunk = raw_stderr.read(4096)
            if not chunk:
                break
            buf += chunk
            # Split on both \r and \n so we catch FFmpeg's in-place updates
            while b"\r" in buf or b"\n" in buf:
                # Find the earliest separator
                idx_r = buf.find(b"\r")
                idx_n = buf.find(b"\n")
                if idx_r == -1:
                    idx = idx_n
                elif idx_n == -1:
                    idx = idx_r
                else:
                    idx = min(idx_r, idx_n)

                raw_line = buf[:idx]
                buf = buf[idx + 1:]
                line = raw_line.decode("utf-8", errors="replace").strip()
                if not line:
                    continue
                stderr_lines.append(line)

                current_time = self._parse_ffmpeg_time(line)
                if current_time is not None and duration > 0:
                    fraction = min(current_time / duration, 1.0)
                    # Only report when progress changes by ≥0.5%
                    if fraction - last_reported >= 0.005:
                        last_reported = fraction
                        self._report(
                            on_progress,
                            fraction,
                            f"Encoding... {fraction:.0%}",
                        )

        # Process any remaining buffer content
        if buf:
            line = buf.decode("utf-8", errors="replace").strip()
            if line:
                stderr_lines.append(line)

        try:
            process.wait()
        finally:
            # Remove from registry regardless of how it exited (success,
            # error, or hard-killed by the cancel endpoint). Idempotent.
            _unregister_proc(process)
        return (process.returncode, stderr_lines)

    def _parse_ffmpeg_time(self, line: str) -> Optional[float]:
        """Parse ``time=HH:MM:SS.ms`` from an FFmpeg stderr line.

        Returns the timestamp in seconds, or ``None`` if the pattern is
        not found.
        """
        match = _TIME_RE.search(line)
        if match is None:
            return None
        hours = int(match.group(1))
        minutes = int(match.group(2))
        seconds = int(match.group(3))
        # The fractional part may be 2 or 3 digits (centiseconds or milliseconds)
        frac_str = match.group(4)
        if len(frac_str) == 2:
            fraction = int(frac_str) / 100.0
        else:
            fraction = int(frac_str) / 1000.0
        return hours * 3600 + minutes * 60 + seconds + fraction

    async def _composite_over_video(
        self,
        *,
        visualizer_path: Path,
        bg_video_path: Path,
        chromakey_hex: str,
        channel_id: int,
        width: int,
        height: int,
        fps: int,
        crf: int,
    ) -> Path:
        """Overlay the visualizer MP4 onto a looping background video.

        Pipeline:
        1. Bg video is fed in with ``-stream_loop -1`` so a 30s loop fills
           a 1-hour audio track without truncating.
        2. Both inputs are scaled + padded to (width × height) so they
           composite at exactly the same dimensions, regardless of the
           source video's aspect ratio.
        3. The visualizer's solid-fill background colour is removed via
           ``colorkey`` (similarity 0.10, blend 0.05 — empirically tight
           enough that typical particle/text colours survive).
        4. The keyed visualizer is overlaid on the bg video, giving the
           "video-as-canvas" look.
        5. ``-shortest`` caps output to the visualizer's length (it
           already matches the audio); without this we'd loop the bg
           forever.

        Output goes to the channel's composed/ directory with a fresh
        filename so it doesn't clobber the engine's intermediate output
        (which gets garbage-collected when its parent process exits).
        Returns the absolute path of the composited file.
        """
        # The chromakey hex must be in the form 0xRRGGBB for ffmpeg.
        # ``backgroundColor`` from the editor stores ``#0f0f1a`` style.
        cleaned = chromakey_hex.lstrip("#").strip()
        if len(cleaned) == 3:
            cleaned = "".join(ch * 2 for ch in cleaned)
        if len(cleaned) != 6:
            cleaned = "0f0f1a"  # safe default — near-black, rarely collides
        ffmpeg_color = f"0x{cleaned}"

        # Output destination — channel-aware filename, ``_video_bg`` suffix
        # so it's distinguishable from regular renders in the composed/
        # directory if the user spelunks on disk.
        output_dir = get_asset_dir(channel_id, "composed")
        output_dir.mkdir(parents=True, exist_ok=True)
        out_filename = await self._build_filename(channel_id, suffix="video_bg")
        output_path = output_dir / out_filename

        scale = f"scale={width}:{height}:force_original_aspect_ratio=decrease"
        pad = f"pad={width}:{height}:(ow-iw)/2:(oh-ih)/2"

        # Filter graph:
        #   [0]  bg video   → [bg]   scale + pad to W×H
        #   [1]  visualizer → [fg]   scale + pad + colorkey out the bg colour
        #   [bg][fg]overlay → [v]    final
        filter_complex = (
            f"[0:v]{scale},{pad},setsar=1[bg];"
            f"[1:v]{scale},{pad},colorkey={ffmpeg_color}:0.10:0.05,setsar=1[fg];"
            f"[bg][fg]overlay=0:0:format=auto[v]"
        )

        cmd = [
            settings.ffmpeg_path,
            "-y",
            "-stream_loop", "-1",  # loop bg video to whatever length needed
            "-i", str(bg_video_path),
            "-i", str(visualizer_path),
            "-filter_complex", filter_complex,
            "-map", "[v]",
            "-map", "1:a?",  # audio from the visualizer (which has the music)
            "-c:v", "libx264",
            "-preset", "veryfast",
            "-pix_fmt", "yuv420p",
            "-crf", str(crf),
            "-r", str(fps),
            "-c:a", "copy",  # don't re-encode the visualizer's AAC track
            "-shortest",
            str(output_path),
        ]

        logger.info(
            "Compose: post-process overlay running %s",
            " ".join(str(c) for c in cmd),
        )

        # Run blocking ffmpeg in a thread so the event loop stays alive.
        loop = asyncio.get_running_loop()
        proc_result = await loop.run_in_executor(
            None,
            partial(
                subprocess.run,
                cmd,
                capture_output=True,
                check=False,
            ),
        )

        if proc_result.returncode != 0:
            stderr_tail = (proc_result.stderr or b"").decode(
                "utf-8", errors="replace",
            )[-1500:]
            raise ComposeError(
                f"Video-bg composite failed (rc={proc_result.returncode}): "
                f"{stderr_tail}"
            )

        if not output_path.exists() or output_path.stat().st_size == 0:
            raise ComposeError(
                f"Video-bg composite produced no output at {output_path}"
            )

        return output_path

    @staticmethod
    def _resolve_asset(relative_path: str) -> Path:
        """Resolve a relative asset path to an absolute path and verify it exists."""
        full_path = settings.assets_dir / relative_path
        if not full_path.exists():
            raise FileNotFoundError(
                f"Asset file not found: {full_path}"
            )
        return full_path

    @staticmethod
    async def _build_filename(channel_id: int, suffix: str = "") -> str:
        """Generate a channel-aware video filename.

        Looks up the channel's name + niche + first default tag and
        produces something like ``yomibeats_japanese-lofi_2026-05-04_a3f.mp4``.
        Falls back to a generic name if the channel can't be loaded.
        """
        from app.database import async_session
        from app.models import Channel
        try:
            async with async_session() as session:
                ch = await session.get(Channel, channel_id)
                if ch:
                    return build_video_filename(
                        channel_name=ch.name,
                        niche=ch.niche,
                        default_tags=ch.default_tags,
                        suffix=suffix,
                    )
        except Exception as e:
            logger.warning("Could not look up channel %d for filename: %s", channel_id, e)
        return build_video_filename(
            channel_name=f"channel-{channel_id}",
            suffix=suffix,
        )

    @staticmethod
    def _report(
        callback: Optional[Callable[[float, str], None]],
        fraction: float,
        message: str,
    ) -> None:
        """Invoke the progress callback if one was provided."""
        if callback is not None:
            try:
                callback(fraction, message)
            except Exception:
                logger.warning(
                    "Progress callback raised an exception",
                    exc_info=True,
                )

    # ------------------------------------------------------------------
    # Extend an existing composed video by looping it to a target duration
    # ------------------------------------------------------------------

    async def extend_video(
        self,
        channel_id: int,
        source_filepath: str,
        target_duration_seconds: int,
        snap_to_song: bool = False,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> dict:
        """Loop an already-composed video to reach ``target_duration_seconds``.

        Uses FFmpeg's concat demuxer with ``-c copy`` so video and audio
        bitstreams are spliced without re-encoding — typically completes in
        seconds for any input size.

        When ``snap_to_song`` is True, the output duration is rounded DOWN
        to a whole multiple of the source video duration so the last loop
        completes naturally — no songs get cut mid-track. Operator
        confusion (2026-05-17): with this on, asking for 2h20m against a
        62min source produced 2h04m output (2 × 62min, snapped down).
        Default is now False — the output matches the requested target
        exactly. Operator who wants song-clean boundaries uses the
        frontend's "Snap to nearest track end" button + per-track-end
        snap markers to pick a target that's already on a boundary,
        then the exact-target path delivers what they picked.

        Returns ``{filepath, filename, duration, file_size}`` (same shape as
        ``compose_video``) so callers can swap it in as the new
        composed_asset.
        """
        if target_duration_seconds <= 0:
            raise ValueError("target_duration_seconds must be > 0")

        loop = asyncio.get_running_loop()
        source_abs = self._resolve_asset(source_filepath)

        self._report(on_progress, 0.05, "Probing source duration...")
        source_duration = await loop.run_in_executor(
            None, get_audio_duration, str(source_abs), settings.ffprobe_path,
        )
        if source_duration <= 0:
            raise ComposeError(f"Could not probe source duration: {source_abs}")

        import math
        if snap_to_song:
            # Round DOWN to a whole multiple of the source duration so songs
            # always finish. If target < source_duration, fall back to a
            # single copy (we can't snap below one loop).
            repeats = max(1, math.floor(target_duration_seconds / source_duration))
            output_duration = repeats * source_duration
        else:
            repeats = max(1, math.ceil(target_duration_seconds / source_duration))
            output_duration = target_duration_seconds
        logger.info(
            "extend_video: source=%.1fs target=%ds snap=%s → %d copies, output=%.1fs",
            source_duration, target_duration_seconds, snap_to_song, repeats, output_duration,
        )

        # Output paths — channel-context filename (matches compose_video).
        output_dir = get_asset_dir(channel_id, "composed")
        filename = await self._build_filename(channel_id, suffix="extended")
        output_path = output_dir / filename

        # Concat demuxer needs a list file. The path inside must use forward
        # slashes (and be quoted) so it parses on Windows.
        concat_list_path = output_path.with_suffix(".concat.txt")
        # Escape single quotes in the path per FFmpeg concat demuxer rules
        src_for_list = str(source_abs).replace("\\", "/").replace("'", "'\\''")
        concat_list_path.parent.mkdir(parents=True, exist_ok=True)
        with open(concat_list_path, "w", encoding="utf-8") as fh:
            for _ in range(repeats):
                fh.write(f"file '{src_for_list}'\n")

        # When snapping, we feed exactly `repeats` copies and emit the full
        # concatenation (no -t trim). When not snapping, we trim to the user's
        # exact target with -t.
        cmd = [
            settings.ffmpeg_path,
            "-y",
            "-hide_banner",
            "-loglevel", "error",
            "-f", "concat",
            "-safe", "0",
            "-i", str(concat_list_path),
        ]
        if not snap_to_song:
            cmd += ["-t", str(target_duration_seconds)]
        cmd += [
            "-c", "copy",
            "-movflags", "+faststart",
            str(output_path),
        ]
        logger.info("extend_video: %s", " ".join(cmd))

        self._report(on_progress, 0.10, f"Concatenating {repeats}× and trimming to target...")

        # No real progress reporting from -c copy concat (it's near-instant);
        # just wait for it to finish in a thread.
        return_code, stderr_lines = await loop.run_in_executor(
            None,
            partial(self._run_ffmpeg_sync, cmd=cmd, duration=float(output_duration), on_progress=on_progress),
        )

        # Clean up the temp concat list
        try:
            concat_list_path.unlink()
        except OSError:
            pass

        if return_code != 0:
            stderr_text = "\n".join(stderr_lines[-30:])
            raise ComposeError(
                f"FFmpeg extend exited with code {return_code}:\n{stderr_text}",
            )
        if not output_path.exists():
            raise ComposeError("FFmpeg succeeded but output file is missing.")

        file_size = output_path.stat().st_size
        relative_path = output_path.relative_to(settings.assets_dir).as_posix()
        self._report(on_progress, 1.0, "Extension complete.")
        logger.info(
            "extend_video done: %s (%.1fs, %d bytes)",
            relative_path, output_duration, file_size,
        )

        return {
            "filepath": relative_path,
            "filename": filename,
            "duration": float(output_duration),
            "file_size": file_size,
        }


# Singleton instance
compose_service = ComposeService()
