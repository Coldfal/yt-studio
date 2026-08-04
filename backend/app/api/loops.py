"""HTTP endpoints around PyMusicLooper.

Two operations on an audio Asset:

- ``POST /api/loops/{asset_id}/analyze`` — find the top loop candidates.
  Returns a list of ``{loop_start_seconds, loop_end_seconds, score}``
  sorted best-first. Synchronous (the analysis is 5–20s for typical
  3-minute tracks); the call runs inside a thread executor so the event
  loop isn't blocked.
- ``POST /api/loops/{asset_id}/export`` — render a new audio asset that
  loops the chosen segment to a target duration with a tiny crossfade.
  The resulting file is registered as a fresh ``music`` Asset on the
  same channel and folder, with ``source="loop_export"`` so it's easy
  to find later.
"""
from __future__ import annotations

import asyncio
import logging
from pathlib import Path
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import Asset
from app.utils.file_utils import get_asset_dir, get_mime_type

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/loops", tags=["loops"])


class LoopCandidateResponse(BaseModel):
    loop_start_seconds: float
    loop_end_seconds: float
    loop_start_samples: int
    loop_end_samples: int
    score: float
    duration_seconds: float


class AnalyzeRequest(BaseModel):
    """Optional duration filters to speed up analysis on long tracks."""

    min_loop_duration_seconds: Optional[float] = None
    max_loop_duration_seconds: Optional[float] = None
    brute_force: bool = False
    max_candidates: int = 5


class ExportRequest(BaseModel):
    loop_start_samples: int
    loop_end_samples: int
    target_duration_seconds: float
    fade_seconds: float = 0.05
    # New asset's title — defaults to ``"<orig> (looped 1h)"`` if omitted.
    title: Optional[str] = None


@router.post("/{asset_id}/analyze", response_model=List[LoopCandidateResponse])
async def analyze_asset_loops(
    asset_id: int,
    body: AnalyzeRequest = AnalyzeRequest(),
    db: AsyncSession = Depends(get_db),
) -> List[LoopCandidateResponse]:
    """Find seamless loop candidates inside an audio asset."""
    asset = await db.get(Asset, asset_id)
    if asset is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if asset.asset_type != "music":
        raise HTTPException(
            status_code=400,
            detail=f"Asset {asset_id} is type '{asset.asset_type}', not 'music'",
        )

    abs_path = (settings.assets_dir / asset.filepath).resolve()
    if not abs_path.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Audio file missing on disk: {asset.filepath}",
        )

    from app.services.loop_finder_service import find_loop_candidates

    loop = asyncio.get_running_loop()
    try:
        candidates = await loop.run_in_executor(
            None,
            lambda: find_loop_candidates(
                str(abs_path),
                max_candidates=body.max_candidates,
                min_loop_duration=body.min_loop_duration_seconds,
                max_loop_duration=body.max_loop_duration_seconds,
                brute_force=body.brute_force,
            ),
        )
    except Exception as exc:  # pragma: no cover — surface decode errors etc.
        logger.exception("Loop analysis failed for asset %d", asset_id)
        raise HTTPException(
            status_code=500,
            detail=f"Loop analysis failed: {exc}",
        ) from exc

    return [
        LoopCandidateResponse(
            loop_start_seconds=c.loop_start_seconds,
            loop_end_seconds=c.loop_end_seconds,
            loop_start_samples=c.loop_start_samples,
            loop_end_samples=c.loop_end_samples,
            score=c.score,
            duration_seconds=c.duration_seconds,
        )
        for c in candidates
    ]


@router.post("/{asset_id}/export", status_code=201)
async def export_seamless_loop(
    asset_id: int,
    body: ExportRequest,
    db: AsyncSession = Depends(get_db),
):
    """Render a looped copy of the asset to a target duration and
    register it as a fresh ``music`` Asset for the same channel.

    Returns the new asset's id + filepath so the caller can update a
    project to point at it.
    """
    src = await db.get(Asset, asset_id)
    if src is None:
        raise HTTPException(status_code=404, detail="Asset not found")
    if src.asset_type != "music":
        raise HTTPException(
            status_code=400,
            detail=f"Asset {asset_id} is type '{src.asset_type}', not 'music'",
        )
    abs_in = (settings.assets_dir / src.filepath).resolve()
    if not abs_in.exists():
        raise HTTPException(
            status_code=404,
            detail=f"Audio file missing on disk: {src.filepath}",
        )

    out_dir = get_asset_dir(src.channel_id, "music")
    out_dir.mkdir(parents=True, exist_ok=True)

    from app.services.loop_finder_service import export_seamless_loop as _export

    loop = asyncio.get_running_loop()
    try:
        out_abs = await loop.run_in_executor(
            None,
            lambda: _export(
                str(abs_in),
                loop_start_samples=body.loop_start_samples,
                loop_end_samples=body.loop_end_samples,
                extended_length_seconds=body.target_duration_seconds,
                fade_length_seconds=body.fade_seconds,
                output_dir=str(out_dir),
                output_format="WAV",
            ),
        )
    except Exception as exc:  # pragma: no cover
        logger.exception("Loop export failed for asset %d", asset_id)
        raise HTTPException(
            status_code=500,
            detail=f"Loop export failed: {exc}",
        ) from exc

    out_path = Path(out_abs)
    rel_path = out_path.relative_to(settings.assets_dir).as_posix()

    # Probe duration via ffprobe so the new asset has accurate metadata.
    from app.utils.ffmpeg import get_audio_duration

    try:
        duration = float(
            await loop.run_in_executor(
                None,
                get_audio_duration,
                str(out_path),
                settings.ffprobe_path,
            )
            or 0.0
        )
    except Exception:
        duration = float(body.target_duration_seconds)

    title = body.title or f"{(src.title or src.filename or 'Track')} (seamless loop)"
    new_asset = Asset(
        channel_id=src.channel_id,
        asset_type="music",
        source="loop_export",
        filename=out_path.name,
        filepath=rel_path,
        file_size=out_path.stat().st_size,
        duration_seconds=duration,
        mime_type=get_mime_type(out_path.name) or "audio/wav",
        title=title,
        folder_id=src.folder_id,
    )
    db.add(new_asset)
    await db.commit()
    await db.refresh(new_asset)

    return {
        "id": new_asset.id,
        "filepath": rel_path,
        "filename": out_path.name,
        "duration_seconds": duration,
        "file_size": new_asset.file_size,
        "title": title,
    }
