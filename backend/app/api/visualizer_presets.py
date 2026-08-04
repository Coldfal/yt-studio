"""CRUD endpoints for saved visualizer presets.

Presets are scoped per channel. The "default" preset for a channel is auto-
applied to the composition_config of new projects on that channel.
"""

from __future__ import annotations

import base64
import re
from datetime import datetime
from pathlib import Path
from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.models import VisualizerPreset

router = APIRouter(prefix="/api/visualizer-presets", tags=["visualizer-presets"])


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class VisualizerPresetCreate(BaseModel):
    channel_id: int
    name: str
    preset_id: str
    config: dict[str, Any]
    is_default: bool = False


class VisualizerPresetUpdate(BaseModel):
    name: Optional[str] = None
    preset_id: Optional[str] = None
    config: Optional[dict[str, Any]] = None
    is_default: Optional[bool] = None


class VisualizerPresetResponse(BaseModel):
    id: int
    channel_id: int
    name: str
    preset_id: str
    config: dict[str, Any]
    is_default: bool
    thumbnail_url: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    model_config = {"from_attributes": True}


class ThumbnailUpload(BaseModel):
    # base64-encoded JPEG/PNG data URI, e.g. "data:image/jpeg;base64,..."
    data_url: str


async def _clear_defaults(db: AsyncSession, channel_id: int, except_id: Optional[int]) -> None:
    """Ensure at most one preset per channel has is_default=True."""
    stmt = update(VisualizerPreset).where(
        VisualizerPreset.channel_id == channel_id,
        VisualizerPreset.is_default == True,  # noqa: E712
    )
    if except_id is not None:
        stmt = stmt.where(VisualizerPreset.id != except_id)
    stmt = stmt.values(is_default=False)
    await db.execute(stmt)


@router.get("", response_model=list[VisualizerPresetResponse])
async def list_presets(
    channel_id: Optional[int] = None,
    db: AsyncSession = Depends(get_db),
) -> list[VisualizerPreset]:
    stmt = select(VisualizerPreset).order_by(
        VisualizerPreset.is_default.desc(),
        VisualizerPreset.updated_at.desc(),
    )
    if channel_id is not None:
        stmt = stmt.where(VisualizerPreset.channel_id == channel_id)
    result = await db.execute(stmt)
    return list(result.scalars().all())


@router.post("", response_model=VisualizerPresetResponse, status_code=201)
async def create_preset(
    body: VisualizerPresetCreate,
    db: AsyncSession = Depends(get_db),
) -> VisualizerPreset:
    preset = VisualizerPreset(
        channel_id=body.channel_id,
        name=body.name,
        preset_id=body.preset_id,
        config=body.config,
        is_default=body.is_default,
    )
    db.add(preset)
    await db.flush()
    if body.is_default:
        await _clear_defaults(db, body.channel_id, preset.id)
    await db.commit()
    await db.refresh(preset)
    return preset


@router.get("/{preset_id}", response_model=VisualizerPresetResponse)
async def get_preset(
    preset_id: int,
    db: AsyncSession = Depends(get_db),
) -> VisualizerPreset:
    preset = await db.get(VisualizerPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    return preset


@router.put("/{preset_id}", response_model=VisualizerPresetResponse)
async def update_preset(
    preset_id: int,
    body: VisualizerPresetUpdate,
    db: AsyncSession = Depends(get_db),
) -> VisualizerPreset:
    preset = await db.get(VisualizerPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    if body.name is not None:
        preset.name = body.name
    if body.preset_id is not None:
        preset.preset_id = body.preset_id
    if body.config is not None:
        preset.config = body.config
    if body.is_default is not None:
        preset.is_default = body.is_default
        if body.is_default:
            await _clear_defaults(db, preset.channel_id, preset.id)

    await db.commit()
    await db.refresh(preset)
    return preset


@router.delete("/{preset_id}")
async def delete_preset(
    preset_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    preset = await db.get(VisualizerPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")
    await db.delete(preset)
    await db.commit()
    return {"deleted": preset_id}


@router.post("/{preset_id}/thumbnail", response_model=VisualizerPresetResponse)
async def upload_thumbnail(
    preset_id: int,
    body: ThumbnailUpload,
    db: AsyncSession = Depends(get_db),
) -> VisualizerPreset:
    """Store a canvas snapshot as the preset's thumbnail.

    Accepts a base64 data URI (``data:image/jpeg;base64,...``), saves it as
    a JPEG under ``data/assets/preset-thumbs/``, and updates the preset's
    ``thumbnail_url`` field.
    """
    preset = await db.get(VisualizerPreset, preset_id)
    if not preset:
        raise HTTPException(status_code=404, detail="Preset not found")

    # Decode the data URI
    match = re.match(r"data:image/(?:jpeg|png|webp);base64,(.+)", body.data_url, re.DOTALL)
    if not match:
        raise HTTPException(status_code=400, detail="Invalid data URI — must be image/jpeg, png, or webp base64")
    raw = base64.b64decode(match.group(1))

    # Reject obviously-empty captures (a real 1080p JPEG is hundreds of KB;
    # anything below ~2 KB is almost certainly a blank/black canvas dump).
    if len(raw) < 2048:
        raise HTTPException(
            status_code=400,
            detail=f"Thumbnail looks empty ({len(raw)} bytes) — canvas may not have rendered yet",
        )

    # Save to disk
    thumb_dir = Path(settings.assets_dir) / "preset-thumbs"
    thumb_dir.mkdir(parents=True, exist_ok=True)
    thumb_path = thumb_dir / f"{preset_id}.jpg"
    thumb_path.write_bytes(raw)

    preset.thumbnail_url = f"/files/preset-thumbs/{preset_id}.jpg"
    await db.commit()
    await db.refresh(preset)
    return preset
