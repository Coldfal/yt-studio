from __future__ import annotations

from datetime import datetime
from typing import Optional, List, Any, Dict, TYPE_CHECKING

from sqlalchemy import Integer, String, Text, DateTime, Boolean, Float, ForeignKey, JSON, func
from sqlalchemy.orm import Mapped, backref, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.channel import Channel


class LiveStream(Base):
    __tablename__ = "live_streams"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[str] = mapped_column(
        String(20), default="preparing"
    )  # preparing, starting, live, stopping, stopped, failed

    # YouTube API identifiers
    broadcast_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    stream_id: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    rtmp_url: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Configuration
    title: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    image_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # `music_folder_path` is the original "scan a filesystem directory" mode.
    # New modes use the channel's own imported assets instead.
    music_folder_path: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    # Pick a specific image from the channel's library (overrides image_path).
    image_asset_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True,
    )
    # When true, draw the audio pool from the channel's imported music assets
    # (ignores music_folder_path).
    use_channel_music_assets: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False,
    )
    target_duration_hours: Mapped[float] = mapped_column(Float, default=4.0)

    # Audio-reactive visualizer (Node sidecar) — same engine as composed videos.
    use_visualizer: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False,
    )
    # Full ProjectConfig, same shape as VideoProject.composition_config.
    visualizer_config: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSON, nullable=True,
    )
    visualizer_preset_id: Mapped[Optional[str]] = mapped_column(
        String(50), nullable=True,
    )

    # "composed video" mode — stream a pre-rendered MP4 from the asset library
    # to RTMP instead of rendering in real time. Most efficient option for
    # long 24/7-style music streams since there's no live encoding load.
    composed_asset_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True,
    )

    # Runtime state
    ffmpeg_pid: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    tracks_used: Mapped[Optional[List[Any]]] = mapped_column(JSON, nullable=True)
    total_audio_duration: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    stopped_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # Relationships. ``passive_deletes=True`` on the back-reference is
    # essential — see the equivalent note in automation_preset.py.
    # Without it, deleting a Channel makes SQLAlchemy try to UPDATE
    # every live_stream's channel_id to NULL, which fails because the
    # column is NOT NULL. The DB's ON DELETE CASCADE on the FK handles
    # the actual row cleanup.
    channel: Mapped["Channel"] = relationship(
        "Channel",
        backref=backref("live_streams", passive_deletes=True),
        passive_deletes=True,
    )
