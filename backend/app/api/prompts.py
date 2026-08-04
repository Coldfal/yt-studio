from __future__ import annotations

from datetime import datetime
from typing import Optional, List

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Prompt
from app.schemas.prompt import PromptCreate, PromptUpdate, PromptResponse

router = APIRouter(prefix="/api/prompts", tags=["prompts"])


def _prompt_to_response(prompt: Prompt) -> PromptResponse:
    return PromptResponse(
        id=prompt.id,
        channel_id=prompt.channel_id,
        prompt_type=prompt.prompt_type,
        name=prompt.name,
        content=prompt.content,
        is_favorite=prompt.is_favorite,
        times_used=prompt.times_used,
        last_used_at=prompt.last_used_at,
        created_at=prompt.created_at,
        updated_at=prompt.updated_at,
    )


@router.get("/", response_model=List[PromptResponse])
async def list_prompts(
    channel_id: Optional[int] = Query(default=None),
    prompt_type: Optional[str] = Query(default=None),
    is_favorite: Optional[bool] = Query(default=None),
    db: AsyncSession = Depends(get_db),
) -> List[PromptResponse]:
    stmt = select(Prompt)
    if channel_id is not None:
        stmt = stmt.where(Prompt.channel_id == channel_id)
    if prompt_type is not None:
        stmt = stmt.where(Prompt.prompt_type == prompt_type)
    if is_favorite is not None:
        stmt = stmt.where(Prompt.is_favorite == is_favorite)
    result = await db.execute(stmt)
    prompts = result.scalars().all()
    return [_prompt_to_response(p) for p in prompts]


@router.post("/", response_model=PromptResponse, status_code=201)
async def create_prompt(
    body: PromptCreate,
    db: AsyncSession = Depends(get_db),
) -> PromptResponse:
    prompt = Prompt(**body.model_dump())
    db.add(prompt)
    await db.commit()
    await db.refresh(prompt)
    return _prompt_to_response(prompt)


@router.get("/{prompt_id}", response_model=PromptResponse)
async def get_prompt(
    prompt_id: int,
    db: AsyncSession = Depends(get_db),
) -> PromptResponse:
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    return _prompt_to_response(prompt)


@router.put("/{prompt_id}", response_model=PromptResponse)
async def update_prompt(
    prompt_id: int,
    body: PromptUpdate,
    db: AsyncSession = Depends(get_db),
) -> PromptResponse:
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(prompt, field, value)

    await db.commit()
    await db.refresh(prompt)
    return _prompt_to_response(prompt)


@router.delete("/{prompt_id}", status_code=204, response_class=Response)
async def delete_prompt(
    prompt_id: int,
    db: AsyncSession = Depends(get_db),
):
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    await db.delete(prompt)
    await db.commit()


@router.post("/{prompt_id}/use", response_model=PromptResponse)
async def use_prompt(
    prompt_id: int,
    db: AsyncSession = Depends(get_db),
) -> PromptResponse:
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt.times_used = (prompt.times_used or 0) + 1
    prompt.last_used_at = datetime.utcnow()
    await db.commit()
    await db.refresh(prompt)
    return _prompt_to_response(prompt)


@router.post("/{prompt_id}/favorite", response_model=PromptResponse)
async def toggle_favorite(
    prompt_id: int,
    db: AsyncSession = Depends(get_db),
) -> PromptResponse:
    prompt = await db.get(Prompt, prompt_id)
    if not prompt:
        raise HTTPException(status_code=404, detail="Prompt not found")
    prompt.is_favorite = not prompt.is_favorite
    await db.commit()
    await db.refresh(prompt)
    return _prompt_to_response(prompt)
