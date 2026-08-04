from __future__ import annotations

from datetime import datetime
from typing import Optional, List, TYPE_CHECKING

from sqlalchemy import Integer, String, Text, DateTime, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.video_project import VideoProject
    from app.models.asset import Asset
    from app.models.prompt import Prompt


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    niche: Mapped[str] = mapped_column(String(20), nullable=False, default="custom")
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    youtube_channel_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    youtube_credentials_json: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_prompt_prefix: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_image_style: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    brand_identity: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    target_audience: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    title_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    description_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # YouTube ``snippet.defaultLanguage`` — tells YouTube which language
    # the title/description are written in. Critical for the
    # "Korean master + auto-localized to en/ja/es" pattern: if this is
    # 'en' but the title is Korean, YouTube serves the Korean title to
    # Korean viewers verbatim (which works) but the algorithm has the
    # wrong primary-language signal (which hurts reach). Default 'en'
    # preserves the original behaviour for every existing channel.
    master_language: Mapped[str] = mapped_column(
        String(10), nullable=False, server_default="en", default="en",
    )

    # YouTube ``brandingSettings.channel.country`` — 2-letter ISO 3166-1
    # alpha-2 code (e.g. 'JP'). NULL = leave YouTube's value untouched.
    # Pushed to YouTube via the sync-youtube-branding endpoint.
    country: Mapped[Optional[str]] = mapped_column(String(2), nullable=True)

    # YouTube channel-level ``localizations``: localized channel title +
    # description per BCP-47 code. Shape:
    #   {"ja": {"title": "...", "description": "..."}, "en": {...}}
    # Distinct from the per-VIDEO youtube_translations on VideoProject —
    # this is the channel's About page in each language.
    channel_localizations: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)

    # ── AI metadata voice (system-prompt content per channel) ────────────
    # Replaces the hardcoded YomiBeats-flavored ``style_block()`` that
    # forced every channel through the same brand voice. When these are
    # set, ``claude_cli_service.style_block(channel)`` reads them directly;
    # when empty, a generic fallback runs (writes a competent SEO title +
    # description without channel-specific typographic mannerisms).
    #
    # See ``docs/ai-voice-redesign.md`` for the full rationale.
    ai_voice: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_title: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    ai_example_tags: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Free-form operator notes for this channel — what's working, what's not,
    # observations from YouTube Studio, lessons learned over time. Gets
    # injected into the metadata-generation system prompt as a "## Operator
    # notes" section so Claude can weigh them when picking titles, tags, and
    # description copy. Distinct from ai_voice (hard style rules) — these are
    # the soft, evolving learnings that grow with the channel.
    notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    thumbnail_style_notes: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    upload_schedule: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    default_video_width: Mapped[int] = mapped_column(Integer, default=1920)
    default_video_height: Mapped[int] = mapped_column(Integer, default=1080)
    default_video_style: Mapped[str] = mapped_column(String(50), default="ken_burns")
    # Project memory — stores the last successful compose settings so new
    # projects for this channel can inherit them as a starting point.
    last_composition_config: Mapped[Optional[dict]] = mapped_column(JSON, nullable=True)
    last_visualizer_preset_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    last_music_source: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    last_image_asset_ids: Mapped[Optional[List[int]]] = mapped_column(JSON, nullable=True)
    # Last folder path used in folder-mode music selection — pre-fills the
    # New Video wizard's folder input so users don't retype it per video.
    last_music_folder_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    projects: Mapped[List["VideoProject"]] = relationship("VideoProject", back_populates="channel", cascade="all, delete-orphan")
    assets: Mapped[List["Asset"]] = relationship("Asset", back_populates="channel", cascade="all, delete-orphan")
    prompts: Mapped[List["Prompt"]] = relationship("Prompt", back_populates="channel", cascade="all, delete-orphan")
