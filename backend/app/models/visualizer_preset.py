"""Saved visualizer configurations. Scoped per channel so different
channels can have different default looks."""

from __future__ import annotations

from datetime import datetime
from typing import TYPE_CHECKING, Any, Optional

from sqlalchemy import Boolean, DateTime, ForeignKey, Integer, String, func
from sqlalchemy.orm import Mapped, mapped_column, relationship
from sqlalchemy.types import JSON

from app.database import Base

if TYPE_CHECKING:
    from app.models.channel import Channel


class VisualizerPreset(Base):
    __tablename__ = "visualizer_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(100), nullable=False)
    # The preset ID chosen in the MV editor (e.g. "trap-nation", "radial-waveform").
    preset_id: Mapped[str] = mapped_column(String(50), nullable=False)
    # Full ProjectConfig shape — JSON.
    config: Mapped[dict[str, Any]] = mapped_column(JSON, nullable=False)
    # When true, this preset is applied automatically to new projects on the
    # channel. Only one preset per channel should have is_default=True.
    is_default: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # JPEG snapshot captured from the live preview canvas when the preset is saved.
    thumbnail_url: Mapped[Optional[str]] = mapped_column(String(500), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now(), nullable=False
    )

    channel: Mapped["Channel"] = relationship("Channel")
