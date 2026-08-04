from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class AssetFolderResponse(BaseModel):
    id: int
    channel_id: int
    asset_type: str
    name: str
    # Optional free-text label used by AutomationPreset.use_folder_pairing
    # to tie image and music folders together. NULL means "ungrouped".
    pair_group: Optional[str] = None
    asset_count: int = 0
    created_at: datetime

    class Config:
        from_attributes = True


class AssetResponse(BaseModel):
    id: int
    channel_id: int
    asset_type: str
    # Per-asset sub-classification for images. See Asset model comment
    # for valid values (background / thumbnail / overlay / reference).
    # NULL for music / video / composed assets — role only matters
    # for images today.
    role: Optional[str] = None
    source: str
    filename: str
    filepath: str
    file_url: str = ""
    file_size: Optional[int]
    duration_seconds: Optional[float]
    mime_type: Optional[str]
    prompt: Optional[str]
    title: Optional[str]
    description: Optional[str]
    folder_id: Optional[int] = None
    folder_name: Optional[str] = None
    # ``True`` when the file referenced by ``filepath`` is present on disk.
    # Computed at response time (cheap — one ``os.path.exists`` call per row).
    # Defaults True for backward compat in tests / fixture data.
    file_exists: bool = True
    created_at: datetime

    class Config:
        from_attributes = True
