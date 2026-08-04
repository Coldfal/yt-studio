from __future__ import annotations

import asyncio
import json
import logging
import random
from datetime import datetime, timezone
from typing import Optional, Callable

from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.exceptions import (
    AppError,
    CredentialError,
    RETRYABLE_EXCEPTIONS,
    TimeoutExceededError,
    ValidationError,
)
from app.models.task import BackgroundTask
from app.models.video_project import VideoProject
from app.models.asset import Asset
from app.models.channel import Channel
from app.utils.file_utils import get_asset_dir, save_upload_file, get_mime_type

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Per-task-type policy
# ---------------------------------------------------------------------------
#
# Wall-clock timeouts. Anything exceeding these gets cancelled and the
# task is marked failed. Numbers are conservative — Phase 3 may tighten
# them once we have real per-channel data.
_DEFAULT_TIMEOUT_SECONDS: float = 30 * 60  # 30 min
_TIMEOUTS: dict[str, float] = {
    "video_composition": 60 * 60,          # 60 min
    "video_extend": 30 * 60,               # 30 min — concat copy is fast
    "youtube_upload": 30 * 60,             # 30 min
    "metadata_generation": 5 * 60,         # 5 min — Claude CLI shouldn't take long
    "music_generation": 20 * 60,           # 20 min — Suno can be slow
    "image_generation": 5 * 60,            # 5 min
    "youtube_audio_download": 20 * 60,     # 20 min — long videos
    "youtube_chapters_download": 30 * 60,  # 30 min
    "youtube_video_download": 30 * 60,     # 30 min — bigger file than audio
    "youtube_video_sections_download": 45 * 60,  # 45 min — re-encode per section
    "automation_run": 90 * 60,             # 90 min — orchestrates compose+upload
}

# Retry budget per task type. compose is intentionally 0 — it's expensive
# and a real failure deserves a human's attention. Network-y tasks get
# more retries.
_RETRIES: dict[str, int] = {
    "video_composition": 0,
    "video_extend": 0,
    "youtube_upload": 2,
    "metadata_generation": 1,
    "music_generation": 1,
    "image_generation": 1,
    "youtube_audio_download": 2,
    "youtube_chapters_download": 1,
    "youtube_video_download": 2,
    "youtube_video_sections_download": 1,
    "automation_run": 0,  # children handle their own retries
}

# Exponential backoff base. Sleeps `_BACKOFF_BASE * 2**attempt` seconds
# (plus jitter) between retries. With base=4: 4s, 8s, 16s — fits inside
# the per-task timeout budget.
_BACKOFF_BASE_SECONDS: float = 4.0
_BACKOFF_MAX_SECONDS: float = 60.0


# Per-task-type concurrency budget (Phase 3). Replaces the old
# single-worker FIFO so tasks of independent types can run in
# parallel. Tuned per the plan:
#   - compose / video_extend  : CPU + disk bound (FFmpeg). 2 in flight
#                               so a slow render doesn't block another
#                               channel.
#   - metadata_generation     : Claude calls. Network-bound + cheap.
#                               3 in flight for snappy bulk metadata.
#   - youtube_upload          : Network upload. 2 in flight covers a
#                               second channel uploading while the
#                               first is mid-resumable.
#   - music / image / yt-dl   : Hit rate-limited APIs (Suno, OpenAI,
#                               YouTube). Stay at 1 each — the rate
#                               limiter (next backlog item) will tune
#                               concurrency per-channel.
#   - automation_run          : Orchestrator that spawns children.
#                               Multiple in flight is fine; children
#                               are bounded by their own type budgets.
#   - default                 : Catch-all for unrecognised types so a
#                               new task type doesn't sneak through
#                               with unbounded parallelism.
_TYPE_CONCURRENCY: dict[str, int] = {
    # Operator observed CPU sat at 50-60% with 2 parallel composes —
    # bumped to 3 to use the headroom. FFmpeg/NVENC each consumes ~1.5
    # cores effectively, so 3 parallel ≈ 80-90% on an 8-core box.
    "video_composition": 3,
    "video_extend": 2,
    "youtube_upload": 2,
    "metadata_generation": 3,
    "music_generation": 1,
    "image_generation": 1,
    "youtube_audio_download": 2,
    "youtube_chapters_download": 1,
    "youtube_video_download": 2,
    "youtube_video_sections_download": 1,
    "automation_run": 4,
}
_DEFAULT_TYPE_CONCURRENCY: int = 1

# Total dispatcher workers. Should be ≥ sum of per-type budgets so the
# pool can saturate every type simultaneously when the queue mix
# allows. With the budgets above, sum = 17; we round to 12 because
# real-world workloads rarely max out every type at once and 12
# concurrent asyncio tasks per backend keeps memory predictable.
_DISPATCHER_WORKERS: int = 12


def _timeout_for(task_type: str) -> float:
    return _TIMEOUTS.get(task_type, _DEFAULT_TIMEOUT_SECONDS)


def _retries_for(task_type: str) -> int:
    return _RETRIES.get(task_type, 0)


def _concurrency_for(task_type: str) -> int:
    return _TYPE_CONCURRENCY.get(task_type, _DEFAULT_TYPE_CONCURRENCY)


def _is_retryable(exc: BaseException) -> bool:
    """A failure is retryable if it's a known transient class. Credential
    errors and validation errors are *never* retried — they need an
    operator fix.
    """
    if isinstance(exc, (CredentialError, ValidationError)):
        return False
    return isinstance(exc, RETRYABLE_EXCEPTIONS)


async def _backoff(attempt: int) -> None:
    """Sleep with exponential backoff + jitter. ``attempt`` is 0-indexed."""
    delay = min(_BACKOFF_BASE_SECONDS * (2 ** attempt), _BACKOFF_MAX_SECONDS)
    delay += random.uniform(0, delay * 0.25)  # 25% jitter
    logger.info("Backing off %.1fs before retry %d", delay, attempt + 1)
    await asyncio.sleep(delay)


# ---------------------------------------------------------------------------
# Progress persistence helper
# ---------------------------------------------------------------------------

# Per-task throttle state for progress DB writes + SSE broadcasts
# (2026-05-16 operator bug). The visualizer engine emits one NDJSON
# progress event per rendered frame (≈26/s per compose). Pre-fix:
#  - 52 SQLite UPDATEs/sec under the single-writer lock
#  - 52 SSE broadcasts/sec to every connected browser tab → cache
#    thrash + heavy React re-renders that made other pages feel
#    sluggish to navigate to during a compose.
#
# Now we throttle both:
#  - DB persist: ≤1/sec per task (terminal + msg-change always flush)
#  - SSE broadcast: ≤4/sec per task (smooth UI progress bar without
#    flooding the cache invalidation path)
_PROGRESS_THROTTLE_SECONDS: float = 1.0
_BROADCAST_THROTTLE_SECONDS: float = 0.25
_last_persist_at: dict[int, float] = {}
_last_persist_msg: dict[int, str] = {}
_last_broadcast_at: dict[int, float] = {}


def _persist_progress(
    task_id: int,
    progress: float,
    status_message: str,
    loop: asyncio.AbstractEventLoop,
) -> None:
    """Schedule a DB update for the task's progress/status_message.

    Safe to call from any thread. Progress callbacks from compose_service,
    youtube_service, and ytdlp_service fire on background executor threads,
    so we use ``run_coroutine_threadsafe`` to hop back onto the event loop
    where the async DB session lives. Polling consumers (e.g. ``useTask``
    in the frontend) rely on these DB writes to see incremental progress;
    SSE broadcasts alone are not enough.

    Throttled to one DB write per task per ``_PROGRESS_THROTTLE_SECONDS``,
    except: (a) terminal states (0% start, 100% complete), (b) status
    message changes (so stage transitions like 'Encoding...' → 'Complete.'
    always flush). Frontend polling is on 2s interval — 1s throttle is
    invisible from the operator side.
    """
    import time as _time
    now = _time.monotonic()
    last = _last_persist_at.get(task_id, 0.0)
    msg_changed = _last_persist_msg.get(task_id) != status_message
    terminal = progress <= 0.0 or progress >= 100.0
    if not terminal and not msg_changed and (now - last) < _PROGRESS_THROTTLE_SECONDS:
        return  # skip — keep the SQLite writer lock free for other work
    _last_persist_at[task_id] = now
    _last_persist_msg[task_id] = status_message
    if progress >= 100.0:
        # Done — drop the per-task entries so the dicts don't grow
        # unbounded across the lifetime of the process. Next time this
        # task_id appears (shouldn't, but safe), it starts fresh.
        _last_persist_at.pop(task_id, None)
        _last_persist_msg.pop(task_id, None)

    async def _update() -> None:
        try:
            async with async_session() as session:
                task = await session.get(BackgroundTask, task_id)
                if task is not None:
                    task.progress = progress
                    task.status_message = status_message
                    await session.commit()
        except Exception:
            logger.exception("Failed to persist progress for task %d", task_id)

    try:
        asyncio.run_coroutine_threadsafe(_update(), loop)
    except Exception:
        logger.exception(
            "Failed to schedule progress persist for task %d", task_id
        )


# ---------------------------------------------------------------------------
# Real handler functions
# ---------------------------------------------------------------------------

async def _handle_music_generation(task: BackgroundTask, broadcast: Callable) -> dict:
    """Generate music via Suno API and save as an asset."""
    from app.services.suno_service import suno_service

    params = task.result or {}
    prompt = params.get("prompt", "lofi chill beats")
    duration = params.get("duration_seconds", 120)
    instrumental = params.get("instrumental", True)
    style = params.get("style")
    project_id = task.project_id
    channel_id = task.channel_id

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float):
        progress_pct = fraction * 100
        message = f"Generating music... {int(fraction * 100)}%"
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    result = await suno_service.generate(
        prompt=prompt,
        duration_seconds=duration,
        instrumental=instrumental,
        style=style,
        on_progress=on_progress,
        channel_id=channel_id,
    )

    # Save the downloaded audio as an asset
    temp_path = result.get("temp_filepath")
    if temp_path:
        import shutil
        asset_dir = get_asset_dir(channel_id, "music")
        filename = f"suno_{result.get('title', 'track').replace(' ', '_')}.mp3"
        dest = asset_dir / filename
        shutil.move(temp_path, str(dest))
        relative_path = f"{channel_id}/music/{filename}"
        file_size = dest.stat().st_size

        async with async_session() as session:
            asset = Asset(
                channel_id=channel_id,
                asset_type="music",
                source="suno",
                filename=filename,
                filepath=relative_path,
                file_size=file_size,
                duration_seconds=result.get("duration"),
                mime_type="audio/mpeg",
                prompt=prompt,
                title=result.get("title"),
            )
            session.add(asset)
            await session.flush()
            asset_id = asset.id

            if project_id:
                proj = await session.get(VideoProject, project_id)
                if proj:
                    proj.music_asset_id = asset_id
                    proj.status = "music_ready"
            await session.commit()

        return {"asset_id": asset_id, "filepath": relative_path, "duration": result.get("duration")}

    return {"info": "Music generated but no file downloaded"}


async def _handle_video_composition(task: BackgroundTask, broadcast: Callable) -> dict:
    """Compose video using FFmpeg."""
    from app.services.compose_service import compose_service

    project_id = task.project_id
    channel_id = task.channel_id

    async with async_session() as session:
        project = await session.get(VideoProject, project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")

        # Resolve the ordered list of music tracks via the m2m table
        # (CASCADE-safe: deleted assets are automatically pruned from the
        # table so we never try to open a missing file).  Falls back to the
        # JSON column for projects created before the m2m migration.
        from app.services.automation_service._shared import get_project_track_ids
        music_ids: list[int] = await get_project_track_ids(session, project)

        music_filepaths: list[str] = []

        # Folder-mode: absolute paths stored directly on the project
        if project.music_folder_files:
            music_filepaths = [str(p) for p in project.music_folder_files if p]
        else:
            for mid in music_ids:
                ma = await session.get(Asset, mid)
                if ma:
                    music_filepaths.append(ma.filepath)

        if not music_filepaths:
            raise ValueError("No music asset assigned to project")

        image_filepaths = []
        if project.image_asset_ids:
            for img_id in project.image_asset_ids:
                img_asset = await session.get(Asset, img_id)
                if img_asset:
                    image_filepaths.append(img_asset.filepath)

        if not image_filepaths:
            raise ValueError("No image assets assigned to project")

        style = project.video_style or "ken_burns"
        config = project.composition_config or {}
        # First track is the "primary" for non-spectrum FFmpeg pipelines
        # (they don't support concat — spectrum does).
        music_filepath = music_filepaths[0]

    # ── Metadata pre-generation ──────────────────────────────────────────────
    # Kick off Claude metadata generation as a *concurrent* asyncio task so it
    # runs in parallel with the FFmpeg compose.  compose_video() uses
    # run_in_executor() internally, which means the event loop is free during
    # the render — asyncio.create_task() will schedule the metadata coroutine
    # on that free time (typically finishes in 5–15 s while compose takes
    # 1–5 min).  We create the BackgroundTask row first so the frontend can
    # observe it via SSE, then fire _process() directly (bypassing the
    # sequential queue to achieve real concurrency).
    try:
        async with async_session() as session:
            meta_task = BackgroundTask(
                task_type="metadata_generation",
                status="pending",
                project_id=project_id,
                channel_id=channel_id,
                result={"source": "pre_generation"},
            )
            session.add(meta_task)
            await session.commit()
            await session.refresh(meta_task)
            meta_task_id = meta_task.id

        # schedule concurrently — do NOT await; compose must start immediately
        asyncio.create_task(task_runner._process(meta_task_id))
        logger.info(
            "Pre-generating metadata (task %d) concurrently with compose task %d",
            meta_task_id,
            task.id,
        )
    except Exception:
        logger.warning("Could not enqueue metadata pre-generation", exc_info=True)

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str):
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    result = await compose_service.compose_video(
        channel_id=channel_id,
        music_filepath=music_filepath,
        music_filepaths=music_filepaths,
        image_filepaths=image_filepaths,
        style=style,
        config=config,
        on_progress=on_progress,
    )

    # Save composed video as asset and update project
    async with async_session() as session:
        asset = Asset(
            channel_id=channel_id,
            asset_type="composed",
            source="composed",
            filename=result["filename"],
            filepath=result["filepath"],
            file_size=result["file_size"],
            duration_seconds=result["duration"],
            mime_type="video/mp4",
        )
        session.add(asset)
        await session.flush()

        project = await session.get(VideoProject, project_id)
        if project:
            project.composed_asset_id = asset.id
            project.status = "composed"

            # ── Project memory: persist this compose config to the channel ──
            # so the next project for this channel can inherit the look.
            if project.channel_id:
                channel = await session.get(Channel, project.channel_id)
                if channel:
                    channel.last_composition_config = project.composition_config
                    # Detect if a named visualizer preset was used
                    cfg = project.composition_config or {}
                    if cfg.get("visualizer_preset_id"):
                        channel.last_visualizer_preset_id = cfg["visualizer_preset_id"]
                    # Remember whether music came from library or upload
                    if project.music_asset_ids or project.music_asset_id:
                        channel.last_music_source = "library"
                    elif project.music_folder_files:
                        channel.last_music_source = "folder"
                    # Remember the images used so the next project starts with them
                    if project.image_asset_ids:
                        channel.last_image_asset_ids = list(project.image_asset_ids)

        await session.commit()

    return {"asset_id": asset.id, "filepath": result["filepath"]}


async def _handle_video_extend(task: BackgroundTask, broadcast: Callable) -> dict:
    """Loop the project's composed video to a target duration.

    Uses FFmpeg concat demuxer + ``-c copy`` so it's near-instant compared to
    re-rendering the visualizer. Replaces ``project.composed_asset_id`` with
    the new extended asset.
    """
    from app.services.compose_service import compose_service

    project_id = task.project_id
    params = task.result or {}
    target_duration = int(params.get("target_duration_seconds", 0))
    # Default False — see compose_service.extend_video docstring for why.
    # The frontend's "Snap to nearest track end" button handles the
    # song-clean-boundary case explicitly so operators get exactly what
    # they ask for.
    snap_to_song = bool(params.get("snap_to_song", False))
    if target_duration <= 0:
        raise ValueError("target_duration_seconds must be > 0")

    async with async_session() as session:
        project = await session.get(VideoProject, project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")
        if not project.composed_asset_id:
            raise ValueError("Project has no composed video to extend")
        composed = await session.get(Asset, project.composed_asset_id)
        if not composed:
            raise ValueError("Composed asset missing")
        source_filepath = composed.filepath
        channel_id = project.channel_id

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str) -> None:
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    result = await compose_service.extend_video(
        channel_id=channel_id,
        source_filepath=source_filepath,
        target_duration_seconds=target_duration,
        snap_to_song=snap_to_song,
        on_progress=on_progress,
    )

    # Persist the extended file as a new asset and swap the project pointer.
    async with async_session() as session:
        asset = Asset(
            channel_id=channel_id,
            asset_type="composed",
            source="composed",
            filename=result["filename"],
            filepath=result["filepath"],
            file_size=result["file_size"],
            duration_seconds=result["duration"],
            mime_type="video/mp4",
        )
        session.add(asset)
        await session.flush()
        project = await session.get(VideoProject, project_id)
        if project:
            project.composed_asset_id = asset.id
            project.status = "composed"
        await session.commit()

    return {
        "asset_id": asset.id,
        "filepath": result["filepath"],
        "duration": result["duration"],
    }


async def _handle_youtube_upload(task: BackgroundTask, broadcast: Callable) -> dict:
    """Upload composed video to YouTube."""
    from app.services.credentials_service import get_channel_youtube_credentials
    from app.services.youtube_service import youtube_service
    from app.exceptions import CredentialError, NotFoundError

    project_id = task.project_id

    async with async_session() as session:
        project = await session.get(VideoProject, project_id)
        if not project:
            raise NotFoundError(f"Project {project_id} not found")

        composed_asset = await session.get(Asset, project.composed_asset_id) if project.composed_asset_id else None
        if not composed_asset:
            raise NotFoundError("No composed video for this project")

        credentials_json = await get_channel_youtube_credentials(session, project.channel_id)
        if credentials_json is None:
            raise CredentialError(
                "YouTube not connected for this channel. Open the channel "
                "settings and click Connect YouTube."
            )
        # Load the channel so we know its master_language (the value
        # passed to YouTube's snippet.defaultLanguage). Critical for
        # channels writing non-English master titles (e.g. yomii studio
        # ships Korean-master titles with en/ja/es localizations).
        channel_for_upload = await session.get(Channel, project.channel_id)
        master_language = (
            getattr(channel_for_upload, "master_language", None) or "en"
        )
        video_path = str(settings.assets_dir / composed_asset.filepath)

        thumbnail_path = None
        if project.thumbnail_asset_id:
            thumb_asset = await session.get(Asset, project.thumbnail_asset_id)
            if thumb_asset:
                thumbnail_path = str(settings.assets_dir / thumb_asset.filepath)

        title = project.youtube_title or project.title
        description = project.youtube_description or ""
        tags = project.youtube_tags or []
        category_id = project.youtube_category_id or "10"
        privacy = project.youtube_privacy or "private"
        scheduled_at = project.youtube_scheduled_at

        # Build the localizations payload sent to YouTube. The stored
        # ``youtube_translations`` JSON only has the translated TOP of
        # the description (no tracklist, no hashtags) — re-attach the
        # English tail so timestamps + hashtag SEO carry across locales.
        from app.utils.description_parts import build_localized_description
        raw_translations = project.youtube_translations or {}
        localizations: dict[str, dict[str, str]] = {}
        for code, entry in raw_translations.items():
            if not isinstance(entry, dict):
                continue
            t = str(entry.get("title") or "").strip()
            top = str(entry.get("description") or "").strip()
            if not t and not top:
                continue
            localizations[str(code)] = {
                "title": t or title,
                "description": build_localized_description(top, description) or top,
            }

        # Mark the project as uploading so the UI reflects in-progress state.
        project.status = "uploading"
        await session.commit()

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float):
        progress_pct = fraction * 100
        message = f"Uploading to YouTube... {int(fraction * 100)}%"
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    try:
        result = await youtube_service.upload_video(
            credentials_json=credentials_json,
            filepath=video_path,
            title=title,
            description=description,
            tags=tags,
            category_id=category_id,
            privacy=privacy,
            scheduled_at=scheduled_at,
            thumbnail_path=thumbnail_path,
            on_progress=on_progress,
            localizations=localizations or None,
            channel_id=project.channel_id,
            default_language=master_language,
        )
    except Exception as exc:
        msg = str(exc)
        # Google's refresh token has been revoked or has expired (no use in
        # 6 months). Clear the stored creds so the UI prompts to reconnect.
        if "invalid_grant" in msg or "Token has been expired" in msg:
            async with async_session() as session:
                ch = await session.get(Channel, project.channel_id)
                if ch:
                    ch.youtube_credentials_json = None
                    await session.commit()
            raise RuntimeError(
                "YouTube authorization expired or was revoked. "
                "Go to the channel's Settings page and click "
                "\"Connect YouTube\" to re-authorize, then retry the upload."
            ) from exc
        raise

    # Update project with YouTube info
    async with async_session() as session:
        project = await session.get(VideoProject, project_id)
        if project:
            project.youtube_video_id = result["video_id"]
            project.youtube_url = result["url"]
            project.status = "uploaded"
            project.uploaded_at = datetime.now(timezone.utc)
        await session.commit()

    return result


async def _handle_metadata_generation(task: BackgroundTask, broadcast: Callable) -> dict:
    """Generate YouTube metadata using the Claude Code CLI (subscription-billed)."""
    from app.services.claude_cli_service import claude_cli_service as claude_service
    from app.services.keyword_research_service import keyword_research_service

    project_id = task.project_id
    params = task.result or {}
    additional_context = params.get("additional_context")

    async with async_session() as session:
        project = await session.get(VideoProject, project_id)
        if not project:
            raise ValueError(f"Project {project_id} not found")

        channel = await session.get(Channel, project.channel_id)
        if not channel:
            raise ValueError(f"Channel {project.channel_id} not found")

        music_prompt = project.music_prompt
        channel_name = channel.name
        niche = channel.niche
        brand_identity = channel.brand_identity
        target_audience = channel.target_audience
        channel_id = channel.id

        # Resolve track names for the metadata prompt via m2m table.
        # Also collect durations so we can inject a timestamped tracklist
        # into the description after Claude returns. Without this the
        # auto-pre-gen description ships with an empty "TRACKLIST" block
        # (Claude is instructed to leave it for us to fill).
        from app.services.automation_service._shared import (
            get_project_track_ids,
            format_duration,
        )
        track_ids = await get_project_track_ids(session, project)
        track_names: list[str] = []
        track_durations: list[float] = []
        for tid in track_ids[:30]:
            a = await session.get(Asset, int(tid))
            if a:
                track_names.append(a.title or a.filename)
                track_durations.append(float(a.duration_seconds or 0.0))

        # Detach the channel so we can pass it to ``generate_metadata`` after
        # this session closes. ``style_block(channel)`` reads ``ai_voice`` +
        # ``ai_example_*`` off it — without this, the pre-gen path silently
        # falls back to the generic style brief (no channel voice).
        session.expunge(channel)

    broadcast({
        "event": "task_update",
        "task_id": task.id,
        "progress": 20,
        "status": "running",
        "status_message": "Researching trending keywords...",
    })

    # Pull research signals (cached) — falls back gracefully if no API key
    seed_keywords: list[str] = []
    if niche:
        seed_keywords.append(niche.replace("_", " "))
    if brand_identity:
        seed_keywords.append(str(brand_identity)[:60])
    for n in track_names[:2]:
        seed_keywords.append(n.split(" - ")[-1][:40])

    research_block = ""
    try:
        research = await keyword_research_service.research(
            channel_id=channel_id,
            niche=niche or "",
            seed_keywords=seed_keywords,
        )
        research_block = keyword_research_service.format_for_prompt(research)
    except Exception as e:
        logger.warning("keyword research failed in task_runner: %s", e)

    broadcast({
        "event": "task_update",
        "task_id": task.id,
        "progress": 40,
        "status": "running",
        "status_message": "Generating metadata with Claude...",
    })

    metadata = await claude_service.generate_metadata(
        channel_name=channel_name,
        niche=niche,
        music_prompt=music_prompt,
        additional_context=additional_context,
        research_block=research_block or None,
        track_names=track_names or None,
        brand_identity=brand_identity,
        target_audience=target_audience,
        channel=channel,  # ← carries ai_voice + ai_example_* into style_block
    )

    # Inject the timestamped tracklist into the description. The system
    # prompt tells Claude to leave the section blank; we fill it here so
    # YouTube renders chapter rows. Idempotent — skips if the first track
    # line is already in the description (catches re-generation paths).
    description = str(metadata.get("description") or "")
    if description and track_names:
        running = 0.0
        tl_lines: list[str] = []
        for name, dur in zip(track_names, track_durations):
            ts = format_duration(running)
            clean = (name or "").strip()
            if clean:
                from pathlib import Path as _P
                if "." in clean and "/" not in clean and "\\" not in clean:
                    # Strip extensions from raw filenames so the chapter
                    # title is just "Rooftop Sunday", not "...mp3".
                    stem = _P(clean).stem
                    if stem:
                        clean = stem
                tl_lines.append(f"{ts} - {clean}")
            running += dur
        tracklist_text = "\n".join(tl_lines)
        if tracklist_text and tl_lines[0] not in description:
            from app.utils.description_parts import is_tracklist_anchor

            desc_lines = description.splitlines()
            anchor_idx: int | None = None
            for i, line in enumerate(desc_lines):
                if is_tracklist_anchor(line):
                    anchor_idx = i
                    break
            if anchor_idx is not None:
                insert_at = anchor_idx + 1
                while (
                    insert_at < len(desc_lines)
                    and not desc_lines[insert_at].strip()
                ):
                    insert_at += 1
                new_lines = (
                    desc_lines[: anchor_idx + 1]
                    + [""]
                    + tl_lines
                    + [""]
                    + desc_lines[insert_at:]
                )
                description = "\n".join(new_lines)
                metadata["description"] = description
            else:
                # No anchor → channel ai_voice deliberately omits a
                # tracklist (e.g. Isekai Radio). Don't force-append one.
                logger.info(
                    "No tracklist anchor in description for project %d — "
                    "skipping injection.",
                    project_id,
                )

    # Update project with generated metadata
    async with async_session() as session:
        project = await session.get(VideoProject, project_id)
        if project:
            project.youtube_title = metadata.get("title", project.title)
            project.youtube_description = metadata.get("description", "")
            project.youtube_tags = metadata.get("tags", [])
            project.youtube_category_id = metadata.get("category_id", "10")
        await session.commit()

    return metadata


async def _handle_youtube_audio_download(task: BackgroundTask, broadcast: Callable) -> dict:
    """Download audio from a YouTube video using yt-dlp.

    Saves into the given channel's asset library and creates an Asset row.
    When ``params.folder_id`` is set, the asset is filed under that
    AssetFolder so it shows in the right library subfolder.
    """
    from app.services.ytdlp_service import ytdlp_service

    params = task.result or {}
    url = params.get("url", "")
    custom_title = params.get("title")
    custom_description = params.get("description")
    folder_id = params.get("folder_id")
    channel_id = task.channel_id

    if not url:
        raise ValueError("No YouTube URL provided")
    if not channel_id:
        raise ValueError("channel_id is required")

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str):
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    result = await ytdlp_service.download_audio(
        url=url,
        channel_id=channel_id,
        on_progress=on_progress,
    )

    # Persist as Asset row so it shows in the library, optionally inside
    # the chosen AssetFolder.
    async with async_session() as session:
        asset = Asset(
            channel_id=channel_id,
            asset_type="music",
            source="youtube",
            filename=result["filename"],
            filepath=result["filepath"],
            file_size=result["file_size"],
            duration_seconds=result.get("duration"),
            mime_type="audio/mpeg",
            title=custom_title or result.get("title"),
            description=custom_description or f"Downloaded from YouTube ({result.get('video_id', '')})",
            folder_id=int(folder_id) if folder_id else None,
        )
        session.add(asset)
        await session.commit()
        await session.refresh(asset)
        asset_id = asset.id

    return {
        "asset_id": asset_id,
        "filepath": result["filepath"],
        "title": result.get("title"),
        "duration": result.get("duration"),
        "video_id": result.get("video_id"),
    }


async def _handle_image_generation(task: BackgroundTask, broadcast: Callable) -> dict:
    """Generate images via OpenAI DALL-E 3 and save as assets."""
    from app.services.openai_service import openai_service

    params = task.result or {}
    prompt = params.get("prompt", "")
    count = params.get("count", 1)
    size = params.get("size", "1792x1024")
    project_id = task.project_id
    channel_id = task.channel_id

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str):
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    results = await openai_service.generate_images(
        prompt=prompt,
        channel_id=channel_id,
        count=count,
        size=size,
        on_progress=on_progress,
    )

    # Save each image as an Asset
    asset_ids = []
    async with async_session() as session:
        for r in results:
            asset = Asset(
                channel_id=channel_id,
                asset_type="image",
                source="ai_generated",
                filename=r["filename"],
                filepath=r["asset_path"],
                file_size=r["file_size"],
                mime_type="image/png",
                prompt=prompt,
                title=r.get("revised_prompt", "")[:200],
            )
            session.add(asset)
            await session.flush()
            asset_ids.append(asset.id)

        if project_id:
            proj = await session.get(VideoProject, project_id)
            if proj:
                existing = proj.image_asset_ids or []
                proj.image_asset_ids = existing + asset_ids

        await session.commit()

    return {"asset_ids": asset_ids, "count": len(asset_ids)}


async def _handle_automation_run(
    task: "BackgroundTask",
    broadcast: Callable,
) -> dict:
    """Run a full automation pipeline for a preset.

    Builds its own progress callback that broadcasts SSE updates and
    persists the running progress to the DB — same pattern as the other
    handlers in this module.
    """
    from app.services.automation_service import automation_service
    from app.models import AutomationPreset, AutomationRun

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str) -> None:
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    result_data = task.result or {}
    preset_id = result_data.get("preset_id")
    is_quick = bool(result_data.get("quick"))
    channel_id_override = result_data.get("channel_id")

    # Quick-generate path: uses library assets, preset config is optional.
    if is_quick:
        channel_id = channel_id_override or task.channel_id
        # Write an AutomationRun row IFF a preset is involved. Mirrors
        # the folder-scan branch below so scheduled runs that flow
        # through this path still show up in the preset's run history.
        # Manual "Generate now" without a preset stays history-less.
        run_id: Optional[int] = None
        if preset_id:
            async with async_session() as session:
                run = AutomationRun(
                    preset_id=preset_id,
                    task_id=task.id,
                    status="running",
                    started_at=datetime.utcnow(),
                )
                session.add(run)
                await session.flush()
                run_id = run.id
                await session.commit()

        # When the operator approved a preview package on the dashboard,
        # use those exact picks instead of re-running random selection +
        # Claude metadata (Phase 1 of farm redesign). Falls back to the
        # random path when no approved_package was attached.
        approved_package = result_data.get("approved_package")
        try:
            result = await automation_service.quick_generate(
                channel_id=channel_id,
                preset_id=preset_id,
                on_progress=on_progress,
                approved_package=approved_package,
            )
        except Exception as exc:
            if run_id is not None:
                async with async_session() as session:
                    run = await session.get(AutomationRun, run_id)
                    if run:
                        run.status = "failed"
                        run.error = str(exc)
                        run.completed_at = datetime.utcnow()
                    preset = await session.get(AutomationPreset, preset_id)
                    if preset:
                        preset.last_run_at = datetime.utcnow()
                        preset.last_run_status = "failed"
                        preset.last_run_error = str(exc)
                    await session.commit()
            raise

        if run_id is not None:
            async with async_session() as session:
                run = await session.get(AutomationRun, run_id)
                if run:
                    run.status = "completed"
                    run.project_id = result.get("project_id")
                    run.total_duration = result.get("total_duration")
                    run.completed_at = datetime.utcnow()
                preset = await session.get(AutomationPreset, preset_id)
                if preset:
                    preset.last_run_at = datetime.utcnow()
                    preset.last_run_status = "success"
                    preset.last_run_error = None
                await session.commit()
            return {"run_id": run_id, **result}
        return result

    # Standard folder-based automation path
    if not preset_id:
        raise ValueError("automation_run task requires result.preset_id")

    # Create an AutomationRun record
    async with async_session() as session:
        run = AutomationRun(
            preset_id=preset_id,
            task_id=task.id,
            status="running",
            started_at=datetime.utcnow(),
        )
        session.add(run)
        await session.flush()
        run_id = run.id
        await session.commit()

    try:
        result = await automation_service.execute_run(
            preset_id=preset_id,
            on_progress=on_progress,
        )

        # Update run record with success
        async with async_session() as session:
            run = await session.get(AutomationRun, run_id)
            if run:
                run.status = "completed"
                run.project_id = result.get("project_id")
                run.total_duration = result.get("total_duration")
                run.completed_at = datetime.utcnow()

            preset = await session.get(AutomationPreset, preset_id)
            if preset:
                preset.last_run_at = datetime.utcnow()
                preset.last_run_status = "success"
                preset.last_run_error = None
            await session.commit()

        return {"run_id": run_id, **result}

    except Exception as exc:
        # Update run record with failure
        async with async_session() as session:
            run = await session.get(AutomationRun, run_id)
            if run:
                run.status = "failed"
                run.error = str(exc)
                run.completed_at = datetime.utcnow()

            preset = await session.get(AutomationPreset, preset_id)
            if preset:
                preset.last_run_at = datetime.utcnow()
                preset.last_run_status = "failed"
                preset.last_run_error = str(exc)
            await session.commit()
        raise


async def _handle_youtube_chapters_download(task: BackgroundTask, broadcast: Callable) -> dict:
    """Download a YouTube video's audio and slice it into chapter MP3s.

    Each chapter becomes its own Asset row, optionally inside an
    AssetFolder. ``params`` shape::

        {
          "url": "...",
          "chapters": [{"title": str, "start": int, "end": int}, ...],
          "folder_id": int | None,
        }
    """
    from app.services.ytdlp_service import ytdlp_service

    params = task.result or {}
    url = params.get("url", "")
    chapters = params.get("chapters") or []
    folder_id = params.get("folder_id")
    channel_id = task.channel_id

    if not url:
        raise ValueError("No YouTube URL provided")
    if not channel_id:
        raise ValueError("channel_id is required")
    if not chapters:
        raise ValueError("No chapters selected")

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str):
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    saved = await ytdlp_service.download_chapters(
        url=url,
        chapters=chapters,
        channel_id=channel_id,
        on_progress=on_progress,
    )

    asset_ids: list[int] = []
    async with async_session() as session:
        for r in saved:
            asset = Asset(
                channel_id=channel_id,
                asset_type="music",
                source="youtube",
                filename=r["filename"],
                filepath=r["filepath"],
                file_size=r["file_size"],
                duration_seconds=r.get("duration"),
                mime_type="audio/mpeg",
                title=r.get("title"),
                description=f"Chapter {r.get('chapter_index', 0) + 1} of {r.get('video_title', '')} (YouTube {r.get('video_id', '')})",
                folder_id=int(folder_id) if folder_id else None,
            )
            session.add(asset)
            await session.flush()
            asset_ids.append(asset.id)
        await session.commit()

    return {
        "asset_ids": asset_ids,
        "count": len(asset_ids),
    }


async def _handle_youtube_video_download(task: BackgroundTask, broadcast: Callable) -> dict:
    """Download a full YouTube video as MP4 (capped at 1080p).

    Mirror of ``_handle_youtube_audio_download`` but creates an
    ``asset_type='video'`` row. The video lands in
    ``data/assets/{channel_id}/video/`` and is immediately usable as a
    background-video source in the visualizer compose pipeline.
    """
    from app.services.ytdlp_service import ytdlp_service

    params = task.result or {}
    url = params.get("url", "")
    custom_title = params.get("title")
    custom_description = params.get("description")
    folder_id = params.get("folder_id")
    channel_id = task.channel_id

    if not url:
        raise ValueError("No YouTube URL provided")
    if not channel_id:
        raise ValueError("channel_id is required")

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str):
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    result = await ytdlp_service.download_video(
        url=url,
        channel_id=channel_id,
        on_progress=on_progress,
    )

    async with async_session() as session:
        asset = Asset(
            channel_id=channel_id,
            asset_type="video",
            source="youtube",
            filename=result["filename"],
            filepath=result["filepath"],
            file_size=result["file_size"],
            duration_seconds=result.get("duration"),
            mime_type="video/mp4",
            title=custom_title or result.get("title"),
            description=custom_description or (
                f"Downloaded from YouTube ({result.get('video_id', '')})"
            ),
            folder_id=int(folder_id) if folder_id else None,
        )
        session.add(asset)
        await session.commit()
        await session.refresh(asset)
        asset_id = asset.id

    return {
        "asset_id": asset_id,
        "filepath": result["filepath"],
        "title": result.get("title"),
        "duration": result.get("duration"),
        "video_id": result.get("video_id"),
    }


async def _handle_youtube_video_sections_download(
    task: BackgroundTask, broadcast: Callable,
) -> dict:
    """Download a YouTube video and slice it into MP4 sections.

    Each section becomes its own ``asset_type='video'`` Asset row.
    ``params`` shape::

        {
          "url": "...",
          "sections": [{"title": str, "start": float, "end": float}, ...],
          "folder_id": int | None,
        }
    """
    from app.services.ytdlp_service import ytdlp_service

    params = task.result or {}
    url = params.get("url", "")
    sections = params.get("sections") or []
    folder_id = params.get("folder_id")
    channel_id = task.channel_id

    if not url:
        raise ValueError("No YouTube URL provided")
    if not channel_id:
        raise ValueError("channel_id is required")
    if not sections:
        raise ValueError("No sections selected")

    loop = asyncio.get_running_loop()

    def on_progress(fraction: float, message: str):
        progress_pct = fraction * 100
        _persist_progress(task.id, progress_pct, message, loop)
        broadcast({
            "event": "task_update",
            "task_id": task.id,
            "progress": progress_pct,
            "status": "running",
            "status_message": message,
        })

    saved = await ytdlp_service.download_video_sections(
        url=url,
        sections=sections,
        channel_id=channel_id,
        on_progress=on_progress,
    )

    asset_ids: list[int] = []
    async with async_session() as session:
        for r in saved:
            asset = Asset(
                channel_id=channel_id,
                asset_type="video",
                source="youtube",
                filename=r["filename"],
                filepath=r["filepath"],
                file_size=r["file_size"],
                duration_seconds=r.get("duration"),
                mime_type="video/mp4",
                title=r.get("title"),
                description=(
                    f"Section {r.get('section_index', 0) + 1} of "
                    f"{r.get('video_title', '')} "
                    f"(YouTube {r.get('video_id', '')})"
                ),
                folder_id=int(folder_id) if folder_id else None,
            )
            session.add(asset)
            await session.flush()
            asset_ids.append(asset.id)
        await session.commit()

    return {
        "asset_ids": asset_ids,
        "count": len(asset_ids),
    }


_HANDLERS = {
    "music_generation": _handle_music_generation,
    "video_composition": _handle_video_composition,
    "video_extend": _handle_video_extend,
    "youtube_upload": _handle_youtube_upload,
    "metadata_generation": _handle_metadata_generation,
    "youtube_audio_download": _handle_youtube_audio_download,
    "youtube_chapters_download": _handle_youtube_chapters_download,
    "youtube_video_download": _handle_youtube_video_download,
    "youtube_video_sections_download": _handle_youtube_video_sections_download,
    "image_generation": _handle_image_generation,
    "automation_run": _handle_automation_run,
}


# ---------------------------------------------------------------------------
# TaskRunner
# ---------------------------------------------------------------------------

class TaskRunner:
    """Single-queue, many-worker, per-type semaphore admission control.

    The pre-Phase-3 implementation drained one task at a time on a
    single coroutine — a slow ``video_composition`` blocked everything
    else, which tanked the multi-channel UX (a stuck compose on
    channel A held up a metadata generation on channel B).

    The new design:

    1. ``_queue`` is a single FIFO that all workers pull from.
       Insertion order is preserved.
    2. ``_DISPATCHER_WORKERS`` async tasks consume the queue.
    3. Before invoking the handler, the dispatcher acquires a
       per-type ``asyncio.Semaphore`` whose capacity comes from
       ``_TYPE_CONCURRENCY``. Each type's parallelism is independently
       bounded.
    4. Held-semaphore time = handler runtime. Releases on completion
       or exception so the slot is freed even on failure.

    Trade-off: when a type is saturated and the next queued task is
    of that type, the dispatcher that pulled it blocks on the
    semaphore. Other dispatchers can still drain the queue ahead of
    it for different types. With 12 dispatchers vs. 17 type-slots,
    we never exhaust the dispatcher pool just sitting on saturated
    types, so progress doesn't stall.
    """

    def __init__(self) -> None:
        self._queue: asyncio.Queue = asyncio.Queue()
        self._subscribers: list = []
        # Per-type semaphore registry, lazily filled via _semaphore_for().
        # Lazy because the policy dict can grow without code changes
        # to TaskRunner.
        self._type_semaphores: dict[str, asyncio.Semaphore] = {}
        # Captured at TaskRunner.run() startup so cross-thread
        # broadcasts have a reliable reference. asyncio.get_event_loop()
        # from a non-main thread on Python 3.9 may CREATE a new loop
        # silently (or raise), causing broadcasts from worker threads
        # (ffmpeg watcher etc.) to disappear into a phantom loop with
        # no subscribers. With this captured ref, call_soon_threadsafe
        # always reaches the real loop.
        self._main_loop: Optional[asyncio.AbstractEventLoop] = None

    def _semaphore_for(self, task_type: str) -> asyncio.Semaphore:
        sem = self._type_semaphores.get(task_type)
        if sem is None:
            sem = asyncio.Semaphore(_concurrency_for(task_type))
            self._type_semaphores[task_type] = sem
        return sem

    async def enqueue(self, task_id: int) -> None:
        await self._queue.put(task_id)
        logger.info("Task %d enqueued", task_id)

    def subscribe(self) -> asyncio.Queue:
        q: asyncio.Queue = asyncio.Queue()
        self._subscribers.append(q)
        return q

    def unsubscribe(self, queue: asyncio.Queue) -> None:
        try:
            self._subscribers.remove(queue)
        except ValueError:
            pass

    def broadcast(self, event: dict) -> None:
        """Push *event* to all SSE subscribers.

        This method is safe to call from **any** thread.  When invoked from
        a background thread (e.g. the FFmpeg executor) it uses
        ``call_soon_threadsafe`` to schedule the put on the event loop.
        """
        # Throttle high-frequency task_update events to ≤4/sec per
        # task. Visualizer engine emits ~26 frames/sec per compose;
        # pushing every one to every connected SSE subscriber thrashed
        # React Query's cache and made pages feel sluggish to navigate.
        # Terminal events (progress 0% or 100%) always go through.
        # Other event types (task_failed, task_done, etc.) are not
        # throttled — they're rare and important.
        if event.get("event") == "task_update":
            import time as _time
            task_id = event.get("task_id")
            progress = event.get("progress")
            terminal = (
                progress is not None
                and (progress <= 0.0 or progress >= 100.0)
            )
            if task_id is not None and not terminal:
                now = _time.monotonic()
                last = _last_broadcast_at.get(task_id, 0.0)
                if (now - last) < _BROADCAST_THROTTLE_SECONDS:
                    return
                _last_broadcast_at[task_id] = now
            if terminal and task_id is not None:
                _last_broadcast_at.pop(task_id, None)

        try:
            asyncio.get_running_loop()
            # We're on the event-loop thread – put directly
            for q in self._subscribers:
                try:
                    q.put_nowait(event)
                except asyncio.QueueFull:
                    logger.warning("Subscriber queue full – dropping event")
        except RuntimeError:
            # No running loop here → we're on a background thread (the
            # ffmpeg watcher / Claude CLI executor / etc.). Use the
            # main loop ref captured at TaskRunner.run() startup —
            # asyncio.get_event_loop() from a non-main thread is
            # unreliable on Python 3.9 (may create a phantom loop with
            # no subscribers, silently dropping every cross-thread
            # broadcast).
            loop = self._main_loop
            if loop is None or loop.is_closed():
                return
            for q in self._subscribers:
                try:
                    loop.call_soon_threadsafe(q.put_nowait, event)
                except RuntimeError:
                    # Loop has been closed mid-broadcast (shutdown
                    # race). Skip silently.
                    return

    async def _dispatcher(self, worker_id: int) -> None:
        """One of N dispatcher coroutines. Pulls a task, NON-BLOCKINGLY
        tries to acquire the per-type semaphore, runs the handler,
        releases.

        Operator-reported bug (2026-05-15): with many composes queued,
        ALL dispatchers ended up parked at ``async with sem:`` waiting
        for the 2-slot compose semaphore. Downstream youtube_download /
        translate / extend tasks then sat in the queue with no
        available dispatcher even though CPU was at 50-60%.

        Fix: try-acquire with a tiny timeout. If the per-type semaphore
        is saturated, requeue the task at the tail and continue — that
        keeps the dispatcher free to pull non-saturated work. A 250 ms
        sleep before retry prevents hot-looping when the queue only
        contains saturated-type tasks (cost: at most ~50 wakeups/sec
        across 12 dispatchers — negligible).

        Errors out of ``_process`` are already caught + logged inside
        the method; the outer try/finally here only protects the
        ``task_done()`` accounting and the semaphore release.
        """
        while True:
            task_id = await self._queue.get()
            try:
                # Quick DB peek to know the task_type up-front so we
                # can pick the right semaphore. _process re-fetches
                # the row, which is fine — the cost is one extra
                # SELECT per task and the alternative (passing the
                # type around) leaks the queue's serialisation.
                task_type = await self._peek_task_type(task_id)
                sem = self._semaphore_for(task_type)

                # Non-blocking try-acquire. wait_for(timeout=0.1) gives
                # the event loop one tick to grab the slot if free
                # (handles the race between locked() check + acquire),
                # and bails fast when it's not. The outer ``finally``
                # block at the end of this iteration calls task_done()
                # for the .get() above, so the put-back below correctly
                # balances queue accounting without a double-done.
                try:
                    await asyncio.wait_for(sem.acquire(), timeout=0.1)
                except asyncio.TimeoutError:
                    # Type is saturated. Put this task back at the queue
                    # tail and let other dispatchers (or this one on a
                    # later iteration) pick up non-saturated work.
                    await self._queue.put(task_id)
                    await asyncio.sleep(0.25)
                    continue

                # Got the slot. Process with proper release on any exit.
                # CURRENT_TASK_ID is read by services/process_registry.py
                # when subprocess wrappers spawn — auto-propagates to
                # the executor threads via Python's contextvars copy.
                from app.services.process_registry import CURRENT_TASK_ID
                ctx_token = CURRENT_TASK_ID.set(task_id)
                try:
                    try:
                        await self._process(task_id)
                    except Exception:
                        logger.exception(
                            "Unhandled error processing task %d on worker %d",
                            task_id, worker_id,
                        )
                finally:
                    CURRENT_TASK_ID.reset(ctx_token)
                    sem.release()
            except Exception:
                # Outer catch protects the dispatcher loop from a
                # bug in _peek_task_type or the semaphore acquisition.
                logger.exception(
                    "Dispatcher %d failed pre-handler for task %d",
                    worker_id, task_id,
                )
            finally:
                self._queue.task_done()

    @staticmethod
    async def _peek_task_type(task_id: int) -> str:
        """Cheap one-column SELECT so the dispatcher can route to the
        right semaphore without holding a session for the whole task.
        Falls back to ``"unknown"`` (which uses the default budget)
        if the row vanished — _process will surface the missing row."""
        try:
            async with async_session() as session:
                row = (
                    await session.execute(
                        select(BackgroundTask.task_type).where(
                            BackgroundTask.id == task_id,
                        )
                    )
                ).scalar_one_or_none()
                return row or "unknown"
        except Exception:
            return "unknown"

    async def run(self) -> None:
        """Spawn ``_DISPATCHER_WORKERS`` dispatcher coroutines and wait
        forever. Replaces the old single-worker loop while keeping the
        same external contract — ``main.py`` still calls
        ``asyncio.create_task(task_runner.run())`` once."""
        # Capture the main event loop here (we know we're on it).
        # broadcast() uses this when called from worker threads instead
        # of trying asyncio.get_event_loop() which is unreliable on 3.9
        # cross-thread.
        self._main_loop = asyncio.get_running_loop()
        logger.info(
            "TaskRunner started — %d dispatcher workers, "
            "per-type budgets: %s",
            _DISPATCHER_WORKERS, _TYPE_CONCURRENCY,
        )
        await asyncio.gather(
            *(self._dispatcher(i) for i in range(_DISPATCHER_WORKERS)),
            return_exceptions=True,
        )

    async def _process(self, task_id: int) -> None:
        # Bind structlog contextvars for the duration of this task so
        # every log line emitted from any service called downstream
        # automatically carries `task_id`, `task_type`, and `channel_id`.
        # Multi-channel debugging used to require manually grep-ing the
        # log file by task id; with this binding it's a structured
        # filter on the JSON sink. We import lazily so this module
        # doesn't pin a dep on structlog being installed.
        try:
            import structlog
            _ctx_bind = structlog.contextvars.bind_contextvars
            _ctx_clear = structlog.contextvars.clear_contextvars
        except Exception:
            _ctx_bind = lambda **kw: None  # type: ignore[assignment]
            _ctx_clear = lambda: None  # type: ignore[assignment]

        async with async_session() as session:
            result = await session.execute(
                select(BackgroundTask).where(BackgroundTask.id == task_id)
            )
            task = result.scalar_one_or_none()

            if task is None:
                logger.error("Task %d not found", task_id)
                return

            if task.status == "cancelled":
                logger.info("Task %d was cancelled, skipping", task_id)
                return

            # Bind once we know the task is real and not cancelled.
            _ctx_bind(
                task_id=task.id,
                task_type=task.task_type,
                channel_id=task.channel_id,
                project_id=task.project_id,
            )

            handler = _HANDLERS.get(task.task_type)
            if handler is None:
                task.status = "failed"
                task.error = f"Unknown task type: {task.task_type}"
                task.completed_at = datetime.now(timezone.utc)
                await session.commit()
                self.broadcast({"event": "task_update", "task_id": task_id, "status": "failed", "error": task.error})
                _ctx_clear()
                return

            # Mark running
            task.status = "running"
            task.started_at = datetime.now(timezone.utc)
            task.progress = 0.0
            task.status_message = f"Starting {task.task_type}"
            await session.commit()

            self.broadcast({
                "event": "task_update",
                "task_id": task_id,
                "task_type": task.task_type,
                "status": "running",
                "progress": 0.0,
            })

            timeout_seconds = _timeout_for(task.task_type)
            max_retries = _retries_for(task.task_type)

            handler_result: Optional[dict] = None
            last_exc: Optional[BaseException] = None
            for attempt in range(max_retries + 1):
                try:
                    if attempt > 0:
                        # Surface that we're retrying so the UI doesn't look
                        # frozen on a tight retry loop.
                        await session.refresh(task)
                        task.status_message = (
                            f"Retrying {task.task_type} "
                            f"(attempt {attempt + 1}/{max_retries + 1})…"
                        )
                        await session.commit()
                        self.broadcast({
                            "event": "task_update",
                            "task_id": task_id,
                            "task_type": task.task_type,
                            "status": "running",
                            "status_message": task.status_message,
                        })

                    handler_result = await asyncio.wait_for(
                        handler(task, self.broadcast),
                        timeout=timeout_seconds,
                    )
                    last_exc = None
                    break

                except asyncio.TimeoutError as exc:
                    # Convert into our own type so the retry-classifier
                    # treats it as transient (compose timeouts shouldn't
                    # retry by default — they have max_retries=0).
                    last_exc = TimeoutExceededError(
                        f"Task exceeded {int(timeout_seconds)}s timeout "
                        f"for {task.task_type}"
                    )
                    logger.warning(
                        "Task %d (%s) timed out after %ds (attempt %d)",
                        task_id, task.task_type, int(timeout_seconds), attempt + 1,
                    )
                    if attempt < max_retries and _is_retryable(last_exc):
                        await _backoff(attempt)
                        continue
                    break

                except (CredentialError, ValidationError) as exc:
                    # Never retry — operator must fix the underlying issue.
                    last_exc = exc
                    logger.warning(
                        "Task %d (%s) failed permanently: %s",
                        task_id, task.task_type, exc,
                    )
                    break

                except Exception as exc:
                    last_exc = exc
                    logger.exception(
                        "Handler error for task %d (attempt %d/%d)",
                        task_id, attempt + 1, max_retries + 1,
                    )
                    if attempt < max_retries and _is_retryable(exc):
                        await _backoff(attempt)
                        continue
                    break

            if last_exc is None and handler_result is not None:
                # Reload task in case handler used a different session
                await session.refresh(task)
                task.status = "completed"
                task.progress = 100.0
                task.result = handler_result
                task.status_message = "Done"
                task.completed_at = datetime.now(timezone.utc)
                await session.commit()

                self.broadcast({
                    "event": "task_update",
                    "task_id": task_id,
                    "task_type": task.task_type,
                    "status": "completed",
                    "progress": 100.0,
                    "result": handler_result,
                })
                logger.info("Task %d (%s) completed", task_id, task.task_type)

            else:
                exc = last_exc
                await session.refresh(task)
                task.status = "failed"
                task.error = str(exc) if exc else "Unknown error"
                task.completed_at = datetime.now(timezone.utc)

                # For youtube_upload failures, also flip the project.status
                # to "failed" so the Uploads UI can surface the failure and
                # offer a retry. Other task types intentionally keep their
                # project state (e.g. a failed compose should stay composed-
                # ready, not move the project to a terminal failed state).
                if task.task_type == "youtube_upload" and task.project_id:
                    project = await session.get(VideoProject, task.project_id)
                    if project:
                        project.status = "failed"

                await session.commit()

                self.broadcast({
                    "event": "task_update",
                    "task_id": task_id,
                    "task_type": task.task_type,
                    "status": "failed",
                    "error": task.error,
                })

            # Clear the structlog contextvars now that the task is done.
            # If we leave them bound, the next task picked up by the
            # runner would inherit this task's context until it does
            # its own bind — really confusing logs.
            _ctx_clear()


# Module-level singleton
task_runner = TaskRunner()
