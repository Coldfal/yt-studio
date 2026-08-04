from __future__ import annotations

from datetime import datetime
from typing import Optional, List, Dict, Any

from pydantic import BaseModel


class ProjectCreate(BaseModel):
    channel_id: int
    title: str = "Untitled"
    video_style: Optional[str] = None
    music_prompt: Optional[str] = None


class ProjectUpdate(BaseModel):
    title: Optional[str] = None
    status: Optional[str] = None
    music_asset_id: Optional[int] = None
    music_asset_ids: Optional[List[int]] = None
    music_prompt: Optional[str] = None
    music_folder_path: Optional[str] = None
    music_folder_files: Optional[List[str]] = None
    image_asset_ids: Optional[List[int]] = None
    video_style: Optional[str] = None
    composed_asset_id: Optional[int] = None
    composition_config: Optional[Dict[str, Any]] = None
    youtube_title: Optional[str] = None
    youtube_description: Optional[str] = None
    youtube_tags: Optional[List[str]] = None
    youtube_category_id: Optional[str] = None
    youtube_privacy: Optional[str] = None
    youtube_scheduled_at: Optional[datetime] = None
    thumbnail_asset_id: Optional[int] = None
    # Multi-language localisations. Pass `{"ja": {"title": ..., "description": ...}, ...}`
    # to set; pass `null` to clear the column entirely.
    youtube_translations: Optional[Dict[str, Dict[str, str]]] = None
    # In-app thumbnail editor state. See model docs for shape.
    thumbnail_editor_state: Optional[Dict[str, Any]] = None


class ProjectResponse(BaseModel):
    id: int
    channel_id: int
    status: str
    title: str
    music_asset_id: Optional[int]
    music_asset_ids: Optional[List[int]]
    music_prompt: Optional[str]
    music_folder_path: Optional[str]
    music_folder_files: Optional[List[str]]
    image_asset_ids: Optional[List[int]]
    video_style: Optional[str]
    composed_asset_id: Optional[int]
    composition_config: Optional[Dict[str, Any]]
    youtube_title: Optional[str]
    youtube_description: Optional[str]
    youtube_tags: Optional[List[str]]
    youtube_category_id: str
    youtube_privacy: str
    youtube_scheduled_at: Optional[datetime]
    thumbnail_asset_id: Optional[int]
    youtube_translations: Optional[Dict[str, Dict[str, str]]] = None
    thumbnail_editor_state: Optional[Dict[str, Any]] = None
    youtube_video_id: Optional[str]
    youtube_url: Optional[str]
    uploaded_at: Optional[datetime]
    upload_error: Optional[str] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True
