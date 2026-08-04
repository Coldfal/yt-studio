from __future__ import annotations

from datetime import datetime
from typing import Optional, Dict, Any, List

from pydantic import BaseModel


class AutomationPresetCreate(BaseModel):
    channel_id: int
    name: str
    is_primary: bool = False
    music_folder_path: str
    image_folder_path: str = ""
    image_source: str = "folder"
    image_generation_prompt: Optional[str] = None
    target_duration_seconds: int = 3600
    audio_extensions: str = '["mp3","wav","flac","ogg","m4a"]'
    video_style: str = "spectrum"
    composition_config: Optional[Dict[str, Any]] = None
    metadata_mode: str = "template"
    title_template: Optional[str] = None
    description_template: Optional[str] = None
    tags_template: Optional[str] = None
    claude_prompt: Optional[str] = None
    youtube_privacy: str = "private"
    youtube_category_id: str = "10"
    made_for_kids: bool = False
    auto_upload: bool = True
    schedule_cron: Optional[str] = None
    schedule_timezone: str = "UTC"


class AutomationPresetUpdate(BaseModel):
    name: Optional[str] = None
    is_active: Optional[bool] = None
    is_primary: Optional[bool] = None
    music_folder_path: Optional[str] = None
    image_folder_path: Optional[str] = None
    image_source: Optional[str] = None
    image_generation_prompt: Optional[str] = None
    target_duration_seconds: Optional[int] = None
    num_tracks: Optional[int] = None
    audio_extensions: Optional[str] = None
    video_style: Optional[str] = None
    composition_config: Optional[Dict[str, Any]] = None
    visualizer_color_override: Optional[Dict[str, Any]] = None
    visualizer_disabled: Optional[bool] = None
    particle_style: Optional[str] = None
    particle_density: Optional[int] = None
    default_thumbnail_asset_id: Optional[int] = None
    default_thumbnail_editor_state: Optional[Dict[str, Any]] = None
    output_fps: Optional[int] = None
    visualizer_preset_id: Optional[int] = None
    metadata_mode: Optional[str] = None
    title_template: Optional[str] = None
    description_template: Optional[str] = None
    tags_template: Optional[str] = None
    claude_prompt: Optional[str] = None
    youtube_privacy: Optional[str] = None
    youtube_category_id: Optional[str] = None
    made_for_kids: Optional[bool] = None
    auto_upload: Optional[bool] = None
    scheduled_publish_at: Optional[datetime] = None
    # Auto-translate languages list. Pass `[]` or `null` to disable.
    auto_translate_languages: Optional[List[str]] = None
    schedule_cron: Optional[str] = None
    schedule_timezone: Optional[str] = None
    next_image_asset_id: Optional[int] = None
    next_image_pinned: Optional[bool] = None
    # Phase 2 of streamlined-automation: opt in to folder-pairing.
    # When True, Quick Generate picks an image from a folder with a
    # ``pair_group`` label, then constrains the music selection to
    # tracks whose folder has the same ``pair_group``.
    use_folder_pairing: Optional[bool] = None
    # Phase 5: when True, Quick Generate picks a random active AssetSet
    # (bg+thumbnail tuple) instead of independently picking a bg + sticky
    # thumbnail. See AssetSet model + /api/asset-sets router.
    use_asset_sets: Optional[bool] = None
    # Phase 7: thumbnail-template auto-generator config. See model
    # docstring on AutomationPreset.thumbnail_template.
    thumbnail_template: Optional[Dict[str, Any]] = None
    # Operator UX (2026-05-15): bypass the Phase-1 preview-before-
    # generate drawer when the operator trusts the auto pipeline.
    skip_preview_drawer: Optional[bool] = None
    # Operator UX (2026-05-15): gate the Phase-7b template renderer.
    # When False, Quick Generate uses the sticky thumbnail (if any)
    # instead of rendering a fresh templated JPEG.
    auto_generate_thumbnail: Optional[bool] = None
    # Phase 3: nudge Claude to produce shorter metadata. Style still
    # comes from the channel voice; this is a length cap.
    terse_metadata: Optional[bool] = None


class AutomationPresetResponse(BaseModel):
    id: int
    channel_id: int
    name: str
    is_active: bool
    is_primary: bool
    music_folder_path: str
    image_folder_path: str
    image_source: str
    image_generation_prompt: Optional[str]
    target_duration_seconds: int
    num_tracks: Optional[int] = None
    audio_extensions: str
    video_style: str
    composition_config: Optional[Dict[str, Any]]
    visualizer_color_override: Optional[Dict[str, Any]] = None
    visualizer_disabled: bool = False
    particle_style: Optional[str] = None
    particle_density: Optional[int] = None
    default_thumbnail_asset_id: Optional[int] = None
    default_thumbnail_editor_state: Optional[Dict[str, Any]] = None
    output_fps: Optional[int] = None
    visualizer_preset_id: Optional[int] = None
    metadata_mode: str
    title_template: Optional[str]
    description_template: Optional[str]
    tags_template: Optional[str]
    claude_prompt: Optional[str]
    youtube_privacy: str
    youtube_category_id: str
    made_for_kids: bool
    auto_upload: bool
    scheduled_publish_at: Optional[datetime] = None
    auto_translate_languages: Optional[List[str]] = None
    schedule_cron: Optional[str]
    schedule_timezone: str
    next_run_at: Optional[datetime]
    last_run_at: Optional[datetime]
    last_run_status: Optional[str]
    last_run_error: Optional[str]
    next_image_asset_id: Optional[int] = None
    next_image_picked_at: Optional[datetime] = None
    next_image_pinned: bool = False
    use_folder_pairing: bool = False
    use_asset_sets: bool = False
    thumbnail_template: Optional[Dict[str, Any]] = None
    skip_preview_drawer: bool = False
    auto_generate_thumbnail: bool = True
    terse_metadata: bool = False
    created_at: datetime
    updated_at: datetime

    class Config:
        from_attributes = True


class AutomationRunResponse(BaseModel):
    id: int
    preset_id: int
    task_id: Optional[int]
    project_id: Optional[int]
    status: str
    selected_tracks: Optional[List[Any]]
    selected_image: Optional[str]
    total_duration: Optional[float]
    error: Optional[str]
    started_at: Optional[datetime]
    completed_at: Optional[datetime]
    created_at: datetime

    class Config:
        from_attributes = True


class ScanFolderRequest(BaseModel):
    folder_path: str
    extensions: List[str] = ["mp3", "wav", "flac", "ogg", "m4a"]


class ScanFolderResponse(BaseModel):
    folder_path: str
    file_count: int
    total_duration_seconds: float
    files: List[Dict[str, Any]]
