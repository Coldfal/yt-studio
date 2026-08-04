from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, Depends, HTTPException, Request, Response, UploadFile, File, Form
from fastapi.responses import FileResponse, StreamingResponse
from pydantic import BaseModel
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.config import settings
from app.database import get_db
from app.models import Asset
from app.models.asset import AssetFolder
from app.schemas.asset import AssetResponse, AssetFolderResponse
from app.utils.file_utils import save_upload_file, get_mime_type, delete_asset_file, get_asset_dir
from app.utils.ffmpeg import get_audio_duration

import logging

logger = logging.getLogger(__name__)


def _probe_duration(asset_type: str, filepath: str) -> Optional[float]:
    """Best-effort ffprobe audio duration. Returns None for non-media or on failure."""
    if asset_type not in ("music", "video"):
        return None
    try:
        full = settings.assets_dir / filepath
        return get_audio_duration(str(full))
    except Exception as exc:
        logger.warning("ffprobe duration failed for %s: %s", filepath, exc)
        return None

router = APIRouter(prefix="/api/assets", tags=["assets"])


def _asset_to_response(asset: Asset) -> AssetResponse:
    # Existence check — fast (microseconds, no I/O beyond a stat). Lets the
    # frontend show a "missing" badge on cards whose underlying file has
    # been deleted from disk so the user can review + clean up via the
    # existing reconcile flow rather than discovering missing files when
    # a render fails.
    abs_path = settings.assets_dir / asset.filepath
    file_exists = abs_path.exists()

    return AssetResponse(
        id=asset.id,
        channel_id=asset.channel_id,
        asset_type=asset.asset_type,
        role=getattr(asset, "role", None),
        source=asset.source,
        filename=asset.filename,
        filepath=asset.filepath,
        file_url=f"/files/{asset.filepath}",
        file_size=asset.file_size,
        duration_seconds=asset.duration_seconds,
        mime_type=asset.mime_type,
        prompt=asset.prompt,
        title=asset.title,
        description=asset.description,
        folder_id=asset.folder_id,
        folder_name=asset.folder.name if asset.folder else None,
        file_exists=file_exists,
        created_at=asset.created_at,
    )


# -----------------------------------------------------------------------
# Collection-level routes  (no path parameter – must come first)
# -----------------------------------------------------------------------

@router.get("/counts")
async def asset_counts(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return per-asset-type counts for a channel.

    Used by the dashboard's Quick Generate pre-flight banner so a card
    can warn early when a channel has zero music or zero backgrounds
    (which would otherwise blow up mid-render). Cheap: one grouped
    COUNT query.
    """
    stmt = (
        select(Asset.asset_type, sa_func.count(Asset.id))
        .where(Asset.channel_id == channel_id)
        .group_by(Asset.asset_type)
    )
    result = await db.execute(stmt)
    counts = {row[0]: int(row[1]) for row in result.all()}
    return {
        "music": counts.get("music", 0),
        "image": counts.get("image", 0),
        "video": counts.get("video", 0),
        # ``background`` is the practical concept: image OR video can
        # drive a render (compose detects video by extension and routes
        # to the chromakey-overlay pipeline).
        "background": counts.get("image", 0) + counts.get("video", 0),
    }


@router.get("/", response_model=list[AssetResponse])
async def list_assets(
    channel_id: Optional[int] = None,
    asset_type: Optional[str] = None,
    role: Optional[str] = None,
    source: Optional[str] = None,
    folder_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
) -> list[AssetResponse]:
    stmt = select(Asset).options(selectinload(Asset.folder))
    if channel_id is not None:
        stmt = stmt.where(Asset.channel_id == channel_id)
    if asset_type is not None:
        stmt = stmt.where(Asset.asset_type == asset_type)
    if role is not None:
        # Per-asset role filter (Phase 0 of farm redesign). Used by the
        # Library's sub-tabs (Backgrounds / Thumbnails / Overlays /
        # Reference). Pass ``role=background`` to get only video-bg
        # candidates.
        stmt = stmt.where(Asset.role == role)
    if source is not None:
        stmt = stmt.where(Asset.source == source)
    if folder_id is not None:
        stmt = stmt.where(Asset.folder_id == folder_id)

    result = await db.execute(stmt)
    assets = result.scalars().all()
    return [_asset_to_response(a) for a in assets]


@router.post("/upload", response_model=AssetResponse, status_code=201)
async def upload_asset(
    file: UploadFile = File(...),
    channel_id: int = Form(...),
    asset_type: str = Form(...),
    role: Optional[str] = Form(None),
    title: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    replace_existing: bool = Form(False),
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    """Upload an asset. If ``replace_existing`` is true and an asset with the
    same filename already exists on this channel (same asset_type), the
    existing asset row is updated in place (so references from projects don't
    break) and the old file is replaced on disk.
    """
    content = await file.read()
    mime_type = get_mime_type(file.filename)

    if replace_existing:
        existing_stmt = select(Asset).where(
            Asset.channel_id == channel_id,
            Asset.asset_type == asset_type,
            Asset.filename == file.filename,
        )
        existing = (await db.execute(existing_stmt)).scalar_one_or_none()
        if existing is not None:
            # Remove the old file on disk (best-effort)
            try:
                old_full = settings.assets_dir / existing.filepath
                if old_full.exists():
                    old_full.unlink()
            except OSError:
                pass
            filepath, file_size = save_upload_file(
                channel_id, asset_type, file.filename, content
            )
            existing.filepath = filepath
            existing.file_size = file_size
            existing.mime_type = mime_type
            if title is not None:
                existing.title = title
            if description is not None:
                existing.description = description
            # Re-probe duration now that the underlying file changed
            existing.duration_seconds = _probe_duration(asset_type, filepath)
            await db.commit()
            await db.refresh(existing)
            return _asset_to_response(existing)

    filepath, file_size = save_upload_file(
        channel_id, asset_type, file.filename, content
    )

    # Default role for uploads: "background" for image type when the
    # operator didn't specify. Music / video / composed don't use role.
    resolved_role: Optional[str] = (role.strip() or None) if role else None
    if resolved_role is None and asset_type == "image":
        resolved_role = "background"

    asset = Asset(
        channel_id=channel_id,
        asset_type=asset_type,
        role=resolved_role,
        source="imported",
        filename=file.filename,
        filepath=filepath,
        file_size=file_size,
        mime_type=mime_type,
        title=title,
        description=description,
        duration_seconds=_probe_duration(asset_type, filepath),
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    return _asset_to_response(asset)


class ImportFolderRequest(BaseModel):
    channel_id: int
    asset_type: str = "music"
    folder_path: str
    recursive: bool = True
    skip_existing: bool = True
    extensions: Optional[list[str]] = None  # None → defaults per asset_type


_DEFAULT_EXTS: dict[str, list[str]] = {
    "music": [".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"],
    "image": [".jpg", ".jpeg", ".png", ".webp", ".gif"],
    "video": [".mp4", ".webm", ".mov", ".mkv"],
}


@router.post("/import-folder")
async def import_folder(
    body: ImportFolderRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Import every matching file in a local filesystem folder into the
    channel's asset library — server-side copy, no HTTP upload.

    Way faster + more reliable than POSTing each file's bytes through the
    browser when frontend and backend run on the same machine. Returns
    counts and the new asset IDs.
    """
    src_dir = Path(body.folder_path).expanduser()
    if not src_dir.exists() or not src_dir.is_dir():
        raise HTTPException(
            status_code=400,
            detail=f"Folder not found: {body.folder_path}",
        )

    exts = body.extensions or _DEFAULT_EXTS.get(body.asset_type, [])
    if not exts:
        raise HTTPException(
            status_code=400,
            detail=f"No extension filter for asset_type={body.asset_type}",
        )
    exts_lower = {e.lower() for e in exts}

    # Walk the folder
    iterator = src_dir.rglob("*") if body.recursive else src_dir.iterdir()
    candidates: list[Path] = []
    for p in iterator:
        if p.is_file() and p.suffix.lower() in exts_lower:
            candidates.append(p)

    if not candidates:
        return {
            "scanned": 0, "imported": 0, "skipped_existing": 0,
            "failed": 0, "asset_ids": [],
        }

    # Pre-fetch existing filenames for skip-existing
    existing_names: set[str] = set()
    if body.skip_existing:
        stmt = select(Asset).where(
            Asset.channel_id == body.channel_id,
            Asset.asset_type == body.asset_type,
        )
        rows = (await db.execute(stmt)).scalars().all()
        existing_names = {a.filename.lower() for a in rows}

    imported_ids: list[int] = []
    skipped = 0
    failed = 0

    import shutil

    for src in candidates:
        try:
            if body.skip_existing and src.name.lower() in existing_names:
                skipped += 1
                continue
            # Reuse the same prefix scheme as save_upload_file so we don't
            # collide with prior imports of same-named files.
            from uuid import uuid4
            prefix = uuid4().hex[:8]
            safe_name = f"{prefix}_{src.name}"
            target_dir = get_asset_dir(body.channel_id, body.asset_type)
            target_path = target_dir / safe_name

            shutil.copy2(src, target_path)
            file_size = target_path.stat().st_size
            relative = target_path.relative_to(settings.assets_dir).as_posix()
            mime_type = get_mime_type(src.name)

            asset = Asset(
                channel_id=body.channel_id,
                asset_type=body.asset_type,
                # Bulk-imported images default to "background" — the
                # operator's importing a folder of pictures, almost
                # always for use as video backgrounds. Re-tag via the
                # library UI if needed.
                role="background" if body.asset_type == "image" else None,
                source="imported",
                filename=src.name,
                filepath=relative,
                file_size=file_size,
                mime_type=mime_type,
                duration_seconds=_probe_duration(body.asset_type, relative),
            )
            db.add(asset)
            await db.flush()
            imported_ids.append(asset.id)
            existing_names.add(src.name.lower())
        except Exception as exc:
            logger.warning("import-folder: failed %s: %s", src, exc)
            failed += 1

    await db.commit()
    return {
        "scanned": len(candidates),
        "imported": len(imported_ids),
        "skipped_existing": skipped,
        "failed": failed,
        "asset_ids": imported_ids,
    }


@router.post("/reconcile")
async def reconcile_assets(
    channel_id: Optional[int] = None,
    asset_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Delete Asset rows whose underlying file no longer exists on disk.

    Use after manually removing files from the data/assets folder so the
    frontend doesn't keep listing ghost entries. Optionally scope by
    channel_id and/or asset_type. Returns counts; safe to re-run.
    """
    stmt = select(Asset)
    if channel_id is not None:
        stmt = stmt.where(Asset.channel_id == channel_id)
    if asset_type is not None:
        stmt = stmt.where(Asset.asset_type == asset_type)
    assets = list((await db.execute(stmt)).scalars().all())

    removed_ids: list[int] = []
    for a in assets:
        try:
            full = settings.assets_dir / a.filepath
            if not full.exists():
                removed_ids.append(a.id)
                await db.delete(a)
        except Exception as exc:  # pragma: no cover — best-effort
            logger.warning("reconcile: skipping %s (%s)", a.filepath, exc)
    await db.commit()
    return {
        "scanned": len(assets),
        "removed": len(removed_ids),
        "removed_ids": removed_ids,
    }


@router.post("/scan-disk")
async def scan_disk_for_orphans(
    channel_id: Optional[int] = None,
    asset_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Walk the channel's asset folders and create Asset rows for files
    that don't have one yet ("orphan files" / "manual drops").

    The inverse of ``/reconcile``: that one deletes DB rows whose file is
    gone; this one creates DB rows for files whose DB row is missing.
    Lets the user drop new audio/images into ``data/assets/{N}/{type}/``
    via Windows Explorer (or any other tool) and have them appear in the
    Library without going through the upload UI.

    Scope: ``channel_id`` is required to keep the walk bounded — we
    never auto-adopt across every channel at once. ``asset_type`` is
    optional; when omitted, every type subfolder under the channel
    gets scanned.

    For each adopted file we set:
    - ``channel_id`` from the URL
    - ``asset_type`` from the directory name
    - ``filename`` from the file's basename
    - ``filepath`` relative to ``settings.assets_dir``
    - ``file_size`` via stat
    - ``duration_seconds`` via ffprobe (audio + video only)
    - ``source = "manual"`` (so the audit shows where the row came from)
    - ``mime_type`` guessed from extension
    - ``folder_id = NULL`` (user can re-folder afterwards)

    Idempotent: re-running skips files that already have a row.
    """
    import mimetypes
    from app.utils.audio import get_audio_duration

    if channel_id is None:
        raise HTTPException(
            status_code=400,
            detail="channel_id is required (scan-disk doesn't span channels)",
        )

    # Verify the channel exists — otherwise we'd happily create rows
    # pointing at an unowned directory.
    from app.models.channel import Channel as ChannelModel
    channel = await db.get(ChannelModel, int(channel_id))
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    # Asset types we know how to adopt. Image/video sit on the same
    # filesystem, just with different mime types. Composed videos are
    # produced by the engine — adopting random files into "composed"
    # would be confusing — so we don't include it here.
    SUPPORTED_TYPES = {"music", "image", "video", "thumbnail"}
    AUDIO_EXTS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac"}
    IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".webp", ".gif"}
    VIDEO_EXTS = {".mp4", ".mov", ".webm", ".mkv"}

    types_to_scan = (
        [asset_type] if asset_type else list(SUPPORTED_TYPES)
    )
    if asset_type and asset_type not in SUPPORTED_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"asset_type must be one of {sorted(SUPPORTED_TYPES)}",
        )

    # Pull existing filepaths once so we can skip in O(1).
    known_stmt = select(Asset.filepath).where(Asset.channel_id == channel_id)
    known_paths: set[str] = set(
        (await db.execute(known_stmt)).scalars().all()
    )

    adopted_ids: list[int] = []
    scanned = 0
    skipped_existing = 0
    skipped_unsupported = 0

    loop = asyncio.get_running_loop()

    for type_name in types_to_scan:
        type_dir = settings.assets_dir / str(channel_id) / type_name
        if not type_dir.exists() or not type_dir.is_dir():
            continue

        for entry in type_dir.iterdir():
            if not entry.is_file():
                continue
            scanned += 1
            rel = entry.relative_to(settings.assets_dir).as_posix()

            if rel in known_paths:
                skipped_existing += 1
                continue

            ext = entry.suffix.lower()
            # Validate ext matches type folder so we don't adopt
            # random text files into the music library.
            if type_name == "music" and ext not in AUDIO_EXTS:
                skipped_unsupported += 1
                continue
            if type_name in ("image", "thumbnail") and ext not in IMAGE_EXTS:
                skipped_unsupported += 1
                continue
            if type_name == "video" and ext not in VIDEO_EXTS:
                skipped_unsupported += 1
                continue

            # File size + (for audio/video) duration probe.
            try:
                size = entry.stat().st_size
            except OSError as exc:
                logger.warning(
                    "scan-disk: skipping %s — stat failed: %s", rel, exc,
                )
                continue

            duration: Optional[float] = None
            if type_name == "music" or type_name == "video":
                try:
                    duration = await loop.run_in_executor(
                        None, get_audio_duration, str(entry),
                    )
                    if duration is not None and duration <= 0:
                        duration = None
                except Exception as exc:
                    logger.warning(
                        "scan-disk: ffprobe failed on %s (%s); "
                        "adopting without duration",
                        rel, exc,
                    )

            mime, _ = mimetypes.guess_type(entry.name)

            new_asset = Asset(
                channel_id=int(channel_id),
                asset_type=type_name,
                # Disk-scan adopts whatever images are sitting in the
                # channel's image folder. Default to "background"; the
                # operator can re-tag any that are actually thumbnails
                # or overlays via the library UI.
                role="background" if type_name == "image" else None,
                source="manual",
                filename=entry.name,
                filepath=rel,
                file_size=size,
                duration_seconds=duration,
                mime_type=mime,
                title=None,
                description=None,
                folder_id=None,
            )
            db.add(new_asset)
            await db.flush()
            adopted_ids.append(new_asset.id)
            known_paths.add(rel)  # avoid re-adopt within this run

    await db.commit()

    return {
        "scanned": scanned,
        "adopted": len(adopted_ids),
        "skipped_existing": skipped_existing,
        "skipped_unsupported": skipped_unsupported,
        "adopted_ids": adopted_ids,
    }


@router.post("/backfill-durations")
async def backfill_durations(
    channel_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One-off: probe ffprobe duration for every music asset that's missing it.

    Call with ?channel_id=X to scope. Returns counts; safe to re-run.
    """
    stmt = select(Asset).where(
        Asset.asset_type == "music",
        Asset.duration_seconds.is_(None),
    )
    if channel_id is not None:
        stmt = stmt.where(Asset.channel_id == channel_id)
    assets = list((await db.execute(stmt)).scalars().all())

    updated = 0
    skipped = 0
    for a in assets:
        d = _probe_duration(a.asset_type, a.filepath)
        if d and d > 0:
            a.duration_seconds = d
            updated += 1
        else:
            skipped += 1
    await db.commit()
    return {"scanned": len(assets), "updated": updated, "skipped": skipped}


# -----------------------------------------------------------------------
# Folder management  (fixed string paths – must come before {asset_id})
# -----------------------------------------------------------------------

@router.get("/folders", response_model=list[AssetFolderResponse])
async def list_folders(
    channel_id: Optional[int] = None,
    asset_type: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
) -> list[AssetFolderResponse]:
    """List folders, optionally filtered by channel_id and/or asset_type."""
    stmt = select(AssetFolder)
    if channel_id is not None:
        stmt = stmt.where(AssetFolder.channel_id == channel_id)
    if asset_type:
        stmt = stmt.where(AssetFolder.asset_type == asset_type)
    stmt = stmt.order_by(
        AssetFolder.channel_id, AssetFolder.asset_type, AssetFolder.name,
    )
    result = await db.execute(stmt)
    folders = result.scalars().all()

    # Count assets per folder
    count_stmt = (
        select(Asset.folder_id, sa_func.count(Asset.id))
        .where(Asset.folder_id.isnot(None))
        .group_by(Asset.folder_id)
    )
    count_result = await db.execute(count_stmt)
    counts = dict(count_result.all())

    return [
        AssetFolderResponse(
            id=f.id,
            channel_id=f.channel_id,
            asset_type=f.asset_type,
            name=f.name,
            pair_group=f.pair_group,
            asset_count=counts.get(f.id, 0),
            created_at=f.created_at,
        )
        for f in folders
    ]


@router.post("/folders", response_model=AssetFolderResponse, status_code=201)
async def create_folder(
    payload: dict,
    db: AsyncSession = Depends(get_db),
) -> AssetFolderResponse:
    """Create a new folder. Requires channel_id, asset_type, name."""
    channel_id = payload.get("channel_id")
    asset_type = (payload.get("asset_type") or "").strip()
    name = (payload.get("name") or "").strip()
    if not channel_id or not asset_type or not name:
        raise HTTPException(
            status_code=400,
            detail="channel_id, asset_type, and name are required",
        )

    # Verify channel exists (cheap; CASCADE on the FK would also catch
    # this, but a 404 here is friendlier than an IntegrityError).
    from app.models.channel import Channel
    channel = await db.get(Channel, int(channel_id))
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    # Reject duplicates up-front rather than letting the unique index
    # raise an IntegrityError.
    existing_stmt = select(AssetFolder).where(
        AssetFolder.channel_id == int(channel_id),
        AssetFolder.asset_type == asset_type,
        AssetFolder.name == name,
    )
    if (await db.execute(existing_stmt)).scalar_one_or_none():
        raise HTTPException(
            status_code=409,
            detail=f"Folder '{name}' already exists for this channel + type",
        )

    folder = AssetFolder(
        channel_id=int(channel_id), asset_type=asset_type, name=name,
    )
    db.add(folder)
    await db.commit()
    await db.refresh(folder)
    return AssetFolderResponse(
        id=folder.id,
        channel_id=folder.channel_id,
        asset_type=folder.asset_type,
        name=folder.name,
        pair_group=folder.pair_group,
        asset_count=0,
        created_at=folder.created_at,
    )


@router.put("/folders/{folder_id}", response_model=AssetFolderResponse)
async def rename_folder(
    folder_id: int,
    payload: dict,
    db: AsyncSession = Depends(get_db),
) -> AssetFolderResponse:
    """Update a folder. Supports renaming (``name``) and tagging
    folders for image-music pairing (``pair_group``). Both keys are
    optional; pass either or both.

    ``pair_group``: free-text label that ties folders across asset
    types together. When two folders (e.g. an image folder and a
    music folder) share the same value, channels with
    ``AutomationPreset.use_folder_pairing=True`` constrain Quick
    Generate's music selection to match the picked image's group.
    Empty string is normalised to NULL.
    """
    folder = await db.get(AssetFolder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    if "name" in payload:
        name = (payload.get("name") or "").strip()
        if not name:
            raise HTTPException(status_code=400, detail="name is required")
        folder.name = name
    if "pair_group" in payload:
        # Allow null/empty to clear the group label.
        raw = payload.get("pair_group")
        cleaned = (raw or "").strip() if isinstance(raw, str) else None
        folder.pair_group = cleaned or None
    await db.commit()
    await db.refresh(folder)

    count_stmt = select(sa_func.count(Asset.id)).where(Asset.folder_id == folder_id)
    count_result = await db.execute(count_stmt)
    count = count_result.scalar() or 0

    return AssetFolderResponse(
        id=folder.id,
        channel_id=folder.channel_id,
        asset_type=folder.asset_type,
        name=folder.name,
        pair_group=folder.pair_group,
        asset_count=count,
        created_at=folder.created_at,
    )


@router.delete("/folders/{folder_id}", status_code=204, response_class=Response)
async def delete_folder(
    folder_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Delete a folder. Assets in the folder become unfiled (folder_id=NULL)."""
    folder = await db.get(AssetFolder, folder_id)
    if not folder:
        raise HTTPException(status_code=404, detail="Folder not found")
    # Unfile all assets in this folder
    stmt = select(Asset).where(Asset.folder_id == folder_id)
    result = await db.execute(stmt)
    for asset in result.scalars().all():
        asset.folder_id = None
    await db.delete(folder)
    await db.commit()


@router.put("/move", response_model=list[AssetResponse])
async def move_assets(
    payload: dict,
    db: AsyncSession = Depends(get_db),
) -> list[AssetResponse]:
    """Move one or more assets to a folder (or to root with folder_id=null).

    Enforces the per-channel folder invariant: every asset being moved
    must belong to the SAME channel as the destination folder. The
    UI's MoveToFolderDialog already filters its options to the asset's
    channel, but server-side validation catches any direct API misuse
    or stale frontend state.
    """
    asset_ids = payload.get("asset_ids", [])
    folder_id = payload.get("folder_id")  # None = move to root

    if not asset_ids:
        raise HTTPException(status_code=400, detail="asset_ids required")

    folder: Optional[AssetFolder] = None
    if folder_id is not None:
        folder = await db.get(AssetFolder, int(folder_id))
        if not folder:
            raise HTTPException(status_code=404, detail="Folder not found")

    moved = []
    for aid in asset_ids:
        asset = await db.get(Asset, int(aid))
        if not asset:
            continue
        if folder is not None:
            # Channel-match invariant
            if asset.channel_id != folder.channel_id:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Asset {asset.id} belongs to channel {asset.channel_id} "
                        f"but folder {folder.id} belongs to channel "
                        f"{folder.channel_id}. Cross-channel moves aren't "
                        f"allowed — reassign the asset's channel first, then "
                        f"move it into a folder of that channel."
                    ),
                )
            # Asset-type-match invariant (a music folder can't hold images)
            if asset.asset_type != folder.asset_type:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Asset {asset.id} is type '{asset.asset_type}' but "
                        f"folder {folder.id} is type '{folder.asset_type}'."
                    ),
                )
        asset.folder_id = int(folder_id) if folder_id is not None else None
        moved.append(asset)

    await db.commit()
    # Refresh to get folder relationship
    responses = []
    for asset in moved:
        await db.refresh(asset, ["folder"])
        responses.append(_asset_to_response(asset))
    return responses


@router.put("/reassign-role", response_model=list[AssetResponse])
async def reassign_role_bulk(
    payload: dict,
    db: AsyncSession = Depends(get_db),
) -> list[AssetResponse]:
    """Re-classify one or more image assets to a new role.

    Body: ``{"asset_ids": [int, ...], "role": "background" | "thumbnail"
    | "overlay" | "reference" | null}``. Empty / null clears the role.
    Used by the library's batch-select "set role" action.

    Declared BEFORE the ``/{asset_id}`` route so FastAPI routes the
    literal ``reassign-role`` path here instead of trying to parse it
    as an int.
    """
    asset_ids = payload.get("asset_ids") or []
    new_role_raw = payload.get("role")
    new_role: Optional[str] = (
        new_role_raw.strip() if isinstance(new_role_raw, str) else None
    ) or None
    if not asset_ids:
        raise HTTPException(status_code=400, detail="asset_ids is required")

    rows = await db.execute(
        select(Asset).options(selectinload(Asset.folder)).where(
            Asset.id.in_([int(i) for i in asset_ids])
        )
    )
    updated: list[Asset] = []
    for asset in rows.scalars().all():
        asset.role = new_role
        updated.append(asset)
    await db.commit()
    return [_asset_to_response(a) for a in updated]


@router.put("/reassign-channel", response_model=list[AssetResponse])
async def reassign_assets_channel(
    payload: dict,
    db: AsyncSession = Depends(get_db),
) -> list[AssetResponse]:
    """Reassign one or more assets to a different channel.

    Body::

        {
          "asset_ids": [157, 158, ...],
          "channel_id": 2          // target channel
        }

    Closes the gap that surfaced earlier: the YouTube download flow tags
    every resulting MP3 with the channel selected at download time, and
    if the user picked the wrong channel (or only a folder, which
    defaulted somewhere), the assets ended up on the wrong channel with
    no UI to fix them. ``/move`` only swaps folders.

    Implementation:
    - Move the file on disk from ``{old_channel}/{type}/...`` to
      ``{new_channel}/{type}/...``. New filename gets a fresh prefix to
      avoid clashes if the target dir already has a same-named file.
    - Update ``Asset.channel_id`` + ``Asset.filepath`` to match.
    - Best-effort rollback: if the file move fails for one asset, the
      DB row is NOT updated; the response includes only successfully
      reassigned rows.
    """
    import shutil
    from uuid import uuid4
    from pathlib import Path

    from app.config import settings
    from app.models.channel import Channel as ChannelModel
    from app.utils.file_utils import get_asset_dir

    asset_ids = payload.get("asset_ids", [])
    new_channel_id = payload.get("channel_id")

    if not asset_ids:
        raise HTTPException(status_code=400, detail="asset_ids required")
    if new_channel_id is None:
        raise HTTPException(status_code=400, detail="channel_id required")

    target_channel = await db.get(ChannelModel, int(new_channel_id))
    if not target_channel:
        raise HTTPException(status_code=404, detail="Target channel not found")

    target_id = int(new_channel_id)
    moved: list[Asset] = []
    failed: list[dict] = []

    for aid in asset_ids:
        asset = await db.get(Asset, int(aid))
        if not asset:
            failed.append({"asset_id": int(aid), "error": "asset not found"})
            continue
        if asset.channel_id == target_id:
            # No-op; still include in response so the client can show
            # consistent state.
            moved.append(asset)
            continue

        old_rel = asset.filepath
        old_abs = settings.assets_dir / old_rel
        # Build the new relative path under the target channel's dir.
        new_dir = get_asset_dir(target_id, asset.asset_type)
        # Always prefix the destination filename with a fresh UUID
        # fragment so we never overwrite an existing same-named file
        # in the target channel's library.
        original_name = Path(old_rel).name
        new_name = f"{uuid4().hex[:8]}_{original_name}" if not original_name.startswith(
            ("auto_", "yt_", "suno_")
        ) else original_name
        new_abs = new_dir / new_name
        new_rel = new_abs.relative_to(settings.assets_dir).as_posix()

        try:
            if old_abs.exists():
                shutil.move(str(old_abs), str(new_abs))
            else:
                # File missing on disk — log and proceed with DB update
                # only. The Asset row should still get the right channel
                # so the UI shows it under the right place; the broken
                # filepath gets surfaced by the existing reconcile pass.
                logger.warning(
                    "Reassign asset %d: file missing on disk at %s; "
                    "updating DB row anyway",
                    asset.id, old_abs,
                )
        except Exception as exc:
            logger.exception(
                "Reassign asset %d: file move failed (%s -> %s)",
                asset.id, old_abs, new_abs,
            )
            failed.append({"asset_id": asset.id, "error": str(exc)})
            continue

        asset.channel_id = target_id
        asset.filepath = new_rel
        # Strip the asset's folder_id — the old folder belongs to the
        # old channel and the per-channel folder invariant requires
        # asset.channel_id == folder.channel_id. The user can re-folder
        # the asset under the new channel afterward if they want to.
        if asset.folder_id is not None:
            asset.folder_id = None
        moved.append(asset)

    await db.commit()
    for asset in moved:
        await db.refresh(asset, ["folder"])

    if failed:
        # Surface partial-failure context in the response — the client
        # can decide whether to retry. Successful moves stay applied.
        logger.warning(
            "Reassign assets: %d succeeded, %d failed: %s",
            len(moved), len(failed), failed,
        )

    return [_asset_to_response(a) for a in moved]


# -----------------------------------------------------------------------
# Audio merge  (fixed string path – must come before {asset_id})
# -----------------------------------------------------------------------

@router.post("/merge-audio", response_model=AssetResponse, status_code=201)
async def merge_audio(
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    """Concatenate multiple audio assets into a single MP3 file.

    Expects JSON: {
        "asset_ids": [1, 2, 3],        # ordered list of audio asset IDs
        "channel_id": 1,
        "title": "My Mix",             # optional
        "description": "Combined ...",  # optional
    }
    """
    import subprocess
    import sys
    import tempfile
    from uuid import uuid4

    asset_ids = payload.get("asset_ids", [])
    channel_id = payload.get("channel_id")
    title = payload.get("title")
    description = payload.get("description")

    if not asset_ids or len(asset_ids) < 2:
        raise HTTPException(status_code=400, detail="At least 2 asset IDs required")
    if not channel_id:
        raise HTTPException(status_code=400, detail="channel_id is required")

    # Fetch all assets in order
    assets = []
    total_duration = 0.0
    for aid in asset_ids:
        asset = await db.get(Asset, int(aid))
        if not asset:
            raise HTTPException(status_code=404, detail=f"Asset {aid} not found")
        file_path = settings.assets_dir / asset.filepath
        if not file_path.exists():
            raise HTTPException(
                status_code=404,
                detail=f"File not found on disk for asset {aid}",
            )
        assets.append(asset)
        total_duration += asset.duration_seconds or 0.0

    # Build FFmpeg concat list file
    output_dir = get_asset_dir(int(channel_id), "music")
    merge_id = uuid4().hex[:8]
    merge_name = f"merged_{merge_id}.mp3"
    output_path = output_dir / merge_name

    # Write the concat list to a temp file
    with tempfile.NamedTemporaryFile(
        mode="w", suffix=".txt", delete=False, encoding="utf-8"
    ) as f:
        for asset in assets:
            abs_path = (settings.assets_dir / asset.filepath).resolve()
            # FFmpeg concat demuxer needs single-quoted paths with escaping
            escaped = str(abs_path).replace("'", "'\\''")
            f.write(f"file '{escaped}'\n")
        concat_file = f.name

    try:
        startupinfo = None
        if sys.platform == "win32":
            startupinfo = subprocess.STARTUPINFO()
            startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW

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

        result = subprocess.run(
            cmd,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.PIPE,
            startupinfo=startupinfo,
            timeout=600,
        )
        if result.returncode != 0:
            stderr_text = result.stderr.decode("utf-8", errors="replace")
            raise HTTPException(
                status_code=500,
                detail=f"FFmpeg merge failed: {stderr_text[-300:]}",
            )
    finally:
        Path(concat_file).unlink(missing_ok=True)

    if not output_path.exists():
        raise HTTPException(status_code=500, detail="Merged file was not created")

    file_size = output_path.stat().st_size
    relative_path = output_path.relative_to(settings.assets_dir).as_posix()
    track_names = [a.title or a.filename for a in assets]

    merged_asset = Asset(
        channel_id=int(channel_id),
        asset_type="music",
        source="merged",
        filename=merge_name,
        filepath=relative_path,
        file_size=file_size,
        duration_seconds=total_duration if total_duration > 0 else None,
        mime_type="audio/mpeg",
        title=title or f"Merged ({len(assets)} tracks)",
        description=description or "Merged from: " + ", ".join(track_names),
    )
    db.add(merged_asset)
    await db.commit()
    await db.refresh(merged_asset)
    return _asset_to_response(merged_asset)


# -----------------------------------------------------------------------
# YouTube download helpers  (fixed string paths – must come before {asset_id})
# -----------------------------------------------------------------------

@router.get("/youtube-cookies-status")
async def youtube_cookies_status():
    """Check whether a cookies.txt file is configured for YouTube downloads."""
    from app.services.ytdlp_service import COOKIES_PATH

    if COOKIES_PATH.exists() and COOKIES_PATH.stat().st_size > 0:
        size = COOKIES_PATH.stat().st_size
        return {"configured": True, "file_size": size}
    return {"configured": False, "file_size": 0}


@router.post("/youtube-cookies-upload")
async def youtube_cookies_upload(
    file: UploadFile = File(...),
):
    """Upload a Netscape-format cookies.txt file for YouTube downloads."""
    from app.services.ytdlp_service import COOKIES_PATH

    content = await file.read()
    text = content.decode("utf-8", errors="replace")

    # Basic validation: should contain YouTube cookies
    if "youtube.com" not in text.lower() and "# Netscape" not in text:
        raise HTTPException(
            status_code=400,
            detail="This doesn't look like a valid cookies.txt file. "
            "It should be in Netscape format and contain YouTube cookies.",
        )

    COOKIES_PATH.parent.mkdir(parents=True, exist_ok=True)
    COOKIES_PATH.write_bytes(content)

    return {
        "success": True,
        "message": f"Cookies file saved ({len(content)} bytes)",
        "file_size": len(content),
    }


@router.delete("/youtube-cookies")
async def youtube_cookies_delete():
    """Remove the stored cookies.txt file."""
    from app.services.ytdlp_service import COOKIES_PATH

    if COOKIES_PATH.exists():
        COOKIES_PATH.unlink()
    return {"success": True}


@router.post("/youtube-info")
async def youtube_info(
    payload: dict,
):
    """Fetch metadata for a YouTube video without downloading."""
    from app.services.ytdlp_service import ytdlp_service, YtDlpError

    url = payload.get("url", "").strip()
    if not url:
        raise HTTPException(status_code=400, detail="url is required")

    try:
        info = await ytdlp_service.fetch_info(url)
    except YtDlpError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    return info


@router.post("/youtube-download", response_model=dict)
async def youtube_download(
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    """Create a background task to download audio from a YouTube video.

    Either ``channel_id`` or ``folder_id`` is required. When only
    ``folder_id`` is given, the asset is filed under that AssetFolder and
    we pick a fallback channel automatically (any existing channel — the
    schema requires channel_id on Asset rows). The user can re-assign the
    asset to a different channel later from the library.
    """
    from app.models.task import BackgroundTask
    from app.workers.task_runner import task_runner
    from app.models.channel import Channel
    from sqlalchemy import select as sa_select

    url = payload.get("url", "").strip()
    channel_id = payload.get("channel_id")
    folder_id = payload.get("folder_id")
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    if not channel_id and not folder_id:
        raise HTTPException(
            status_code=400,
            detail="Either channel_id or folder_id is required",
        )

    # If no channel was picked, fall back to the first available channel —
    # folders are channel-agnostic so this just satisfies the NOT NULL
    # constraint on Asset.channel_id; the file is grouped by folder, not
    # channel, in the library tree.
    if not channel_id:
        result = await db.execute(sa_select(Channel).order_by(Channel.id).limit(1))
        first_channel = result.scalar_one_or_none()
        if not first_channel:
            raise HTTPException(
                status_code=400,
                detail="No channels exist yet — create a channel first",
            )
        channel_id = first_channel.id

    task = BackgroundTask(
        task_type="youtube_audio_download",
        status="pending",
        channel_id=int(channel_id),
        result={
            "url": url,
            "title": payload.get("title"),
            "description": payload.get("description"),
            "folder_id": int(folder_id) if folder_id else None,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await task_runner.enqueue(task.id)

    return {
        "task_id": task.id,
        "status": task.status,
    }


@router.post("/youtube-download-chapters", response_model=dict)
async def youtube_download_chapters(
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    """Download a YouTube video's audio and slice into chapter MP3s.

    Each selected chapter becomes its own Asset row, named after the
    chapter title. Either ``channel_id`` or ``folder_id`` is required —
    same fallback rules as ``/youtube-download``.
    """
    from app.models.task import BackgroundTask
    from app.workers.task_runner import task_runner
    from app.models.channel import Channel
    from sqlalchemy import select as sa_select

    url = payload.get("url", "").strip()
    channel_id = payload.get("channel_id")
    folder_id = payload.get("folder_id")
    chapters = payload.get("chapters") or []
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    if not chapters:
        raise HTTPException(status_code=400, detail="At least one chapter is required")
    if not channel_id and not folder_id:
        raise HTTPException(
            status_code=400,
            detail="Either channel_id or folder_id is required",
        )

    if not channel_id:
        result = await db.execute(sa_select(Channel).order_by(Channel.id).limit(1))
        first_channel = result.scalar_one_or_none()
        if not first_channel:
            raise HTTPException(
                status_code=400,
                detail="No channels exist yet — create a channel first",
            )
        channel_id = first_channel.id

    task = BackgroundTask(
        task_type="youtube_chapters_download",
        status="pending",
        channel_id=int(channel_id),
        result={
            "url": url,
            "chapters": chapters,
            "folder_id": int(folder_id) if folder_id else None,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await task_runner.enqueue(task.id)

    return {
        "task_id": task.id,
        "status": task.status,
    }


# ── Video downloads (mirror of the audio routes above) ────────────────


@router.post("/youtube-video-download", response_model=dict)
async def youtube_video_download(
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    """Create a background task to download a full YouTube video as MP4.

    Stored under ``data/assets/{channel_id}/video/`` and created as an
    ``asset_type='video'`` row so it shows up in the Library's video
    tab and in the visualizer's background-video picker. Either
    ``channel_id`` or ``folder_id`` is required (same fallback rules as
    /youtube-download).
    """
    from app.models.task import BackgroundTask
    from app.workers.task_runner import task_runner
    from app.models.channel import Channel
    from sqlalchemy import select as sa_select

    url = payload.get("url", "").strip()
    channel_id = payload.get("channel_id")
    folder_id = payload.get("folder_id")
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    if not channel_id and not folder_id:
        raise HTTPException(
            status_code=400,
            detail="Either channel_id or folder_id is required",
        )

    if not channel_id:
        result = await db.execute(sa_select(Channel).order_by(Channel.id).limit(1))
        first_channel = result.scalar_one_or_none()
        if not first_channel:
            raise HTTPException(
                status_code=400,
                detail="No channels exist yet — create a channel first",
            )
        channel_id = first_channel.id

    task = BackgroundTask(
        task_type="youtube_video_download",
        status="pending",
        channel_id=int(channel_id),
        result={
            "url": url,
            "title": payload.get("title"),
            "description": payload.get("description"),
            "folder_id": int(folder_id) if folder_id else None,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await task_runner.enqueue(task.id)

    return {"task_id": task.id, "status": task.status}


@router.post("/youtube-video-download-sections", response_model=dict)
async def youtube_video_download_sections(
    payload: dict,
    db: AsyncSession = Depends(get_db),
):
    """Download a YouTube video and slice it into MP4 sections.

    ``sections`` shape matches the audio chapters endpoint:
    ``[{"title": str, "start": float, "end": float}, ...]``. Cuts are
    sample-accurate (re-encoded via libx264 + aac) — slow but exact.
    Each section becomes its own ``asset_type='video'`` row.
    """
    from app.models.task import BackgroundTask
    from app.workers.task_runner import task_runner
    from app.models.channel import Channel
    from sqlalchemy import select as sa_select

    url = payload.get("url", "").strip()
    channel_id = payload.get("channel_id")
    folder_id = payload.get("folder_id")
    sections = payload.get("sections") or []
    if not url:
        raise HTTPException(status_code=400, detail="url is required")
    if not sections:
        raise HTTPException(status_code=400, detail="At least one section is required")
    if not channel_id and not folder_id:
        raise HTTPException(
            status_code=400,
            detail="Either channel_id or folder_id is required",
        )

    if not channel_id:
        result = await db.execute(sa_select(Channel).order_by(Channel.id).limit(1))
        first_channel = result.scalar_one_or_none()
        if not first_channel:
            raise HTTPException(
                status_code=400,
                detail="No channels exist yet — create a channel first",
            )
        channel_id = first_channel.id

    task = BackgroundTask(
        task_type="youtube_video_sections_download",
        status="pending",
        channel_id=int(channel_id),
        result={
            "url": url,
            "sections": sections,
            "folder_id": int(folder_id) if folder_id else None,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)
    await task_runner.enqueue(task.id)

    return {"task_id": task.id, "status": task.status}


# -----------------------------------------------------------------------
# Single-asset routes  ({asset_id} path param – must come last)
# -----------------------------------------------------------------------

@router.get("/{asset_id}", response_model=AssetResponse)
async def get_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    stmt = select(Asset).options(selectinload(Asset.folder)).where(Asset.id == asset_id)
    result = await db.execute(stmt)
    asset = result.scalar_one_or_none()
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    return _asset_to_response(asset)


@router.put("/{asset_id}", response_model=AssetResponse)
async def update_asset(
    asset_id: int,
    title: Optional[str] = Form(None),
    description: Optional[str] = Form(None),
    role: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    asset = await db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    if title is not None:
        asset.title = title
    if description is not None:
        asset.description = description
    if role is not None:
        # Allow re-classifying images between background / thumbnail /
        # overlay / reference from the library UI. Empty string clears
        # back to NULL ("unclassified"); any other value is stored
        # verbatim — validate at the UI layer.
        asset.role = role.strip() or None
    await db.commit()
    await db.refresh(asset, ["folder"])
    return _asset_to_response(asset)


@router.get("/{asset_id}/stream")
async def stream_asset(
    asset_id: int,
    request: Request,
    db: AsyncSession = Depends(get_db),
):
    """Stream an asset file with HTTP Range support for video seeking."""
    asset = await db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")

    file_path = settings.assets_dir / asset.filepath
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Asset file not found on disk")

    file_size = file_path.stat().st_size
    mime_type = asset.mime_type or "application/octet-stream"

    # Handle Range header for video seeking
    range_header = request.headers.get("range")
    if range_header:
        # Parse "bytes=START-END"
        range_str = range_header.replace("bytes=", "")
        parts = range_str.split("-")
        start = int(parts[0]) if parts[0] else 0
        end = int(parts[1]) if parts[1] else file_size - 1
        end = min(end, file_size - 1)
        chunk_size = end - start + 1

        def iter_range():
            with open(file_path, "rb") as f:
                f.seek(start)
                remaining = chunk_size
                while remaining > 0:
                    read_size = min(remaining, 64 * 1024)
                    data = f.read(read_size)
                    if not data:
                        break
                    remaining -= len(data)
                    yield data

        return StreamingResponse(
            iter_range(),
            status_code=206,
            media_type=mime_type,
            headers={
                "Content-Range": f"bytes {start}-{end}/{file_size}",
                "Accept-Ranges": "bytes",
                "Content-Length": str(chunk_size),
            },
        )

    # No range – return the full file
    return FileResponse(
        path=str(file_path),
        media_type=mime_type,
        filename=asset.filename,
        headers={"Accept-Ranges": "bytes"},
    )


@router.delete("/{asset_id}", status_code=204, response_class=Response)
async def delete_asset(
    asset_id: int,
    db: AsyncSession = Depends(get_db),
):
    asset = await db.get(Asset, asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="Asset not found")
    try:
        delete_asset_file(asset.filepath)
    except Exception:
        pass  # File may already be gone
    await db.delete(asset)
    await db.commit()
