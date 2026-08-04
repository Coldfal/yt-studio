from __future__ import annotations

from datetime import datetime
from typing import Optional, Dict, Any

from pydantic import BaseModel


class TaskResponse(BaseModel):
    id: int
    task_type: str
    status: str
    project_id: Optional[int]
    channel_id: Optional[int]
    progress: float
    status_message: Optional[str]
    result: Optional[Dict[str, Any]]
    error: Optional[str]
    created_at: datetime
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    # Phase 4 of farm redesign — operator-dismiss timestamp.
    acknowledged_at: Optional[datetime] = None

    class Config:
        from_attributes = True
