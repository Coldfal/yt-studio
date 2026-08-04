"""Python interface to the Node.js visualizer engine sidecar.

This service spawns ``backend/visualizer_engine/dist/cli.js`` as a one-shot
subprocess to render a Trap Nation / Specterr-style audio-reactive MP4.
It streams NDJSON progress events from the sidecar's stdout and forwards
them to the existing ``on_progress(fraction, message)`` callback shape.

Replaces the old ``spectrum_visualizer_service`` (Pillow/numpy) — the Node
engine gives us 15 presets, richer customization, and renders that exactly
match the in-browser preview.
"""

from __future__ import annotations

import json
import logging
import os
import shutil
import subprocess
import sys
import threading
from functools import partial
from pathlib import Path
from typing import Any, Callable, Optional
from uuid import uuid4

from app.config import settings
from app.utils.file_utils import get_asset_dir, build_video_filename

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Progress stage → (fraction, message) mapping
# ---------------------------------------------------------------------------

_STAGE_BASE_FRACTION: dict[str, float] = {
    "analysing_audio": 0.05,
    "loading_assets": 0.10,
    "encoding": 0.95,
    "done": 1.0,
}


def _map_progress(event: dict[str, Any]) -> Optional[tuple[float, str]]:
    """Convert an NDJSON stage event to a ``(fraction, message)`` tuple.

    Returns ``None`` if the event shouldn't update the progress bar
    (e.g. informational events without a stage mapping).
    """
    stage = event.get("stage")
    if stage == "rendering":
        frame = event.get("frame")
        total = event.get("frameCount")
        if isinstance(frame, int) and isinstance(total, int) and total > 0:
            # Render consumes the 0.10 → 0.95 band.
            fraction = 0.10 + 0.85 * (frame / total)
            rate = event.get("fps")
            eta = event.get("etaSec")
            if isinstance(rate, (int, float)) and isinstance(eta, (int, float)):
                msg = f"Rendering frame {frame}/{total} ({rate:.1f} fps, ETA {eta:.0f}s)"
            else:
                msg = f"Rendering frame {frame}/{total}"
            return (fraction, msg)
        return (0.10, "Rendering...")

    if stage in _STAGE_BASE_FRACTION:
        fraction = _STAGE_BASE_FRACTION[stage]
        if stage == "analysing_audio":
            track_count = event.get("trackCount", 1)
            return (fraction, f"Analysing audio ({track_count} track{'s' if track_count != 1 else ''})...")
        if stage == "loading_assets":
            return (fraction, "Loading assets...")
        if stage == "encoding":
            return (fraction, "Encoding MP4...")
        if stage == "done":
            return (fraction, "Complete.")
    return None


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class VisualizerEngineError(RuntimeError):
    """Raised when the visualizer engine sidecar fails."""


class VisualizerEngineService:
    """Renders audio-reactive videos by delegating to the Node.js sidecar."""

    def __init__(self) -> None:
        # Repo root → backend/visualizer_engine
        backend_root = Path(__file__).resolve().parents[2]
        self.engine_root: Path = backend_root / "visualizer_engine"
        self.cli_js: Path = self.engine_root / "dist" / "cli.js"

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def render_video(
        self,
        channel_id: int,
        music_filepaths: list[str],
        image_filepath: Optional[str] = None,
        logo_filepath: Optional[str] = None,
        overlay_filepath: Optional[str] = None,
        config: Optional[dict] = None,
        preset_id: str = "trap-nation",
        width: int = 1920,
        height: int = 1080,
        fps: int = 30,
        crf: int = 23,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> dict:
        """Render an audio-reactive visualizer video.

        Parameters
        ----------
        channel_id:
            Which channel the output belongs to (determines output directory).
        music_filepaths:
            One or more audio files relative to ``settings.assets_dir``.
            Multiple files are concatenated by the engine.
        image_filepath:
            Background image, relative to ``settings.assets_dir``. Optional.
        logo_filepath:
            Center logo image, relative to ``settings.assets_dir``. Optional.
        overlay_filepath:
            Corner overlay image, relative to ``settings.assets_dir``. Optional.
        config:
            Partial ``ProjectConfig`` dict (see the MV ``types.ts``).
        preset_id:
            One of the 15 preset IDs (e.g. "trap-nation", "radial-waveform", …).
        width, height, fps, crf:
            Output video settings.
        on_progress:
            Synchronous callback invoked with ``(fraction, message)``.

        Returns
        -------
        dict
            ``{"filepath": <relative>, "filename": str, "duration": float,
               "file_size": int}``.
        """
        if not music_filepaths:
            raise ValueError("At least one music filepath is required.")

        import asyncio

        # Resolve all paths relative to assets_dir
        abs_audio = [self._resolve_asset(p, required=True) for p in music_filepaths]
        abs_bg = self._resolve_asset(image_filepath) if image_filepath else None
        abs_logo = self._resolve_asset(logo_filepath) if logo_filepath else None
        abs_overlay = self._resolve_asset(overlay_filepath) if overlay_filepath else None

        # Generate output path — channel-aware filename so files on disk
        # reflect the niche / brand instead of an opaque hex blob.
        # Examples:
        #   yomibeats_japanese-lofi_2026-05-04_a3f.mp4
        #   techno-house_music_2026-05-04_b81.mp4
        output_dir = get_asset_dir(channel_id, "composed")
        try:
            from app.database import async_session
            from app.models import Channel
            async with async_session() as session:
                ch = await session.get(Channel, channel_id)
                filename = build_video_filename(
                    channel_name=ch.name if ch else f"channel-{channel_id}",
                    niche=ch.niche if ch else None,
                    default_tags=ch.default_tags if ch else None,
                    suffix="spectrum",
                )
        except Exception:
            filename = build_video_filename(
                channel_name=f"channel-{channel_id}",
                suffix="spectrum",
            )
        output_path = output_dir / filename

        # Write the job config to a temp JSON file under assets/_tmp/
        tmp_dir = settings.assets_dir / "_tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        job_path = tmp_dir / f"viz-{uuid4().hex}.json"

        job = {
            "config": config or {},
            "presetId": preset_id,
            "audioPaths": [str(p) for p in abs_audio],
            "logoPath": str(abs_logo) if abs_logo else None,
            "backgroundPath": str(abs_bg) if abs_bg else None,
            "overlayPath": str(abs_overlay) if abs_overlay else None,
            "width": width,
            "height": height,
            "fps": fps,
            "crf": crf,
        }
        with open(job_path, "w", encoding="utf-8") as fh:
            json.dump(job, fh)

        # Log a summary of the dispatched job — paths + key flags — so
        # render bugs (missing bg, particles silently off, wrong preset)
        # can be debugged from the backend log without re-running.
        logger.info(
            "Visualizer job dispatched: bg=%s overlay=%s logo=%s preset=%s "
            "fps=%d particles=%s viz_disabled=%s",
            abs_bg, abs_overlay, abs_logo, preset_id, fps,
            (config or {}).get("particles"),
            (config or {}).get("visualizer_disabled"),
        )
        try:
            loop = asyncio.get_running_loop()
            result = await loop.run_in_executor(
                None,
                partial(
                    self._run_sidecar_sync,
                    job_path=job_path,
                    output_path=output_path,
                    on_progress=on_progress,
                ),
            )
        finally:
            # Clean up the temp config file
            try:
                job_path.unlink()
            except OSError:
                pass

        if not output_path.exists():
            raise VisualizerEngineError(
                "Visualizer engine reported success but produced no output file."
            )

        file_size = output_path.stat().st_size
        relative_path = output_path.relative_to(settings.assets_dir).as_posix()

        if on_progress is not None:
            on_progress(1.0, "Complete.")

        logger.info(
            "Visualizer render complete: %s (%.2f s, %d bytes, preset=%s)",
            relative_path,
            result.get("durationSec", 0.0),
            file_size,
            preset_id,
        )

        return {
            "filepath": relative_path,
            "filename": filename,
            "duration": float(result.get("durationSec", 0.0)),
            "file_size": file_size,
        }

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _run_sidecar_sync(
        self,
        *,
        job_path: Path,
        output_path: Path,
        on_progress: Optional[Callable[[float, str], None]],
    ) -> dict:
        """Spawn the Node CLI, stream NDJSON progress, return the ``done`` event.

        Runs in a thread executor because asyncio.create_subprocess_exec
        is not available on Windows with the SelectorEventLoop policy that
        this project uses (Python 3.9).
        """
        node_bin = self._resolve_node()
        self._ensure_cli_built()

        cmd = [
            node_bin,
            str(self.cli_js),
            "--config", str(job_path),
            "--output", str(output_path),
        ]

        logger.info("Launching visualizer engine: %s", " ".join(cmd))

        # Hide console on Windows
        startupinfo = None
        if sys.platform == "win32":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0

        # Default to NVENC for the H264 encode step. The visualizer engine's
        # ``chooseEncoder()`` (exporter.ts) reads ``VIZWAVE_ENCODER`` and only
        # uses the requested encoder after probing ``ffmpeg -encoders`` for
        # availability — so if NVENC isn't actually usable at runtime (no
        # NVIDIA GPU, missing driver, mismatched ffmpeg build) it transparently
        # falls back to ``libx264 -preset veryfast``. No try/except needed here.
        # Respects an explicit env override so devs can force libx264 for A/B
        # testing or h264_qsv on Intel boxes.
        child_env = os.environ.copy()
        child_env.setdefault("VIZWAVE_ENCODER", "h264_nvenc")
        logger.info("VIZWAVE_ENCODER=%s", child_env["VIZWAVE_ENCODER"])

        process = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            stdin=subprocess.DEVNULL,
            startupinfo=startupinfo,
            bufsize=1,
            universal_newlines=True,
            env=child_env,
        )

        # Register the node sidecar with the per-task process registry
        # so the cancel endpoint can hard-kill it. ContextVar reads the
        # current task_id automatically — registration is a no-op when
        # called outside a task handler chain. Unregistered in the
        # finally block at the end of this method.
        from app.services.process_registry import (
            register as _register_proc, unregister as _unregister_proc,
        )
        _register_proc(process, label="visualizer-engine")

        assert process.stdout is not None
        assert process.stderr is not None

        # Drain stderr on a background thread so it doesn't block the pipe.
        stderr_lines: list[str] = []

        def _drain_stderr() -> None:
            try:
                for line in process.stderr:  # type: ignore[union-attr]
                    line = line.rstrip()
                    if line:
                        stderr_lines.append(line)
                        logger.debug("[visualizer-engine stderr] %s", line)
            except Exception:
                pass

        err_thread = threading.Thread(target=_drain_stderr, daemon=True)
        err_thread.start()

        # Parse NDJSON progress from stdout
        done_event: Optional[dict] = None
        error_event: Optional[dict] = None
        for line in process.stdout:
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                logger.warning("Non-JSON line from visualizer engine: %s", line)
                continue

            stage = event.get("stage")
            if stage == "done":
                done_event = event
            elif stage == "error":
                error_event = event

            # Forward to progress callback
            mapped = _map_progress(event)
            if mapped is not None and on_progress is not None:
                try:
                    on_progress(*mapped)
                except Exception:
                    logger.warning(
                        "Progress callback raised an exception",
                        exc_info=True,
                    )

        try:
            return_code = process.wait()
        finally:
            # Remove from per-task registry whether we exited cleanly,
            # errored, or got SIGTERM'd by the cancel endpoint.
            _unregister_proc(process)
        err_thread.join(timeout=2.0)

        if return_code != 0 or error_event is not None:
            msg = (error_event or {}).get("error", "unknown error")
            stderr_tail = "\n".join(stderr_lines[-20:])
            raise VisualizerEngineError(
                f"Visualizer engine exited with code {return_code}: {msg}\n"
                f"stderr tail:\n{stderr_tail}"
            )

        if done_event is None:
            stderr_tail = "\n".join(stderr_lines[-20:])
            raise VisualizerEngineError(
                f"Visualizer engine exited {return_code} with no 'done' event.\n"
                f"stderr tail:\n{stderr_tail}"
            )

        return done_event

    def _resolve_node(self) -> str:
        """Find the Node binary. Respects ``settings.node_path`` if set."""
        configured = getattr(settings, "node_path", "")
        if configured:
            return str(configured)
        which = shutil.which("node")
        if not which:
            raise VisualizerEngineError(
                "Node.js not found on PATH. Install Node 20 LTS or set "
                "YTS_NODE_PATH to the node binary."
            )
        return which

    def _ensure_cli_built(self) -> None:
        """Raise a clear error if ``dist/cli.js`` hasn't been built yet."""
        if not self.cli_js.exists():
            raise VisualizerEngineError(
                f"Visualizer engine CLI not built ({self.cli_js} missing). "
                f"Run:  cd {self.engine_root}  &&  npm install  &&  npm run build"
            )

    @staticmethod
    def _resolve_asset(relative_path: str, required: bool = False) -> Optional[Path]:
        """Resolve a path relative to ``settings.assets_dir``.

        Absolute paths are passed through as-is (used by the compose
        service for built-in assets like the bundled Subscribe animation
        in ``data/builtin``).
        """
        if not relative_path:
            return None
        p = Path(relative_path)
        full = p if p.is_absolute() else (settings.assets_dir / relative_path)
        if not full.exists():
            if required:
                raise FileNotFoundError(f"Asset file not found: {full}")
            return None
        return full


# Singleton instance
visualizer_engine_service = VisualizerEngineService()
