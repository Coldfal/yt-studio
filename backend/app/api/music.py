from __future__ import annotations

import re
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File, Form
from fastapi.responses import FileResponse
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import BackgroundTask, Asset, VideoProject
from app.schemas.task import TaskResponse
from app.schemas.asset import AssetResponse
from app.utils.file_utils import save_upload_file, get_mime_type
from app.workers.task_runner import task_runner

router = APIRouter(prefix="/api/music", tags=["music"])


class MusicGenerateRequest(BaseModel):
    channel_id: int
    project_id: Optional[int] = None
    prompt: str
    style: Optional[str] = None
    duration_seconds: Optional[float] = None
    instrumental: bool = True


def _asset_to_response(asset: Asset) -> AssetResponse:
    return AssetResponse(
        id=asset.id,
        channel_id=asset.channel_id,
        asset_type=asset.asset_type,
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
        created_at=asset.created_at,
    )


@router.post("/generate", response_model=TaskResponse, status_code=201)
async def generate_music(
    body: MusicGenerateRequest,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    task = BackgroundTask(
        task_type="music_generation",
        status="pending",
        channel_id=body.channel_id,
        project_id=body.project_id,
        result={
            "prompt": body.prompt,
            "style": body.style,
            "duration_seconds": body.duration_seconds,
            "instrumental": body.instrumental,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    await task_runner.enqueue(task.id)

    return TaskResponse.model_validate(task)


@router.post("/import", response_model=AssetResponse, status_code=201)
async def import_music(
    file: UploadFile = File(...),
    channel_id: int = Form(...),
    project_id: Optional[int] = Form(None),
    db: AsyncSession = Depends(get_db),
) -> AssetResponse:
    content = await file.read()
    filepath, file_size = save_upload_file(
        channel_id, "music", file.filename, content
    )
    mime_type = get_mime_type(file.filename)

    asset = Asset(
        channel_id=channel_id,
        asset_type="music",
        source="imported",
        filename=file.filename,
        filepath=filepath,
        file_size=file_size,
        mime_type=mime_type,
    )
    db.add(asset)
    await db.flush()

    if project_id is not None:
        project = await db.get(VideoProject, project_id)
        if not project:
            raise HTTPException(status_code=404, detail="Project not found")
        project.music_asset_id = asset.id

    await db.commit()
    await db.refresh(asset)
    return _asset_to_response(asset)


# ---------------------------------------------------------------------------
# Folder scan — returns a list of audio files without importing them
# ---------------------------------------------------------------------------

AUDIO_EXTENSIONS = {".mp3", ".wav", ".flac", ".ogg", ".m4a", ".aac", ".opus"}


class FolderTrack(BaseModel):
    path: str         # absolute path on server
    filename: str
    duration: float   # seconds (0.0 if unknown)
    size: int         # bytes


class FolderScanResponse(BaseModel):
    folder: str
    tracks: List[FolderTrack]
    total_duration: float


def _probe_duration(path: Path) -> float:
    """Use ffprobe to get duration in seconds. Returns 0.0 on failure."""
    import subprocess, json as _json
    try:
        r = subprocess.run(
            [
                "ffprobe", "-v", "quiet", "-print_format", "json",
                "-show_entries", "format=duration", str(path),
            ],
            capture_output=True, text=True, timeout=5,
        )
        data = _json.loads(r.stdout)
        return float(data["format"]["duration"])
    except Exception:
        return 0.0


@router.get("/scan-folder", response_model=FolderScanResponse)
async def scan_folder(folder_path: str) -> FolderScanResponse:
    """Scan a local folder for audio files and return their metadata.

    Files are NOT imported into the asset library — they are returned as-is
    so the caller can store absolute paths directly on a project.
    """
    root = Path(folder_path)
    if not root.exists():
        raise HTTPException(status_code=400, detail=f"Folder not found: {folder_path}")
    if not root.is_dir():
        raise HTTPException(status_code=400, detail=f"Not a directory: {folder_path}")

    tracks: List[FolderTrack] = []
    for p in sorted(root.iterdir()):
        if p.is_file() and p.suffix.lower() in AUDIO_EXTENSIONS:
            duration = _probe_duration(p)
            tracks.append(FolderTrack(
                path=str(p.resolve()),
                filename=p.name,
                duration=duration,
                size=p.stat().st_size,
            ))

    return FolderScanResponse(
        folder=str(root.resolve()),
        tracks=tracks,
        total_duration=sum(t.duration for t in tracks),
    )


# ---------------------------------------------------------------------------
# Stream a file from an absolute server path (for folder-mode preview)
# ---------------------------------------------------------------------------

@router.get("/stream-file")
async def stream_file(file_path: str) -> FileResponse:
    """Serve an audio file by its absolute server path.

    Only audio extensions are allowed to prevent arbitrary file exposure.
    """
    p = Path(file_path)
    if p.suffix.lower() not in AUDIO_EXTENSIONS:
        raise HTTPException(status_code=400, detail="Not an audio file")
    if not p.exists() or not p.is_file():
        raise HTTPException(status_code=404, detail=f"File not found: {file_path}")
    mime = get_mime_type(p.name) or "audio/mpeg"
    return FileResponse(str(p), media_type=mime, filename=p.name)
