from __future__ import annotations

from datetime import datetime
from typing import Any, Dict, List, Optional

from pydantic import BaseModel


class StartStreamRequest(BaseModel):
    channel_id: int
    title: str
    description: str = ""
    target_duration_hours: float = 4.0
    # ── Source for audio/video ───────────────────────────────────
    # Pick ONE of three modes:
    #  1) composed_asset_id — stream a pre-rendered MP4 (most efficient)
    #  2) use_visualizer + (channel music OR folder) — live render (CPU heavy)
    #  3) folder/channel music + static image — legacy simple RTMP
    composed_asset_id: Optional[int] = None
    music_folder_path: Optional[str] = None
    use_channel_music_assets: bool = False
    image_asset_id: Optional[int] = None
    image_path: Optional[str] = None
    use_visualizer: bool = False
    visualizer_config: Optional[Dict[str, Any]] = None
    visualizer_preset_id: Optional[str] = None


class StopStreamRequest(BaseModel):
    pass  # stream id comes from URL path


class LiveStreamResponse(BaseModel):
    id: int
    channel_id: int
    status: str
    broadcast_id: Optional[str]
    stream_id: Optional[str]
    title: str
    description: Optional[str]
    image_path: Optional[str]
    image_asset_id: Optional[int]
    music_folder_path: Optional[str]
    use_channel_music_assets: bool
    target_duration_hours: float
    use_visualizer: bool
    visualizer_config: Optional[Dict[str, Any]]
    visualizer_preset_id: Optional[str]
    composed_asset_id: Optional[int]
    ffmpeg_pid: Optional[int]
    tracks_used: Optional[List[Any]]
    total_audio_duration: Optional[float]
    started_at: Optional[datetime]
    stopped_at: Optional[datetime]
    error: Optional[str]
    created_at: datetime

    class Config:
        from_attributes = True
