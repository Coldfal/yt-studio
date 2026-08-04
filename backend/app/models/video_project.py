from __future__ import annotations

from datetime import datetime
from typing import Optional, List, Dict, Any, TYPE_CHECKING

from sqlalchemy import Integer, String, Text, DateTime, Float, Boolean, ForeignKey, JSON, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.channel import Channel
    from app.models.asset import Asset


class VideoProjectTrack(Base):
    """Ordered track list for a VideoProject.

    Replaces the ``music_asset_ids`` JSON array with a proper FK table so
    that deleting an Asset automatically removes the dangling pointer
    via CASCADE rather than leaving a stale integer in the JSON column.

    Write path: ``set_project_tracks()`` in ``_shared.py`` always writes
    both this table and the JSON column (backward-compat for reads that
    haven't been migrated yet). Read path: task_runner prefers this
    table; fallback to JSON for old rows.
    """

    __tablename__ = "video_project_tracks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    project_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("video_projects.id", ondelete="CASCADE"),
        nullable=False,
        index=True,
    )
    asset_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("assets.id", ondelete="CASCADE"),
        nullable=False,
    )
    # Zero-based insertion order. Two tracks in the same project cannot
    # share a position — enforced via the UNIQUE constraint below.
    position: Mapped[int] = mapped_column(Integer, nullable=False, default=0)

    __table_args__ = (
        UniqueConstraint(
            "project_id", "position", name="uq_project_track_position"
        ),
    )

    project: Mapped["VideoProject"] = relationship(
        "VideoProject", back_populates="tracks"
    )
    asset: Mapped[Optional["Asset"]] = relationship("Asset")


class VideoProject(Base):
    __tablename__ = "video_projects"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft")
    title: Mapped[str] = mapped_column(String(200), default="Untitled")

    # Music
    # `music_asset_id` points to the single legacy/first track; `music_asset_ids`
    # carries an ordered list for multi-track projects (concatenated at render
    # time by the visualizer engine). When a single track is used, either can
    # be populated — `music_asset_ids` takes precedence if non-empty.
    music_asset_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True)
    music_asset_ids: Mapped[Optional[List[Any]]] = mapped_column(JSON, nullable=True)
    music_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Folder-mode: absolute paths used directly, never imported into the library.
    music_folder_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    music_folder_files: Mapped[Optional[List[str]]] = mapped_column(JSON, nullable=True)

    # Visuals
    image_asset_ids: Mapped[Optional[List[Any]]] = mapped_column(JSON, nullable=True)

    # Composition
    video_style: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    composed_asset_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True)
    composition_config: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)

    # YouTube metadata
    youtube_title: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    youtube_description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    youtube_tags: Mapped[Optional[List[Any]]] = mapped_column(JSON, nullable=True)
    youtube_category_id: Mapped[str] = mapped_column(String(10), default="10")
    youtube_privacy: Mapped[str] = mapped_column(String(20), default="private")
    made_for_kids: Mapped[bool] = mapped_column(Boolean, default=False)
    youtube_scheduled_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    thumbnail_asset_id: Mapped[Optional[int]] = mapped_column(Integer, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True)
    # Editor state for the in-app thumbnail editor (text layers, font picks,
    # background ref, effect-preset choices). The rendered JPEG that gets
    # uploaded to YouTube lives on the linked asset (``thumbnail_asset_id``);
    # this column is purely so re-entering the Thumbnail wizard step
    # restores exactly what the user had. Shape:
    #   { "bg": {"kind": "asset"|"upload"|"video_bg", "asset_id": int|null},
    #     "layers": [
    #       {"text": str, "x": 0-1, "y": 0-1, "font": str, "size": int,
    #        "color": "#rrggbb", "weight": "normal"|"bold",
    #        "align": "left"|"center"|"right",
    #        "effect_preset": "bloom"|"embossed"|"long_shadow"|"chromatic"|"gradient"|"glass"|"none"}
    #     ] }
    thumbnail_editor_state: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)

    # Multi-language YouTube localisations (Phase 2 translation feature).
    # Shape: { "ja": {"title": str, "description": str}, "zh-Hans": ..., "ko": ..., "es": ... }
    # Title is fully translated; description here holds ONLY the translated
    # "top" portion (hook → playlist pitch → "Perfect for:"). The
    # tracklist + hashtags are appended unchanged from the English
    # description at upload time so timestamps + hashtag exposure stay
    # consistent across locales.
    youtube_translations: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSON, nullable=True
    )

    # After upload
    youtube_video_id: Mapped[Optional[str]] = mapped_column(String(50), nullable=True)
    youtube_url: Mapped[Optional[str]] = mapped_column(String(200), nullable=True)
    uploaded_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Last upload error message — populated when auto-upload fails so the
    # dashboard can surface it to the user. Cleared on successful upload.
    upload_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships
    channel: Mapped["Channel"] = relationship("Channel", back_populates="projects")
    music_asset: Mapped[Optional["Asset"]] = relationship("Asset", foreign_keys=[music_asset_id])
    composed_asset: Mapped[Optional["Asset"]] = relationship("Asset", foreign_keys=[composed_asset_id])
    thumbnail_asset: Mapped[Optional["Asset"]] = relationship("Asset", foreign_keys=[thumbnail_asset_id])
    # Ordered track list (m2m table with CASCADE FK on both sides).
    # Use ``set_project_tracks()`` from ``_shared.py`` to write this — it
    # also keeps the ``music_asset_ids`` JSON column in sync for readers
    # that haven't been migrated yet.
    tracks: Mapped[List["VideoProjectTrack"]] = relationship(
        "VideoProjectTrack",
        back_populates="project",
        cascade="all, delete-orphan",
        order_by="VideoProjectTrack.position",
    )
