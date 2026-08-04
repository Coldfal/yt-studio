from __future__ import annotations

from datetime import datetime
from typing import Optional, Dict, Any, List, TYPE_CHECKING

from sqlalchemy import Integer, String, Text, DateTime, Float, ForeignKey, JSON, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.automation_preset import AutomationPreset
    from app.models.video_project import VideoProject


class AutomationRun(Base):
    __tablename__ = "automation_runs"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    # Cascade so deleting an AutomationPreset removes its run history.
    # Tasks/projects use SET NULL since the run can outlive them.
    preset_id: Mapped[int] = mapped_column(
        Integer,
        ForeignKey("automation_presets.id", ondelete="CASCADE"),
        nullable=False,
    )
    task_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("background_tasks.id", ondelete="SET NULL"),
        nullable=True,
    )
    project_id: Mapped[Optional[int]] = mapped_column(
        Integer,
        ForeignKey("video_projects.id", ondelete="SET NULL"),
        nullable=True,
    )

    status: Mapped[str] = mapped_column(String(30), default="pending")
    # Statuses: pending, scanning, selecting, merging, composing,
    #           generating_metadata, uploading, completed, failed

    # What was selected
    selected_tracks: Mapped[Optional[List[Any]]] = mapped_column(JSON, nullable=True)
    selected_image: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    total_duration: Mapped[Optional[float]] = mapped_column(Float, nullable=True)

    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )

    # Relationships
    preset: Mapped["AutomationPreset"] = relationship("AutomationPreset", back_populates="runs")
    project: Mapped[Optional["VideoProject"]] = relationship("VideoProject")
