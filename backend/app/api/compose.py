from __future__ import annotations

from typing import Any, Dict

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import BackgroundTask, VideoProject
from app.schemas.task import TaskResponse
from app.workers.task_runner import task_runner

router = APIRouter(prefix="/api/compose", tags=["compose"])

# Default ProjectConfig for the visualizer editor — mirrors MV's
# DEFAULT_PROJECT_CONFIG in types.ts. Keep in sync.
_VISUALIZER_DEFAULT_CONFIG: Dict[str, Any] = {
    "presetId": "trap-nation",
    # Visualizer
    "waveformScale": 1.0,
    "waveformSmoothing": 0.7,
    "reactivity": 0.6,
    "spectrumFill": "filled",
    # Linear layout
    "linearPosition": "bottom",
    "linearRepeat": 6,
    "linearBarColor": "#ff4444",
    "linearYOffset": 0.08,
    "linearWidth": 1.0,
    "linearCenterTextSource": "none",
    "linearCenterText": "",
    "linearCenterTextSize": 140,
    "linearCenterTextOffsetY": 0,
    # Custom draggable texts
    "customTexts": [],
    # Colors
    "waveColor1": "#ffffff",
    "waveColor2": "#a855f7",
    "backgroundColor": "#0f0f1a",
    "accentColor": "#ec4899",
    # Text
    "artistName": "",
    "trackName": "",
    "fontFamily": "Geist",
    "fontSize": 32,
    "textPosition": "bottom",
    "textColor": "#ffffff",
    # Backdrop
    "backgroundFit": "cover",
    "reflection": "none",
    "backgroundRotate": 0,
    "backgroundFilter": False,
    "backgroundDrift": False,
    "backgroundRumble": False,
    # Elements
    "particles": True,
    "particleStyle": "floating",
    "particleDensity": 50,
    "particleColor": "#ffffff",
    # Logo
    "logoEnabled": False,
    "logoScale": 1.0,
    "logoBorderRadius": 50,
    # Overlay
    "overlayEnabled": False,
    "overlayPosition": "bottom-right",
    "overlayScale": 0.5,
    "overlayOpacity": 0.8,
    "overlayOffsetX": 0,
    "overlayOffsetY": 0,
    # Background type
    "backgroundType": "image",
    # Beat effects
    "beatShake": False,
    "beatZoom": False,
    "beatShakeIntensity": 0.6,
    "beatZoomIntensity": 0.5,
    # Output settings
    "output_width": 1920,
    "output_height": 1080,
    "output_fps": 30,
    "crf": 23,
}


COMPOSITION_STYLES = [
    {
        "name": "loop",
        "description": "Loop a short video clip and audio track to a target duration (e.g. 1 hour)",
        "default_config": {
            "target_duration": 3600,
            "output_width": 1920,
            "output_height": 1080,
        },
    },
    {
        "name": "ken_burns",
        "description": "Slow pan and zoom over images (Ken Burns effect)",
        "default_config": {
            "zoom_range": [1.0, 1.3],
            "pan_speed": 0.02,
            "transition": "crossfade",
            "transition_duration": 1.0,
        },
    },
    {
        "name": "static",
        "description": "Static images displayed in sequence with transitions",
        "default_config": {
            "transition": "crossfade",
            "transition_duration": 1.0,
            "duration_per_image": 5.0,
        },
    },
    {
        "name": "spectrum",
        "description": "Audio-reactive music visualizer — 15 presets (Trap Nation, radial waveform, particle storm, neon ring, etc.) with full customization",
        "default_config": _VISUALIZER_DEFAULT_CONFIG,
    },
]


class ComposeStartRequest(BaseModel):
    project_id: int
    style: str
    config: Dict[str, Any] = {}


@router.get("/styles")
async def list_styles() -> list[dict]:
    return COMPOSITION_STYLES


class ExtendRequest(BaseModel):
    project_id: int
    target_duration_seconds: int
    # When True, the output is rounded DOWN to a whole multiple of the
    # source duration — songs always finish but the operator may get
    # significantly less than they asked for (e.g. ask 2h20m vs 62min
    # source → got 2h04m). Default False: output is exactly the target,
    # last song may cut mid-track. Operator can use the frontend's
    # "Snap to nearest track end" button to pick a clean boundary first.
    snap_to_song: bool = False


@router.post("/extend", response_model=TaskResponse, status_code=201)
async def extend_video(
    body: ExtendRequest,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    """Loop the project's already-composed video to a target duration via
    FFmpeg concat (no re-encoding). Cheaper than re-rendering."""
    project = await db.get(VideoProject, body.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if project.composed_asset_id is None:
        raise HTTPException(
            status_code=400,
            detail="Project has no composed video to extend",
        )
    if body.target_duration_seconds <= 0:
        raise HTTPException(
            status_code=400, detail="target_duration_seconds must be > 0",
        )

    task = BackgroundTask(
        task_type="video_extend",
        status="pending",
        project_id=project.id,
        channel_id=project.channel_id,
        result={
            "target_duration_seconds": body.target_duration_seconds,
            "snap_to_song": body.snap_to_song,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    await task_runner.enqueue(task.id)
    return TaskResponse.model_validate(task)


@router.post("/start", response_model=TaskResponse, status_code=201)
async def start_composition(
    body: ComposeStartRequest,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    project = await db.get(VideoProject, body.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    has_music = (
        project.music_asset_id is not None
        or (project.music_asset_ids and len(project.music_asset_ids) > 0)
        or (project.music_folder_files and len(project.music_folder_files) > 0)
    )
    if not has_music:
        raise HTTPException(
            status_code=400, detail="Project must have a music asset before composing"
        )

    if not project.image_asset_ids or len(project.image_asset_ids) == 0:
        raise HTTPException(
            status_code=400, detail="Project must have at least one image asset"
        )

    # Save composition config to the project
    project.video_style = body.style
    project.composition_config = body.config

    task = BackgroundTask(
        task_type="video_composition",
        status="pending",
        project_id=project.id,
        channel_id=project.channel_id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    await task_runner.enqueue(task.id)

    return TaskResponse.model_validate(task)
