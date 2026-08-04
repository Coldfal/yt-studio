from __future__ import annotations

from typing import List, Optional

from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import AutomationPreset, AutomationRun, BackgroundTask
from app.schemas.automation import (
    AutomationPresetCreate,
    AutomationPresetResponse,
    AutomationPresetUpdate,
    AutomationRunResponse,
    ScanFolderRequest,
    ScanFolderResponse,
)
from app.workers.automation_scheduler import compute_next_run
from app.workers.task_runner import task_runner

router = APIRouter(prefix="/api/automation", tags=["automation"])


# ── Presets CRUD ──────────────────────────────────────────────────────────


@router.get("/presets", response_model=List[AutomationPresetResponse])
async def list_presets(
    channel_id: int = None,
    db: AsyncSession = Depends(get_db),
):
    q = select(AutomationPreset).order_by(AutomationPreset.created_at.desc())
    if channel_id:
        q = q.where(AutomationPreset.channel_id == channel_id)
    result = await db.execute(q)
    return [AutomationPresetResponse.model_validate(p) for p in result.scalars()]


@router.get(
    "/channels/{channel_id}/primary-preset",
    response_model=Optional[AutomationPresetResponse],
)
async def get_primary_preset(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> Optional[AutomationPresetResponse]:
    """Return the channel's primary preset (powering the Dashboard's
    one-click "Generate now" button), or null if none is set.

    Falls back to the most recently-updated active preset if no primary is
    explicitly flagged — gives the Dashboard something useful immediately
    on existing channels without forcing a migration.
    """
    # Try the explicit primary first
    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_primary == True,  # noqa: E712
        )
        .limit(1)
    )
    primary = (await db.execute(stmt)).scalar_one_or_none()
    if primary is not None:
        return AutomationPresetResponse.model_validate(primary)

    # Fallback: most recent active preset
    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_active == True,  # noqa: E712
        )
        .order_by(AutomationPreset.updated_at.desc())
        .limit(1)
    )
    fallback = (await db.execute(stmt)).scalar_one_or_none()
    if fallback is not None:
        return AutomationPresetResponse.model_validate(fallback)
    return None


async def _clear_other_primaries(
    db: AsyncSession, channel_id: int, except_id: Optional[int],
) -> None:
    """At most one preset per channel may have is_primary=True."""
    stmt = update(AutomationPreset).where(
        AutomationPreset.channel_id == channel_id,
        AutomationPreset.is_primary == True,  # noqa: E712
    )
    if except_id is not None:
        stmt = stmt.where(AutomationPreset.id != except_id)
    stmt = stmt.values(is_primary=False)
    await db.execute(stmt)


@router.post("/presets", response_model=AutomationPresetResponse, status_code=201)
async def create_preset(
    body: AutomationPresetCreate,
    db: AsyncSession = Depends(get_db),
):
    preset = AutomationPreset(**body.model_dump())

    # Compute initial next_run_at if a cron schedule is provided
    if preset.schedule_cron:
        try:
            preset.next_run_at = compute_next_run(
                preset.schedule_cron, preset.schedule_timezone
            )
        except Exception as e:
            raise HTTPException(status_code=400, detail=f"Invalid cron expression: {e}")

    db.add(preset)
    await db.flush()
    if preset.is_primary:
        await _clear_other_primaries(db, preset.channel_id, preset.id)
    await db.commit()
    await db.refresh(preset)
    return AutomationPresetResponse.model_validate(preset)


@router.get("/presets/{preset_id}", response_model=AutomationPresetResponse)
async def get_preset(
    preset_id: int,
    db: AsyncSession = Depends(get_db),
):
    preset = await db.get(AutomationPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    return AutomationPresetResponse.model_validate(preset)


@router.put("/presets/{preset_id}", response_model=AutomationPresetResponse)
async def update_preset(
    preset_id: int,
    body: AutomationPresetUpdate,
    db: AsyncSession = Depends(get_db),
):
    preset = await db.get(AutomationPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    update_data = body.model_dump(exclude_unset=True)
    for key, value in update_data.items():
        setattr(preset, key, value)

    # Recompute next_run_at if schedule changed
    if "schedule_cron" in update_data or "schedule_timezone" in update_data:
        if preset.schedule_cron:
            try:
                preset.next_run_at = compute_next_run(
                    preset.schedule_cron, preset.schedule_timezone
                )
            except Exception as e:
                raise HTTPException(
                    status_code=400, detail=f"Invalid cron expression: {e}"
                )
        else:
            preset.next_run_at = None

    # Enforce one-primary-per-channel
    if update_data.get("is_primary") is True:
        await _clear_other_primaries(db, preset.channel_id, preset.id)

    await db.commit()
    await db.refresh(preset)
    return AutomationPresetResponse.model_validate(preset)


@router.delete("/presets/{preset_id}", status_code=204)
async def delete_preset(
    preset_id: int,
    db: AsyncSession = Depends(get_db),
):
    preset = await db.get(AutomationPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    await db.delete(preset)
    await db.commit()


# ── Sticky-thumbnail upload + editor-state persist ─────────────────────────
# Mirror of /api/projects/{id}/thumbnail, but writes to the preset's
# default_thumbnail_asset_id + default_thumbnail_editor_state so the
# rendered JPEG becomes the channel's quick-generate sticky thumbnail.

from fastapi import File, Form, UploadFile  # noqa: E402  (used only by the route below)

_THUMB_MAX_BYTES = 2 * 1024 * 1024
_THUMB_MIME = {"image/jpeg", "image/png"}


@router.post("/presets/{preset_id}/thumbnail")
async def save_preset_thumbnail(
    preset_id: int,
    file: UploadFile = File(...),
    editor_state: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Persist a rendered sticky-thumbnail JPEG + editor state for a preset.

    Used by the dashboard's "Design thumbnail" dialog. The browser
    renders the canvas to JPEG, POSTs here as multipart, and we save it
    as an ``asset_type='image'`` asset on the preset's channel — same
    storage path the per-video thumbnail editor uses. The preset's
    ``default_thumbnail_asset_id`` is updated to point at the new
    asset; ``default_thumbnail_editor_state`` round-trips the JSON so
    re-opening the designer restores the layers.

    From here, quick_generate copies the asset id onto every new
    project's ``thumbnail_asset_id``, and the existing YouTube upload
    pipeline ships it via ``youtube.thumbnails().set()``.
    """
    import json as _json
    import logging as _logging
    from app.models import Asset
    from app.utils.file_utils import save_upload_file

    _logger = _logging.getLogger(__name__)

    preset = await db.get(AutomationPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    if file.content_type not in _THUMB_MIME:
        raise HTTPException(
            status_code=400,
            detail=f"Thumbnail must be JPEG or PNG; got {file.content_type!r}.",
        )

    content = await file.read()
    if len(content) > _THUMB_MAX_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Thumbnail is {len(content)} bytes — YouTube caps custom "
                f"thumbnails at {_THUMB_MAX_BYTES} (2 MiB)."
            ),
        )

    ext = "jpg" if file.content_type == "image/jpeg" else "png"
    filename = f"sticky_preset{preset_id}.{ext}"
    filepath, file_size = save_upload_file(
        preset.channel_id, "image", filename, content,
    )

    asset = Asset(
        channel_id=preset.channel_id,
        asset_type="image",
        role="thumbnail",
        source="generated",
        filename=filename,
        filepath=filepath,
        file_size=file_size,
        mime_type=file.content_type,
        title=f"Sticky thumbnail for preset {preset_id}",
    )
    db.add(asset)
    await db.flush()

    preset.default_thumbnail_asset_id = asset.id
    if editor_state is not None:
        try:
            preset.default_thumbnail_editor_state = _json.loads(editor_state)
        except _json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"editor_state is not valid JSON: {exc}",
            ) from exc

    await db.commit()
    await db.refresh(asset)

    _logger.info(
        "Sticky thumbnail saved: preset=%d asset=%d filepath=%s (%d bytes)",
        preset_id, asset.id, filepath, file_size,
    )
    return {
        "asset_id": asset.id,
        "filepath": filepath,
        "file_url": f"/files/{filepath}",
        "file_size": file_size,
    }


# ── Trigger a manual run ──────────────────────────────────────────────────


@router.post("/presets/{preset_id}/trigger")
async def trigger_run(
    preset_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Manually trigger an automation run now."""
    preset = await db.get(AutomationPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    task = BackgroundTask(
        task_type="automation_run",
        status="pending",
        channel_id=preset.channel_id,
        result={"preset_id": preset.id},
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    await task_runner.enqueue(task.id)
    return {"task_id": task.id, "message": "Automation run started"}


# ── Quick Generate primary-preset getter ──────────────────────────────────


@router.post(
    "/channels/{channel_id}/ensure-quick-generate-preset",
    response_model=AutomationPresetResponse,
)
async def ensure_quick_generate_preset(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> AutomationPresetResponse:
    """Return the channel's primary preset, creating one with sensible
    defaults if none exists. Lets the dashboard's Quick Generate panel
    PATCH settings without forcing the user to first walk through preset
    creation in the Automation tab.
    """
    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_primary == True,  # noqa: E712
        )
        .limit(1)
    )
    preset = (await db.execute(stmt)).scalar_one_or_none()
    if preset is not None:
        return AutomationPresetResponse.model_validate(preset)

    # Fall back to most-recent active and promote it to primary
    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_active == True,  # noqa: E712
        )
        .order_by(AutomationPreset.updated_at.desc())
        .limit(1)
    )
    candidate = (await db.execute(stmt)).scalar_one_or_none()
    if candidate is not None:
        candidate.is_primary = True
        await db.commit()
        await db.refresh(candidate)
        return AutomationPresetResponse.model_validate(candidate)

    # No preset at all — create a stub primary one
    new = AutomationPreset(
        channel_id=channel_id,
        name="Quick Generate",
        is_active=True,
        is_primary=True,
        music_folder_path="",
        image_folder_path="",
        image_source="folder",
        target_duration_seconds=3600,
        video_style="spectrum",
        metadata_mode="claude",
        youtube_privacy="private",
        youtube_category_id="10",
        auto_upload=False,
    )
    db.add(new)
    await db.commit()
    await db.refresh(new)
    return AutomationPresetResponse.model_validate(new)


# ── Quick Generate dashboard preview ──────────────────────────────────────


@router.get("/channels/{channel_id}/quick-generate-preview")
async def quick_generate_preview(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Return the image asset that would be used on the next Quick Generate run.

    Auto-rotates the pinned ``next_image_asset_id`` if it hasn't been
    refreshed in 24 hours so the dashboard shows a fresh image each day
    without the user clicking reroll. Falls back to picking on-demand
    when no preset exists.
    """
    from datetime import datetime, timedelta
    from app.models import Asset
    from app.services.automation_service import automation_service

    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_primary == True,  # noqa: E712
        )
        .limit(1)
    )
    preset = (await db.execute(stmt)).scalar_one_or_none()
    if preset is None:
        stmt = (
            select(AutomationPreset)
            .where(
                AutomationPreset.channel_id == channel_id,
                AutomationPreset.is_active == True,  # noqa: E712
            )
            .order_by(AutomationPreset.updated_at.desc())
            .limit(1)
        )
        preset = (await db.execute(stmt)).scalar_one_or_none()

    pinned_id = preset.next_image_asset_id if preset else None
    last_pick = preset.next_image_picked_at if preset else None
    is_locked = bool(getattr(preset, "next_image_pinned", False)) if preset else False
    # When the user has explicitly LOCKED the image, never auto-rotate —
    # the whole point of the pin is "this video series uses one fixed
    # background." Only the reroll button (which clears the lock) can
    # change it.
    needs_rotate = (not is_locked) and (
        last_pick is None
        or (datetime.utcnow() - last_pick) > timedelta(hours=24)
    )

    chosen = None
    if pinned_id and not needs_rotate:
        chosen = await db.get(Asset, pinned_id)
        if not chosen or chosen.channel_id != channel_id:
            chosen = None

    if chosen is None:
        chosen = await automation_service._select_image_from_library(channel_id)
        if chosen and preset:
            preset.next_image_asset_id = chosen.id
            preset.next_image_picked_at = datetime.utcnow()
            await db.commit()

    return {
        "image": (
            {
                "id": chosen.id,
                "filename": chosen.filename,
                "file_url": f"/files/{chosen.filepath}",
                "title": chosen.title,
                # Frontend uses this to render <video> instead of <img>
                # when the picked background is an MP4 / WebM.
                "asset_type": chosen.asset_type,
            }
            if chosen
            else None
        ),
        "rotated": needs_rotate and chosen is not None,
        "preset_id": preset.id if preset else None,
        "pinned": is_locked,
    }


@router.post("/channels/{channel_id}/quick-generate-preview/reroll")
async def quick_generate_preview_reroll(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Force a fresh random image pick for the dashboard preview."""
    from datetime import datetime
    from app.services.automation_service import automation_service

    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_primary == True,  # noqa: E712
        )
        .limit(1)
    )
    preset = (await db.execute(stmt)).scalar_one_or_none()

    # Reroll explicitly draws from the FULL library, including images that
    # have shipped before. The default daily rotation prefers unused images
    # so a fresh look surfaces over time, but when the user clicks Reroll
    # they want to shuffle every option — restricting to unused made the
    # button feel like it only had 2-3 picks on mature channels.
    chosen = await automation_service._select_image_from_library(
        channel_id, include_used=True,
    )
    if chosen is None:
        raise HTTPException(status_code=404, detail="No images in library")
    if preset:
        preset.next_image_asset_id = chosen.id
        preset.next_image_picked_at = datetime.utcnow()
        # Reroll explicitly clears any image lock — if the user wanted a
        # different image, they no longer want the previous one frozen.
        preset.next_image_pinned = False
        await db.commit()
    return {
        "image": {
            "id": chosen.id,
            "filename": chosen.filename,
            "file_url": f"/files/{chosen.filepath}",
            "title": chosen.title,
            "asset_type": chosen.asset_type,
        },
        "preset_id": preset.id if preset else None,
        "pinned": False,
    }


class SetQuickGenImageRequest(BaseModel):
    asset_id: int


@router.post("/channels/{channel_id}/quick-generate-preview/set")
async def set_quick_generate_image(
    channel_id: int,
    body: SetQuickGenImageRequest,
    db: AsyncSession = Depends(get_db),
):
    """Manually set the background asset that the next Quick Generate
    run will use. Used by the dashboard's "Pick background" dialog so
    the user can choose a specific image/video instead of relying on
    the daily auto-rotation or the Reroll button. Auto-locks the pick
    (``next_image_pinned=True``) — picking an exact bg implies the
    user wants it to stick across runs.
    """
    from app.models import Asset

    asset = await db.get(Asset, body.asset_id)
    if asset is None or asset.channel_id != channel_id:
        raise HTTPException(status_code=404, detail="Asset not found for this channel")
    if asset.asset_type not in ("image", "video"):
        raise HTTPException(
            status_code=400,
            detail=f"Asset type '{asset.asset_type}' cannot be used as a background",
        )

    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_primary == True,  # noqa: E712
        )
        .limit(1)
    )
    preset = (await db.execute(stmt)).scalar_one_or_none()
    if preset is None:
        stmt = (
            select(AutomationPreset)
            .where(
                AutomationPreset.channel_id == channel_id,
                AutomationPreset.is_active == True,  # noqa: E712
            )
            .order_by(AutomationPreset.updated_at.desc())
            .limit(1)
        )
        preset = (await db.execute(stmt)).scalar_one_or_none()
    if preset is None:
        raise HTTPException(status_code=404, detail="No active preset for channel")

    preset.next_image_asset_id = asset.id
    preset.next_image_picked_at = datetime.utcnow()
    preset.next_image_pinned = True
    await db.commit()

    return {
        "image": {
            "id": asset.id,
            "filename": asset.filename,
            "file_url": f"/files/{asset.filepath}",
            "title": asset.title,
            "asset_type": asset.asset_type,
        },
        "preset_id": preset.id,
        "pinned": True,
    }


@router.post("/channels/{channel_id}/quick-generate-preview/full")
async def quick_generate_preview_full(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Dry-run preview of Quick Generate. Picks an image, selects tracks,
    runs the metadata generator — but DOES NOT create a VideoProject or
    fire compose. Returns the full would-be package so the dashboard
    can render a preview drawer (Phase 1 of the farm-redesign roadmap).

    The operator gets to see exactly what title/description/tags will
    ship + the picked background + the count of tracks + the sticky
    thumbnail (if any) before committing. They can Re-roll (call this
    endpoint again — fresh image + fresh tracks + fresh metadata) or
    approve (call ``/quick-generate``).
    """
    from app.services.automation_service.quick_generate import (
        build_quick_generate_package,
    )

    # Resolve the channel's primary preset (same lookup the real
    # /quick-generate endpoint does), so the preview matches what would
    # actually fire.
    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_active == True,  # noqa: E712
            AutomationPreset.is_primary == True,  # noqa: E712
        )
        .order_by(AutomationPreset.id.desc())
        .limit(1)
    )
    preset = (await db.execute(stmt)).scalar_one_or_none()
    preset_id = preset.id if preset else None

    try:
        pkg = await build_quick_generate_package(
            channel_id=channel_id,
            preset_id=preset_id,
            on_progress=None,  # no streaming for preview — front-end shows a spinner
        )
    except ValueError as exc:
        # Friendly pre-flight failures (empty library, etc.). The
        # exception messages from build_quick_generate_package are
        # already operator-facing.
        raise HTTPException(status_code=400, detail=str(exc))
    except Exception as exc:
        # Anything else (Claude CLI timeout, etc.) — surface a clean
        # 502 with an actionable message instead of a bare 500. The
        # metadata fallback in _generate_metadata_claude catches Claude
        # failures, so reaching this branch means something upstream
        # (asset pick, track select) actually broke.
        import logging as _logging
        _logging.getLogger(__name__).exception(
            "quick-generate-preview/full failed for channel %d", channel_id,
        )
        raise HTTPException(
            status_code=502,
            detail=(
                f"Preview failed: {exc}. Try again — if it keeps failing, "
                f"the channel's library or preset may be misconfigured."
            ),
        )
    return pkg


class QuickGenerateRequest(BaseModel):
    """Body for POST /quick-generate. ``approved_package`` is the dict
    returned by ``/quick-generate-preview/full`` — when supplied, the
    task-runner reuses those picks instead of re-rolling. Empty body
    keeps the legacy random-pick behaviour for clients that don't go
    through the preview drawer.
    """

    approved_package: Optional[dict] = None


@router.post("/channels/{channel_id}/quick-generate")
async def quick_generate(
    channel_id: int,
    body: Optional[QuickGenerateRequest] = None,
    db: AsyncSession = Depends(get_db),
):
    """One-click generation using channel **library** assets (no folder scanning).

    Picks random tracks, selects an unused image (deduped against published
    videos), composes with the channel's last-used visualizer settings (or the
    primary preset's config), then optionally uploads to YouTube.

    Uses the channel's primary preset settings (duration, visualizer, upload
    flag) when one is configured; falls back to sensible defaults otherwise.

    When ``body.approved_package`` is provided (Phase-1 preview-drawer flow),
    the previewed image / tracks / metadata are honoured verbatim — no
    re-rolling between Approve and compose.
    """
    # Find primary preset for settings (optional)
    stmt = (
        select(AutomationPreset)
        .where(
            AutomationPreset.channel_id == channel_id,
            AutomationPreset.is_primary == True,  # noqa: E712
        )
        .limit(1)
    )
    primary = (await db.execute(stmt)).scalar_one_or_none()

    # Fall back to most-recent active preset
    if primary is None:
        stmt = (
            select(AutomationPreset)
            .where(
                AutomationPreset.channel_id == channel_id,
                AutomationPreset.is_active == True,  # noqa: E712
            )
            .order_by(AutomationPreset.updated_at.desc())
            .limit(1)
        )
        primary = (await db.execute(stmt)).scalar_one_or_none()

    approved_pkg = body.approved_package if body else None
    task_result: dict = {
        "quick": True,
        "channel_id": channel_id,
        "preset_id": primary.id if primary else None,
    }
    if approved_pkg:
        task_result["approved_package"] = approved_pkg

    task = BackgroundTask(
        task_type="automation_run",
        status="pending",
        channel_id=channel_id,
        result=task_result,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await task_runner.enqueue(task.id)
    return {
        "task_id": task.id,
        "preset_id": primary.id if primary else None,
        "approved": bool(approved_pkg),
    }


# ── Runs list ─────────────────────────────────────────────────────────────


@router.get("/presets/{preset_id}/runs", response_model=List[AutomationRunResponse])
async def list_runs(
    preset_id: int,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
):
    result = await db.execute(
        select(AutomationRun)
        .where(AutomationRun.preset_id == preset_id)
        .order_by(AutomationRun.created_at.desc())
        .limit(limit)
    )
    return [AutomationRunResponse.model_validate(r) for r in result.scalars()]


@router.get("/runs/{run_id}", response_model=AutomationRunResponse)
async def get_run(
    run_id: int,
    db: AsyncSession = Depends(get_db),
):
    run = await db.get(AutomationRun, run_id)
    if not run:
        raise HTTPException(status_code=404, detail="Run not found")
    return AutomationRunResponse.model_validate(run)


# ── Utilities ─────────────────────────────────────────────────────────────


@router.post("/scan-folder", response_model=ScanFolderResponse)
async def scan_folder(body: ScanFolderRequest):
    """Scan a local folder for audio files and return their durations."""
    import asyncio
    from app.utils.audio import scan_audio_folder

    loop = asyncio.get_running_loop()
    try:
        files = await loop.run_in_executor(
            None, scan_audio_folder, body.folder_path, body.extensions
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=400, detail=str(e))

    total = sum(f["duration_seconds"] for f in files)
    return ScanFolderResponse(
        folder_path=body.folder_path,
        file_count=len(files),
        total_duration_seconds=total,
        files=files,
    )


# ── Phase 4: Fleet calendar ────────────────────────────────────────


@router.get("/fleet/schedule")
async def fleet_schedule(
    days: int = 7,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Project the next N days of scheduled runs across ALL active
    primary presets. Drives the Fleet Calendar grid.

    Returns ``{occurrences: [{channel_id, channel_name, preset_id,
    fire_at, cron, timezone}, ...]}``. Each entry is one upcoming
    fire of the cron expression — same preset can appear multiple
    times if it fires more than once in the window.
    """
    from app.models import Channel
    from croniter import croniter
    from datetime import datetime as _dt, timedelta as _td
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore

    if days < 1:
        days = 1
    if days > 30:
        days = 30

    # Pull every active preset with a schedule_cron.
    stmt = (
        select(AutomationPreset, Channel)
        .join(Channel, Channel.id == AutomationPreset.channel_id)
        .where(
            AutomationPreset.is_active == True,  # noqa: E712
            AutomationPreset.schedule_cron.isnot(None),
        )
    )
    rows = (await db.execute(stmt)).all()

    occurrences: list[dict] = []
    now_utc = _dt.utcnow()
    window_end = now_utc + _td(days=days)

    for preset, channel in rows:
        tz_name = preset.schedule_timezone or "UTC"
        try:
            tz = ZoneInfo(tz_name)
        except Exception:
            tz = ZoneInfo("UTC")

        # Use the preset's NEXT run_at as the seed when available so
        # the projection matches what the scheduler will actually do.
        seed_local: _dt
        if preset.next_run_at:
            seed_local = preset.next_run_at.replace(
                tzinfo=ZoneInfo("UTC"),
            ).astimezone(tz)
        else:
            seed_local = _dt.utcnow().replace(
                tzinfo=ZoneInfo("UTC"),
            ).astimezone(tz)

        try:
            cron = croniter(preset.schedule_cron, seed_local)
        except Exception:
            continue

        # Include the seed itself only if it's within the window —
        # next_run_at is the "first fire from now" so it counts.
        if preset.next_run_at and preset.next_run_at <= window_end:
            occurrences.append({
                "channel_id": channel.id,
                "channel_name": channel.name,
                "preset_id": preset.id,
                "fire_at": preset.next_run_at.isoformat(),
                "cron": preset.schedule_cron,
                "timezone": tz_name,
            })

        # Advance forward through the window.
        for _ in range(64):  # safety cap — 64 fires/week is plenty
            next_local = cron.get_next(_dt)
            next_utc = next_local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
            if next_utc > window_end:
                break
            if next_utc <= now_utc:
                continue
            # Deduplicate against the preset.next_run_at if cron
            # happens to land on the same instant.
            if (
                preset.next_run_at
                and abs((next_utc - preset.next_run_at).total_seconds()) < 60
            ):
                continue
            occurrences.append({
                "channel_id": channel.id,
                "channel_name": channel.name,
                "preset_id": preset.id,
                "fire_at": next_utc.isoformat(),
                "cron": preset.schedule_cron,
                "timezone": tz_name,
            })

    # Sort by fire time so the frontend can render in order.
    occurrences.sort(key=lambda r: r["fire_at"])
    return {
        "window_days": days,
        "occurrences": occurrences,
        "now_utc": now_utc.isoformat(),
    }


@router.post("/presets/{preset_id}/skip-next")
async def skip_next_run(
    preset_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Skip the preset's upcoming scheduled fire. Advances
    ``next_run_at`` past the current value to the FOLLOWING cron
    occurrence — operator-friendly way to say 'not today'.
    """
    preset = await db.get(AutomationPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    if not preset.schedule_cron:
        raise HTTPException(
            status_code=400, detail="Preset has no recurring schedule",
        )
    from croniter import croniter
    from datetime import datetime as _dt
    try:
        from zoneinfo import ZoneInfo
    except ImportError:
        from backports.zoneinfo import ZoneInfo  # type: ignore

    tz_name = preset.schedule_timezone or "UTC"
    try:
        tz = ZoneInfo(tz_name)
    except Exception:
        tz = ZoneInfo("UTC")

    # Seed from CURRENT next_run_at (or now if missing), step ONE
    # forward, that's the new next_run_at.
    if preset.next_run_at:
        seed = preset.next_run_at.replace(
            tzinfo=ZoneInfo("UTC"),
        ).astimezone(tz)
    else:
        seed = _dt.utcnow().replace(tzinfo=ZoneInfo("UTC")).astimezone(tz)
    cron = croniter(preset.schedule_cron, seed)
    next_local = cron.get_next(_dt)
    preset.next_run_at = next_local.astimezone(ZoneInfo("UTC")).replace(tzinfo=None)
    await db.commit()
    return {
        "preset_id": preset.id,
        "new_next_run_at": preset.next_run_at.isoformat(),
    }
