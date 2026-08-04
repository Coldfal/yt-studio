from __future__ import annotations

from typing import List

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import LiveStream
from app.schemas.live_stream import (
    LiveStreamResponse,
    StartStreamRequest,
)
from app.services.streaming_service import stream_manager

router = APIRouter(prefix="/api/streaming", tags=["streaming"])


@router.post("/start", response_model=LiveStreamResponse, status_code=201)
async def start_stream(
    body: StartStreamRequest,
    db: AsyncSession = Depends(get_db),
):
    """Start a live stream on a YouTube channel."""
    try:
        stream_id = await stream_manager.start_stream(
            channel_id=body.channel_id,
            title=body.title,
            description=body.description,
            target_duration_hours=body.target_duration_hours,
            music_folder_path=body.music_folder_path,
            use_channel_music_assets=body.use_channel_music_assets,
            image_path=body.image_path,
            image_asset_id=body.image_asset_id,
            use_visualizer=body.use_visualizer,
            visualizer_config=body.visualizer_config,
            visualizer_preset_id=body.visualizer_preset_id,
            composed_asset_id=body.composed_asset_id,
        )
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))

    stream = await db.get(LiveStream, stream_id)
    if not stream:
        raise HTTPException(status_code=500, detail="Stream record not found")
    return LiveStreamResponse.model_validate(stream)


@router.post("/{stream_id}/stop")
async def stop_stream(
    stream_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Stop a running live stream."""
    stream = await db.get(LiveStream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Stream not found")
    try:
        await stream_manager.stop_stream(stream_id)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return {"message": "Stream stopped", "stream_id": stream_id}


@router.get("/active", response_model=List[LiveStreamResponse])
async def list_active_streams(
    db: AsyncSession = Depends(get_db),
):
    """List all active or recent streams."""
    result = await db.execute(
        select(LiveStream)
        .where(LiveStream.status.in_(["preparing", "starting", "live"]))
        .order_by(LiveStream.created_at.desc())
    )
    return [LiveStreamResponse.model_validate(s) for s in result.scalars()]


@router.get("/history", response_model=List[LiveStreamResponse])
async def list_stream_history(
    channel_id: int = None,
    limit: int = 20,
    db: AsyncSession = Depends(get_db),
):
    """List recent stream history."""
    q = select(LiveStream).order_by(LiveStream.created_at.desc()).limit(limit)
    if channel_id:
        q = q.where(LiveStream.channel_id == channel_id)
    result = await db.execute(q)
    return [LiveStreamResponse.model_validate(s) for s in result.scalars()]


@router.get("/{stream_id}", response_model=LiveStreamResponse)
async def get_stream(
    stream_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Get details for a specific stream."""
    stream = await db.get(LiveStream, stream_id)
    if not stream:
        raise HTTPException(status_code=404, detail="Stream not found")
    return LiveStreamResponse.model_validate(stream)
