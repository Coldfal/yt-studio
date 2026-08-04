"""Asset Sets API — Phase 5 of farm redesign.

CRUD on the per-channel AssetSet table plus a single 'pick' helper the
Quick Generate flow uses when ``use_asset_sets=True``.
"""
from __future__ import annotations

import random
from typing import List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Asset, AssetSet, Channel


router = APIRouter(prefix="/api/asset-sets", tags=["asset-sets"])


# ── Schemas ──────────────────────────────────────────────────────────


class AssetSetResponse(BaseModel):
    id: int
    channel_id: int
    name: str
    background_asset_id: int
    thumbnail_asset_id: int
    overlay_asset_id: Optional[int]
    is_active: bool
    # Convenience: include the asset filepaths so the UI can render
    # thumbnails without a second roundtrip per row.
    background_file_url: Optional[str] = None
    thumbnail_file_url: Optional[str] = None
    overlay_file_url: Optional[str] = None
    background_filename: Optional[str] = None
    thumbnail_filename: Optional[str] = None

    class Config:
        from_attributes = True


class AssetSetCreate(BaseModel):
    channel_id: int
    name: str
    background_asset_id: int
    thumbnail_asset_id: int
    overlay_asset_id: Optional[int] = None
    is_active: bool = True


class AssetSetUpdate(BaseModel):
    name: Optional[str] = None
    background_asset_id: Optional[int] = None
    thumbnail_asset_id: Optional[int] = None
    overlay_asset_id: Optional[int] = None
    is_active: Optional[bool] = None


# ── Helpers ──────────────────────────────────────────────────────────


def _to_response(s: AssetSet, asset_index: dict[int, Asset]) -> AssetSetResponse:
    """Hydrate the response with asset file_urls from a pre-loaded
    index. Avoids N+1 queries when listing many sets.
    """
    bg = asset_index.get(s.background_asset_id)
    th = asset_index.get(s.thumbnail_asset_id)
    ov = asset_index.get(s.overlay_asset_id) if s.overlay_asset_id else None
    return AssetSetResponse(
        id=s.id,
        channel_id=s.channel_id,
        name=s.name,
        background_asset_id=s.background_asset_id,
        thumbnail_asset_id=s.thumbnail_asset_id,
        overlay_asset_id=s.overlay_asset_id,
        is_active=s.is_active,
        background_file_url=f"/files/{bg.filepath}" if bg else None,
        thumbnail_file_url=f"/files/{th.filepath}" if th else None,
        overlay_file_url=f"/files/{ov.filepath}" if ov else None,
        background_filename=bg.filename if bg else None,
        thumbnail_filename=th.filename if th else None,
    )


async def _validate_assets(
    db: AsyncSession,
    channel_id: int,
    background_id: int,
    thumbnail_id: int,
    overlay_id: Optional[int],
) -> dict[int, Asset]:
    """Confirm every referenced asset exists AND belongs to the channel.

    Returns a {id: Asset} index for the hydration step.
    """
    ids = [background_id, thumbnail_id]
    if overlay_id is not None:
        ids.append(overlay_id)
    rows = (await db.execute(
        select(Asset).where(Asset.id.in_(ids))
    )).scalars().all()
    by_id = {a.id: a for a in rows}
    for aid in (background_id, thumbnail_id):
        if aid not in by_id:
            raise HTTPException(status_code=404, detail=f"Asset {aid} not found")
        if by_id[aid].channel_id != channel_id:
            raise HTTPException(
                status_code=400,
                detail=f"Asset {aid} belongs to a different channel",
            )
    if overlay_id is not None and overlay_id not in by_id:
        raise HTTPException(status_code=404, detail=f"Overlay asset {overlay_id} not found")
    return by_id


# ── CRUD ─────────────────────────────────────────────────────────────


@router.get("", response_model=List[AssetSetResponse])
async def list_sets(
    channel_id: Optional[int] = None,
    is_active: Optional[bool] = None,
    db: AsyncSession = Depends(get_db),
):
    stmt = select(AssetSet).order_by(AssetSet.updated_at.desc())
    if channel_id is not None:
        stmt = stmt.where(AssetSet.channel_id == channel_id)
    if is_active is not None:
        stmt = stmt.where(AssetSet.is_active == is_active)
    rows = (await db.execute(stmt)).scalars().all()
    if not rows:
        return []
    # Hydrate file URLs in one batch query.
    asset_ids = {s.background_asset_id for s in rows}
    asset_ids.update(s.thumbnail_asset_id for s in rows)
    asset_ids.update(s.overlay_asset_id for s in rows if s.overlay_asset_id)
    assets = (await db.execute(
        select(Asset).where(Asset.id.in_(asset_ids))
    )).scalars().all()
    by_id = {a.id: a for a in assets}
    return [_to_response(s, by_id) for s in rows]


@router.post("", response_model=AssetSetResponse, status_code=201)
async def create_set(
    body: AssetSetCreate,
    db: AsyncSession = Depends(get_db),
):
    channel = await db.get(Channel, body.channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    by_id = await _validate_assets(
        db, body.channel_id,
        body.background_asset_id,
        body.thumbnail_asset_id,
        body.overlay_asset_id,
    )
    s = AssetSet(
        channel_id=body.channel_id,
        name=body.name.strip(),
        background_asset_id=body.background_asset_id,
        thumbnail_asset_id=body.thumbnail_asset_id,
        overlay_asset_id=body.overlay_asset_id,
        is_active=body.is_active,
    )
    db.add(s)
    await db.commit()
    await db.refresh(s)
    return _to_response(s, by_id)


@router.put("/{set_id}", response_model=AssetSetResponse)
async def update_set(
    set_id: int,
    body: AssetSetUpdate,
    db: AsyncSession = Depends(get_db),
):
    s = await db.get(AssetSet, set_id)
    if not s:
        raise HTTPException(status_code=404, detail="Set not found")
    update = body.model_dump(exclude_unset=True)
    # Re-validate when any asset id changes.
    needs_check = any(
        k in update for k in (
            "background_asset_id", "thumbnail_asset_id", "overlay_asset_id",
        )
    )
    for k, v in update.items():
        setattr(s, k, v)
    if needs_check:
        await _validate_assets(
            db, s.channel_id,
            s.background_asset_id,
            s.thumbnail_asset_id,
            s.overlay_asset_id,
        )
    await db.commit()
    await db.refresh(s)
    by_id = {}
    for aid in (s.background_asset_id, s.thumbnail_asset_id, s.overlay_asset_id):
        if aid is None:
            continue
        a = await db.get(Asset, aid)
        if a:
            by_id[aid] = a
    return _to_response(s, by_id)


@router.delete("/{set_id}", status_code=204)
async def delete_set(
    set_id: int,
    db: AsyncSession = Depends(get_db),
):
    s = await db.get(AssetSet, set_id)
    if not s:
        raise HTTPException(status_code=404, detail="Set not found")
    await db.delete(s)
    await db.commit()


@router.post("/{set_id}/toggle-active", response_model=AssetSetResponse)
async def toggle_active(
    set_id: int,
    db: AsyncSession = Depends(get_db),
):
    s = await db.get(AssetSet, set_id)
    if not s:
        raise HTTPException(status_code=404, detail="Set not found")
    s.is_active = not s.is_active
    await db.commit()
    await db.refresh(s)
    by_id = {}
    for aid in (s.background_asset_id, s.thumbnail_asset_id):
        a = await db.get(Asset, aid)
        if a:
            by_id[aid] = a
    if s.overlay_asset_id:
        a = await db.get(Asset, s.overlay_asset_id)
        if a:
            by_id[s.overlay_asset_id] = a
    return _to_response(s, by_id)


# ── Quick Generate pick helper ───────────────────────────────────────


async def pick_random_active_set(
    db: AsyncSession, channel_id: int,
) -> Optional[AssetSet]:
    """Pick a random ACTIVE set for the channel. Returns None when
    the channel has no active sets — caller falls back to the
    legacy independent-pick path.
    """
    rows = (await db.execute(
        select(AssetSet).where(
            AssetSet.channel_id == channel_id,
            AssetSet.is_active == True,  # noqa: E712
        )
    )).scalars().all()
    if not rows:
        return None
    return random.choice(rows)
