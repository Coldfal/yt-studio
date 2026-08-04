from __future__ import annotations

from datetime import datetime
from typing import Optional

from pydantic import BaseModel


class ChannelCreate(BaseModel):
    name: str
    niche: str = "custom"
    description: Optional[str] = None
    default_prompt_prefix: Optional[str] = None
    default_image_style: Optional[str] = None
    brand_identity: Optional[str] = None
    target_audience: Optional[str] = None
    default_tags: Optional[str] = None
    title_template: Optional[str] = None
    description_template: Optional[str] = None
    # AI voice (channel-driven system prompt) — see docs/ai-voice-redesign.md
    ai_voice: Optional[str] = None
    ai_example_title: Optional[str] = None
    ai_example_description: Optional[str] = None
    ai_example_tags: Optional[str] = None
    notes: Optional[str] = None
    thumbnail_style_notes: Optional[str] = None
    upload_schedule: Optional[str] = None
    default_video_width: int = 1920
    default_video_height: int = 1080
    default_video_style: str = "ken_burns"


class ChannelUpdate(BaseModel):
    name: Optional[str] = None
    niche: Optional[str] = None
    description: Optional[str] = None
    default_prompt_prefix: Optional[str] = None
    default_image_style: Optional[str] = None
    brand_identity: Optional[str] = None
    target_audience: Optional[str] = None
    default_tags: Optional[str] = None
    title_template: Optional[str] = None
    description_template: Optional[str] = None
    ai_voice: Optional[str] = None
    ai_example_title: Optional[str] = None
    ai_example_description: Optional[str] = None
    ai_example_tags: Optional[str] = None
    notes: Optional[str] = None
    thumbnail_style_notes: Optional[str] = None
    upload_schedule: Optional[str] = None
    default_video_width: Optional[int] = None
    default_video_height: Optional[int] = None
    default_video_style: Optional[str] = None
    # YouTube snippet.defaultLanguage — what language the title/desc
    # are written in (drives the localizations machinery). Examples:
    # 'en' / 'ko' / 'ja' / 'es' / 'zh-Hans'.
    master_language: Optional[str] = None
    # YouTube channel branding — ISO country code + localized channel
    # title/description per language. Pushed via sync-youtube-branding.
    country: Optional[str] = None
    channel_localizations: Optional[dict] = None


class ChannelResponse(BaseModel):
    id: int
    name: str
    niche: str
    description: Optional[str]
    youtube_channel_id: Optional[str]
    youtube_connected: bool = False
    default_prompt_prefix: Optional[str]
    default_image_style: Optional[str]
    brand_identity: Optional[str] = None
    target_audience: Optional[str] = None
    default_tags: Optional[str] = None
    title_template: Optional[str] = None
    description_template: Optional[str] = None
    ai_voice: Optional[str] = None
    ai_example_title: Optional[str] = None
    ai_example_description: Optional[str] = None
    ai_example_tags: Optional[str] = None
    notes: Optional[str] = None
    thumbnail_style_notes: Optional[str] = None
    upload_schedule: Optional[str] = None
    default_video_width: int
    default_video_height: int
    default_video_style: str
    master_language: str = "en"
    country: Optional[str] = None
    channel_localizations: Optional[dict] = None
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class ChannelStats(BaseModel):
    total_projects: int = 0
    projects_by_status: dict = {}
    total_assets: int = 0
