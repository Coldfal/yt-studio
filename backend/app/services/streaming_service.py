from __future__ import annotations

import asyncio
import json
import logging
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List, Optional

from google.oauth2.credentials import Credentials

from app.config import settings
from app.database import async_session
from app.models.live_stream import LiveStream
from app.models.channel import Channel
from app.utils.audio import scan_audio_folder, merge_audio_files, get_audio_duration
from app.services.credentials_service import get_channel_youtube_credentials
from app.services.live_stream.ffmpeg_helpers import (
    build_ffmpeg_cmd,
    create_black_image,
    stop_ffmpeg,
)
from app.services.live_stream.youtube_live_api import (
    create_broadcast_and_stream,
    credentials_from_json,
    transition_broadcast_complete,
)

logger = logging.getLogger(__name__)


@dataclass
class StreamContext:
    """In-memory state for an active stream."""
    channel_id: int
    db_id: int
    process: subprocess.Popen
    broadcast_id: str
    stream_id: str
    started_at: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    monitor_task: Optional[asyncio.Task] = None


class StreamManager:
    """Manages long-running FFmpeg RTMP streams to YouTube Live."""

    def __init__(self) -> None:
        self._active: Dict[int, StreamContext] = {}  # channel_id -> context

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    async def start_stream(
        self,
        channel_id: int,
        title: str,
        description: str,
        target_duration_hours: float,
        *,
        music_folder_path: Optional[str] = None,
        use_channel_music_assets: bool = False,
        image_path: Optional[str] = None,
        image_asset_id: Optional[int] = None,
        use_visualizer: bool = False,
        visualizer_config: Optional[Dict[str, Any]] = None,
        visualizer_preset_id: Optional[str] = None,
        composed_asset_id: Optional[int] = None,
    ) -> int:
        """Start a live stream. Returns the LiveStream DB id."""
        if channel_id in self._active:
            raise ValueError(f"Channel {channel_id} already has an active stream")

        # Validate that ONE source is specified.
        if composed_asset_id is not None:
            pass  # streaming a pre-rendered MP4 — no music source needed
        elif not music_folder_path and not use_channel_music_assets:
            raise ValueError(
                "Provide composed_asset_id, music_folder_path, or use_channel_music_assets=True",
            )

        async with async_session() as db:
            channel = await db.get(Channel, channel_id)
            if not channel:
                raise ValueError(f"Channel {channel_id} not found")
            if not channel.youtube_credentials_json:
                raise ValueError(f"Channel {channel_id} has no YouTube credentials")

            creds_json = await get_channel_youtube_credentials(db, channel_id)
            if creds_json is None:
                raise ValueError(
                    f"Channel {channel_id} YouTube credentials are unreadable"
                )

            # Create DB record. music_folder_path was historically NOT NULL;
            # coerce to "" when the channel-asset-library mode doesn't need it.
            stream = LiveStream(
                channel_id=channel_id,
                status="preparing",
                title=title,
                description=description,
                image_path=image_path,
                image_asset_id=image_asset_id,
                music_folder_path=music_folder_path or "",
                use_channel_music_assets=use_channel_music_assets,
                target_duration_hours=target_duration_hours,
                use_visualizer=use_visualizer,
                visualizer_config=visualizer_config,
                visualizer_preset_id=visualizer_preset_id,
                composed_asset_id=composed_asset_id,
            )
            db.add(stream)
            await db.commit()
            await db.refresh(stream)
            db_id = stream.id

        # Run the heavy setup in a background task
        asyncio.create_task(self._setup_and_launch(db_id, channel_id, creds_json))
        return db_id

    async def stop_stream(self, stream_id: int) -> None:
        """Stop a running stream by DB id."""
        async with async_session() as db:
            stream = await db.get(LiveStream, stream_id)
            if not stream:
                raise ValueError(f"Stream {stream_id} not found")

            ctx = self._active.get(stream.channel_id)
            if not ctx or ctx.db_id != stream_id:
                # Not running — just mark stopped
                stream.status = "stopped"
                stream.stopped_at = datetime.now(timezone.utc)
                await db.commit()
                return

            stream.status = "stopping"
            await db.commit()

        # Gracefully stop FFmpeg
        await self._stop_ffmpeg(ctx)

        # Cancel monitor
        if ctx.monitor_task and not ctx.monitor_task.done():
            ctx.monitor_task.cancel()

        # Transition YouTube broadcast to complete
        try:
            await self._transition_broadcast_complete(stream_id)
        except Exception as e:
            logger.warning("Failed to transition broadcast to complete: %s", e)

        # Update DB
        async with async_session() as db:
            stream = await db.get(LiveStream, stream_id)
            if stream:
                stream.status = "stopped"
                stream.stopped_at = datetime.now(timezone.utc)
                stream.ffmpeg_pid = None
                await db.commit()

        self._active.pop(ctx.channel_id, None)
        logger.info("Stream %d stopped for channel %d", stream_id, ctx.channel_id)

        # Broadcast status via SSE
        self._broadcast_status(stream_id, ctx.channel_id, "stopped")

    async def stop_all(self) -> None:
        """Stop all active streams (called on shutdown)."""
        for channel_id in list(self._active.keys()):
            ctx = self._active[channel_id]
            try:
                await self.stop_stream(ctx.db_id)
            except Exception as e:
                logger.warning("Error stopping stream %d: %s", ctx.db_id, e)

    async def recover_on_startup(self) -> None:
        """Mark any 'live' or 'starting' streams as failed (process is gone)."""
        async with async_session() as db:
            from sqlalchemy import select, update
            stmt = (
                update(LiveStream)
                .where(LiveStream.status.in_(["preparing", "starting", "live"]))
                .values(status="failed", error="Server restarted",
                        stopped_at=datetime.now(timezone.utc))
            )
            result = await db.execute(stmt)
            await db.commit()
            if result.rowcount > 0:
                logger.info("Marked %d orphaned streams as failed", result.rowcount)

    def get_active_channels(self) -> List[int]:
        """Return list of channel IDs with active streams."""
        return list(self._active.keys())

    # ------------------------------------------------------------------
    # Internal pipeline
    # ------------------------------------------------------------------

    async def _setup_and_launch(
        self,
        db_id: int,
        channel_id: int,
        creds_json: str,
    ) -> None:
        """Full setup pipeline: resolve assets → create broadcast → launch encoder.

        Config is read from the LiveStream row which was already persisted by
        ``start_stream``. Branches between the legacy static-image FFmpeg
        pipeline and the visualizer-engine RTMP pipeline based on
        ``stream.use_visualizer``.
        """
        try:
            self._broadcast_status(db_id, channel_id, "preparing")
            loop = asyncio.get_running_loop()

            # ─── 1. Load stream config from DB ────────────────────
            async with async_session() as db:
                stream = await db.get(LiveStream, db_id)
                if not stream:
                    raise RuntimeError(f"LiveStream {db_id} vanished")
                title = stream.title
                description = stream.description or ""
                music_folder_path = stream.music_folder_path
                use_channel_music_assets = stream.use_channel_music_assets
                image_path = stream.image_path
                image_asset_id = stream.image_asset_id
                target_duration_hours = stream.target_duration_hours
                use_visualizer = stream.use_visualizer
                visualizer_config = stream.visualizer_config or {}
                visualizer_preset_id = stream.visualizer_preset_id or "trap-nation"
                composed_asset_id = stream.composed_asset_id

            # ─── Short path: pre-composed MP4 ─────────────────────
            if composed_asset_id is not None:
                await self._launch_composed_stream(
                    db_id=db_id,
                    channel_id=channel_id,
                    creds_json=creds_json,
                    composed_asset_id=composed_asset_id,
                    title=title,
                    description=description,
                    target_duration_hours=target_duration_hours,
                )
                return

            # ─── 2. Resolve the audio pool ────────────────────────
            target_seconds = target_duration_hours * 3600
            audio_abs_paths: List[Path] = []
            track_names: List[str] = []
            total_dur = 0.0

            if use_channel_music_assets:
                # Pull the channel's imported music assets from the DB and
                # shuffle-select up to target length.
                from app.models import Asset
                from sqlalchemy import select
                async with async_session() as db:
                    result = await db.execute(
                        select(Asset).where(
                            Asset.channel_id == channel_id,
                            Asset.asset_type == "music",
                        )
                    )
                    assets = list(result.scalars().all())
                if not assets:
                    raise ValueError(
                        f"Channel {channel_id} has no music assets. Import some first.",
                    )
                import random
                random.shuffle(assets)
                for a in assets:
                    abs_p = settings.assets_dir / a.filepath
                    if not abs_p.exists():
                        continue
                    dur = float(a.duration_seconds or 0.0)
                    if dur <= 0:
                        # Probe it now as a fallback
                        try:
                            dur = await loop.run_in_executor(
                                None, get_audio_duration, str(abs_p),
                            )
                        except Exception:
                            continue
                    audio_abs_paths.append(abs_p)
                    track_names.append(a.title or a.filename)
                    total_dur += dur
                    if total_dur >= target_seconds:
                        break
            else:
                # Legacy: scan a filesystem folder
                logger.info("Stream %d: scanning music folder %s", db_id, music_folder_path)
                files = await loop.run_in_executor(
                    None, scan_audio_folder, music_folder_path,
                    ["mp3", "wav", "flac", "ogg", "m4a"],
                )
                if not files:
                    raise ValueError(f"No audio files found in {music_folder_path}")
                import random
                random.shuffle(files)
                for f in files:
                    audio_abs_paths.append(Path(f["filepath"]))
                    track_names.append(f["filename"])
                    total_dur += f["duration_seconds"]
                    if total_dur >= target_seconds:
                        break

            if not audio_abs_paths:
                raise ValueError("No usable audio tracks found")

            logger.info("Stream %d: selected %d tracks (%.0f min)",
                        db_id, len(audio_abs_paths), total_dur / 60)

            # Update DB with track info
            async with async_session() as db:
                stream = await db.get(LiveStream, db_id)
                if stream:
                    stream.tracks_used = track_names
                    stream.total_audio_duration = total_dur
                    stream.status = "starting"
                    await db.commit()

            self._broadcast_status(db_id, channel_id, "starting")

            # ─── 3. Create YouTube broadcast + stream ─────────────
            creds_data = json.loads(creds_json)
            credentials = Credentials(
                token=creds_data.get("token"),
                refresh_token=creds_data.get("refresh_token"),
                token_uri=creds_data.get("token_uri", "https://oauth2.googleapis.com/token"),
                client_id=creds_data.get("client_id"),
                client_secret=creds_data.get("client_secret"),
                scopes=creds_data.get("scopes", [
                    "https://www.googleapis.com/auth/youtube",
                    "https://www.googleapis.com/auth/youtube.upload",
                ]),
            )

            broadcast_id, stream_yt_id, rtmp_url = await loop.run_in_executor(
                None,
                self._create_youtube_broadcast_and_stream,
                credentials, title, description,
            )
            logger.info("Stream %d: YouTube broadcast=%s stream=%s",
                        db_id, broadcast_id, stream_yt_id)

            async with async_session() as db:
                stream = await db.get(LiveStream, db_id)
                if stream:
                    stream.broadcast_id = broadcast_id
                    stream.stream_id = stream_yt_id
                    stream.rtmp_url = rtmp_url
                    await db.commit()

            # ─── 4. Resolve background image ──────────────────────
            img_abs: Optional[str] = None
            if image_asset_id is not None:
                from app.models import Asset
                async with async_session() as db:
                    ia = await db.get(Asset, image_asset_id)
                    if ia:
                        img_abs = str(settings.assets_dir / ia.filepath)
            if not img_abs and image_path:
                if Path(image_path).is_absolute():
                    img_abs = image_path
                else:
                    img_abs = str(settings.assets_dir / image_path)
                if not Path(img_abs).exists():
                    img_abs = None
            merged_dir = settings.assets_dir / str(channel_id) / "streaming"
            merged_dir.mkdir(parents=True, exist_ok=True)
            if not img_abs or not Path(img_abs).exists():
                img_abs = str(merged_dir / "stream_bg.png")
                self._create_black_image(img_abs, 1920, 1080)

            # ─── 5. Launch encoder (visualizer or static image) ───
            if use_visualizer:
                proc = await self._launch_visualizer_stream(
                    db_id=db_id,
                    rtmp_url=rtmp_url,
                    audio_paths=audio_abs_paths,
                    background_path=img_abs,
                    target_seconds=target_seconds,
                    total_audio_dur=total_dur,
                    visualizer_config=visualizer_config,
                    visualizer_preset_id=visualizer_preset_id,
                )
            else:
                # Legacy path: merge all audio to one file, static image FFmpeg
                merged_path = merged_dir / f"stream_{db_id}_audio.mp3"
                await loop.run_in_executor(
                    None, merge_audio_files, audio_abs_paths, merged_path,
                )
                cmd = self._build_ffmpeg_cmd(rtmp_url, str(merged_path), img_abs)
                logger.info("Stream %d: launching FFmpeg (static image)", db_id)
                startupinfo = None
                if sys.platform == "win32":
                    startupinfo = subprocess.STARTUPINFO()
                    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
                    startupinfo.wShowWindow = 0
                proc = subprocess.Popen(
                    cmd,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.PIPE,
                    startupinfo=startupinfo,
                )

            ctx = StreamContext(
                channel_id=channel_id,
                db_id=db_id,
                process=proc,
                broadcast_id=broadcast_id,
                stream_id=stream_yt_id,
            )
            self._active[channel_id] = ctx

            async with async_session() as db:
                stream = await db.get(LiveStream, db_id)
                if stream:
                    stream.status = "live"
                    stream.ffmpeg_pid = proc.pid
                    stream.started_at = datetime.now(timezone.utc)
                    await db.commit()

            self._broadcast_status(db_id, channel_id, "live")
            logger.info("Stream %d: LIVE (PID %d)", db_id, proc.pid)

            # 6. Start monitor task
            ctx.monitor_task = asyncio.create_task(self._monitor_process(ctx))

        except Exception as e:
            logger.error("Stream %d failed to start: %s", db_id, e, exc_info=True)
            async with async_session() as db:
                stream = await db.get(LiveStream, db_id)
                if stream:
                    stream.status = "failed"
                    stream.error = str(e)
                    stream.stopped_at = datetime.now(timezone.utc)
                    await db.commit()
            self._active.pop(channel_id, None)
            self._broadcast_status(db_id, channel_id, "failed")

    # ------------------------------------------------------------------
    # YouTube API helpers
    # ------------------------------------------------------------------

    def _create_youtube_broadcast_and_stream(
        self,
        credentials: Credentials,
        title: str,
        description: str,
    ) -> tuple[str, str, str]:
        """Thin delegator. See ``live_stream.youtube_live_api``."""
        return create_broadcast_and_stream(credentials, title, description)

    async def _transition_broadcast_complete(self, stream_id: int) -> None:
        """Transition the YouTube broadcast to 'complete'.

        Loads stream + credentials from the DB, then offloads the
        actual API call to ``live_stream.youtube_live_api``.
        """
        async with async_session() as db:
            stream = await db.get(LiveStream, stream_id)
            if not stream or not stream.broadcast_id:
                return
            channel = await db.get(Channel, stream.channel_id)
            if not channel or not channel.youtube_credentials_json:
                return

            creds_json = await get_channel_youtube_credentials(db, stream.channel_id)
            if creds_json is None:
                logger.warning(
                    "Cannot transition broadcast %s: channel %s creds unreadable",
                    stream.broadcast_id, stream.channel_id,
                )
                return
            credentials = credentials_from_json(creds_json)
            broadcast_id = stream.broadcast_id

        loop = asyncio.get_running_loop()
        await loop.run_in_executor(
            None, transition_broadcast_complete, credentials, broadcast_id,
        )

    # ------------------------------------------------------------------
    # FFmpeg
    # ------------------------------------------------------------------

    # ------------------------------------------------------------------
    # Pre-composed MP4 → RTMP launcher
    # ------------------------------------------------------------------

    async def _launch_composed_stream(
        self,
        *,
        db_id: int,
        channel_id: int,
        creds_json: str,
        composed_asset_id: int,
        title: str,
        description: str,
        target_duration_hours: float,
    ) -> None:
        """Stream a pre-rendered MP4 to YouTube Live.

        This is the most efficient mode — FFmpeg just re-multiplexes the
        existing video/audio bitstream and pushes it to RTMP at real-time
        pace. Negligible CPU. Loops indefinitely via ``-stream_loop -1``.
        """
        from app.models import Asset
        loop = asyncio.get_running_loop()

        # Resolve the composed asset
        async with async_session() as db:
            asset = await db.get(Asset, composed_asset_id)
            if not asset:
                raise ValueError(
                    f"Composed asset {composed_asset_id} not found",
                )
            composed_path = settings.assets_dir / asset.filepath
            if not composed_path.exists():
                raise ValueError(
                    f"Composed file missing on disk: {composed_path}",
                )
            asset_duration = float(asset.duration_seconds or 0.0)
            track_name = asset.title or asset.filename

            # Persist what we're streaming so the UI shows something sensible
            stream = await db.get(LiveStream, db_id)
            if stream:
                stream.tracks_used = [track_name]
                stream.total_audio_duration = asset_duration
                stream.status = "starting"
                await db.commit()

        self._broadcast_status(db_id, channel_id, "starting")

        # Create YouTube broadcast
        creds_data = json.loads(creds_json)
        credentials = Credentials(
            token=creds_data.get("token"),
            refresh_token=creds_data.get("refresh_token"),
            token_uri=creds_data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=creds_data.get("client_id"),
            client_secret=creds_data.get("client_secret"),
            scopes=creds_data.get("scopes", [
                "https://www.googleapis.com/auth/youtube",
                "https://www.googleapis.com/auth/youtube.upload",
            ]),
        )
        broadcast_id, stream_yt_id, rtmp_url = await loop.run_in_executor(
            None,
            self._create_youtube_broadcast_and_stream,
            credentials, title, description,
        )
        async with async_session() as db:
            stream = await db.get(LiveStream, db_id)
            if stream:
                stream.broadcast_id = broadcast_id
                stream.stream_id = stream_yt_id
                stream.rtmp_url = rtmp_url
                await db.commit()

        # Cap stream duration at target; -1 means loop forever.
        target_seconds = int(target_duration_hours * 3600)

        cmd: List[str] = [
            settings.ffmpeg_path,
            "-re",                    # real-time pacing (essential for live)
            "-stream_loop", "-1",     # loop the input until -t or we kill it
            "-i", str(composed_path),
            "-t", str(target_seconds),
            # Re-mux without re-encoding when possible (fastest path); fall
            # back to libx264 + aac if the source codecs/container aren't RTMP
            # compatible. libx264-composed MP4s pass straight through.
            "-c:v", "copy",
            "-c:a", "aac",
            "-b:a", "192k",
            "-ar", "44100",
            "-f", "flv",
            rtmp_url,
        ]
        logger.info(
            "Stream %d: launching FFmpeg (composed %s → RTMP, target %dh)",
            db_id, composed_path.name, target_duration_hours,
        )

        startupinfo = None
        if sys.platform == "win32":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
        )

        ctx = StreamContext(
            channel_id=channel_id,
            db_id=db_id,
            process=proc,
            broadcast_id=broadcast_id,
            stream_id=stream_yt_id,
        )
        self._active[channel_id] = ctx

        async with async_session() as db:
            stream = await db.get(LiveStream, db_id)
            if stream:
                stream.status = "live"
                stream.ffmpeg_pid = proc.pid
                stream.started_at = datetime.now(timezone.utc)
                await db.commit()

        self._broadcast_status(db_id, channel_id, "live")
        logger.info("Stream %d: LIVE (composed, PID %d)", db_id, proc.pid)

        ctx.monitor_task = asyncio.create_task(self._monitor_process(ctx))

    # ------------------------------------------------------------------
    # Visualizer RTMP launcher
    # ------------------------------------------------------------------

    async def _launch_visualizer_stream(
        self,
        *,
        db_id: int,
        rtmp_url: str,
        audio_paths: List[Path],
        background_path: Optional[str],
        target_seconds: float,
        total_audio_dur: float,
        visualizer_config: Dict[str, Any],
        visualizer_preset_id: str,
    ) -> subprocess.Popen:
        """Spawn the visualizer engine (Node sidecar) to stream RTMP.

        The sidecar renders frames in real time (FFmpeg's ``-re`` flag paces
        the audio input, which throttles the whole pipeline). Audio is looped
        by repeating the path list enough times to fill ``target_seconds``.
        """
        import math
        import uuid

        # Loop the playlist to reach the target length
        repeats = max(1, math.ceil(target_seconds / max(1.0, total_audio_dur)))
        looped_paths = audio_paths * repeats
        logger.info(
            "Stream %d: visualizer — %d track(s) × %d repeats = %d segments (~%.0f min)",
            db_id, len(audio_paths), repeats, len(looped_paths),
            (total_audio_dur * repeats) / 60,
        )

        # Build job JSON for the sidecar
        job = {
            "config": visualizer_config,
            "presetId": visualizer_preset_id,
            "audioPaths": [str(p) for p in looped_paths],
            "logoPath": None,
            "backgroundPath": background_path,
            "overlayPath": None,
            "width": int(visualizer_config.get("output_width", 1920)),
            "height": int(visualizer_config.get("output_height", 1080)),
            "fps": int(visualizer_config.get("output_fps", 30)),
            "crf": int(visualizer_config.get("crf", 23)),
        }

        tmp_dir = settings.assets_dir / "_tmp"
        tmp_dir.mkdir(parents=True, exist_ok=True)
        job_path = tmp_dir / f"livestream-{uuid.uuid4().hex}.json"
        with open(job_path, "w", encoding="utf-8") as fh:
            json.dump(job, fh)

        # Resolve node binary + sidecar CLI
        import shutil
        node_bin = shutil.which(
            getattr(settings, "node_path", "") or "node",
        )
        if not node_bin:
            raise RuntimeError(
                "Node.js not found on PATH — install Node 20+ or set YTS_NODE_PATH.",
            )
        cli_js = (
            settings.project_root / "backend" / "visualizer_engine" / "dist" / "cli.js"
        )
        if not cli_js.exists():
            raise RuntimeError(
                f"Visualizer engine CLI not built ({cli_js} missing). "
                f"Run: cd backend/visualizer_engine && npm install && npm run build",
            )

        cmd = [
            str(node_bin),
            str(cli_js),
            "--config", str(job_path),
            "--rtmp", rtmp_url,
        ]
        logger.info("Stream %d: launching visualizer sidecar for RTMP", db_id)

        startupinfo = None
        if sys.platform == "win32":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            startupinfo.wShowWindow = 0

        proc = subprocess.Popen(
            cmd,
            stdin=subprocess.PIPE,     # unused but kept for parity with static path
            stdout=subprocess.DEVNULL, # sidecar's NDJSON progress — we don't consume it here
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
        )
        return proc

    def _build_ffmpeg_cmd(
        self,
        rtmp_url: str,
        audio_path: str,
        image_path: str,
    ) -> list[str]:
        """Thin delegator. See ``live_stream.ffmpeg_helpers``."""
        return build_ffmpeg_cmd(rtmp_url, audio_path, image_path)

    async def _stop_ffmpeg(self, ctx: StreamContext) -> None:
        """Thin delegator. See ``live_stream.ffmpeg_helpers``."""
        await stop_ffmpeg(ctx.process)

    async def _monitor_process(self, ctx: StreamContext) -> None:
        """Monitor the FFmpeg process and update status if it dies."""
        try:
            while True:
                await asyncio.sleep(10)
                if ctx.process.poll() is not None:
                    # Process exited
                    returncode = ctx.process.returncode
                    stderr = ""
                    try:
                        stderr = ctx.process.stderr.read().decode("utf-8", errors="replace")[-500:]
                    except Exception:
                        pass

                    logger.warning("Stream %d: FFmpeg exited with code %d",
                                   ctx.db_id, returncode)

                    async with async_session() as db:
                        stream = await db.get(LiveStream, ctx.db_id)
                        if stream and stream.status == "live":
                            stream.status = "failed"
                            stream.error = f"FFmpeg exited with code {returncode}: {stderr}"
                            stream.stopped_at = datetime.now(timezone.utc)
                            stream.ffmpeg_pid = None
                            await db.commit()

                    self._active.pop(ctx.channel_id, None)
                    self._broadcast_status(ctx.db_id, ctx.channel_id, "failed")
                    return
        except asyncio.CancelledError:
            pass

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _broadcast_status(self, stream_id: int, channel_id: int, status: str) -> None:
        """Broadcast stream status update via SSE."""
        try:
            from app.workers.task_runner import task_runner
            task_runner.broadcast({
                "event": "stream_update",
                "stream_id": stream_id,
                "channel_id": channel_id,
                "status": status,
            })
        except Exception:
            pass  # SSE broadcast is best-effort

    @staticmethod
    def _create_black_image(path: str, width: int, height: int) -> None:
        """Thin delegator. See ``live_stream.ffmpeg_helpers``."""
        create_black_image(path, width, height)


# Module-level singleton
stream_manager = StreamManager()
