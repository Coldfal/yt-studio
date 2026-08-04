from __future__ import annotations

from datetime import datetime
from typing import Optional, Dict, Any

from sqlalchemy import Integer, String, Text, DateTime, Float, JSON, func
from sqlalchemy.orm import Mapped, mapped_column

from app.database import Base


class BackgroundTask(Base):
    __tablename__ = "background_tasks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    task_type: Mapped[str] = mapped_column(String(30), nullable=False)
    status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending")
    project_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    channel_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    progress: Mapped[float] = mapped_column(Float, default=0.0)
    status_message: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    result: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    started_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    completed_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Phase 4 of farm redesign: operator-set when the Fleet triage
    # panel "Dismiss" button is clicked on a failed task. Triage
    # queries filter on this so dismissed failures stop reappearing,
    # but the row stays for the audit trail.
    acknowledged_at: Mapped[Optional[datetime]] = mapped_column(
        DateTime, nullable=True,
    )
    # Touched on every progress update — useful for debugging stuck tasks
    # and for retention sweeps that delete by last activity.
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, server_default=func.now(), onupdate=func.now()
    )
