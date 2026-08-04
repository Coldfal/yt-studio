from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class PromptCreate(BaseModel):
    channel_id: int
    prompt_type: str
    name: str
    content: str


class PromptUpdate(BaseModel):
    name: Optional[str] = None
    content: Optional[str] = None
    prompt_type: Optional[str] = None
    is_favorite: Optional[bool] = None


class PromptResponse(BaseModel):
    id: int
    channel_id: int
    prompt_type: str
    name: str
    content: str
    is_favorite: bool
    times_used: int
    last_used_at: Optional[datetime] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
