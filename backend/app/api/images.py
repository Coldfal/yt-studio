from __future__ import annotations

from typing import Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import BackgroundTask, Asset
from app.schemas.task import TaskResponse
from app.schemas.asset import AssetResponse
from app.workers.task_runner import task_runner

router = APIRouter(prefix="/api/images", tags=["images"])


class ImageGenerateRequest(BaseModel):
    channel_id: int
    project_id: Optional[int] = None
    prompt: str
    count: int = Field(default=1, ge=1, le=4)
    size: str = "1792x1024"


class ImageGenerateSyncRequest(BaseModel):
    channel_id: int
    prompt: str
    size: str = "1792x1024"


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
async def generate_images(
    body: ImageGenerateRequest,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Queue image generation as a background task."""
    task = BackgroundTask(
        task_type="image_generation",
        status="pending",
        channel_id=body.channel_id,
        project_id=body.project_id,
        result={
            "prompt": body.prompt,
            "count": body.count,
            "size": body.size,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    await task_runner.enqueue(task.id)

    return TaskResponse.model_validate(task)


@router.post("/generate-sync", response_model=list[AssetResponse], status_code=201)
async def generate_images_sync(
    body: ImageGenerateSyncRequest,
    db: AsyncSession = Depends(get_db),
) -> list[AssetResponse]:
    """Generate a single image synchronously and return the asset immediately.

    Useful for the project wizard where the user wants quick feedback.
    """
    from app.services.openai_service import openai_service

    results = await openai_service.generate_images(
        prompt=body.prompt,
        channel_id=body.channel_id,
        count=1,
        size=body.size,
    )

    assets: list[AssetResponse] = []
    for r in results:
        asset = Asset(
            channel_id=body.channel_id,
            asset_type="image",
            # AI-generated images come from the visualizer's "Generate
            # background" panel — their purpose is to be video bgs, so
            # default to role="background". Operator can re-tag to
            # "reference" / "thumbnail" via the library if they want
            # to use one differently.
            role="background",
            source="ai_generated",
            filename=r["filename"],
            filepath=r["asset_path"],
            file_size=r["file_size"],
            mime_type="image/png",
            prompt=body.prompt,
            title=r.get("revised_prompt", "")[:200],
        )
        db.add(asset)
        await db.flush()
        assets.append(_asset_to_response(asset))

    await db.commit()
    return assets
