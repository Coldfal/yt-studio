from __future__ import annotations

from fastapi import APIRouter

from app.api.settings import router as settings_router
from app.api.channels import router as channels_router
from app.api.assets import router as assets_router
from app.api.projects import router as projects_router
from app.api.tasks import router as tasks_router
from app.api.music import router as music_router
from app.api.compose import router as compose_router
from app.api.metadata import router as metadata_router
from app.api.youtube import router as youtube_router
from app.api.prompts import router as prompts_router
from app.api.automation import router as automation_router
from app.api.streaming import router as streaming_router
from app.api.images import router as images_router
from app.api.visualizer_presets import router as visualizer_presets_router
from app.api.stats import router as stats_router
from app.api.loops import router as loops_router
from app.api.fs import router as fs_router
from app.api.analytics import router as analytics_router
from app.api.fonts import router as fonts_router
from app.api.voice_profiles import (
    router as voice_profiles_router,
    apply_router as voice_apply_router,
    history_router as voice_history_router,
)
from app.api.asset_sets import router as asset_sets_router
from app.api.diagnostics import router as diagnostics_router

api_router = APIRouter()
api_router.include_router(settings_router)
api_router.include_router(channels_router)
api_router.include_router(assets_router)
api_router.include_router(projects_router)
api_router.include_router(tasks_router)
api_router.include_router(music_router)
api_router.include_router(compose_router)
api_router.include_router(metadata_router)
api_router.include_router(youtube_router)
api_router.include_router(prompts_router)
api_router.include_router(automation_router)
api_router.include_router(streaming_router)
api_router.include_router(images_router)
api_router.include_router(visualizer_presets_router)
api_router.include_router(stats_router)
api_router.include_router(loops_router)
api_router.include_router(fs_router)
api_router.include_router(analytics_router)
api_router.include_router(fonts_router)
api_router.include_router(voice_profiles_router)
api_router.include_router(voice_apply_router)
api_router.include_router(voice_history_router)
api_router.include_router(asset_sets_router)
api_router.include_router(diagnostics_router)
