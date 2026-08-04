"""Automation pipeline (Phase 2 split).

Public API preserved from the pre-split monolith:

    from app.services.automation_service import automation_service
    automation_service.execute_run(preset_id=...)
    automation_service.quick_generate(channel_id=...)

Implementation lives in submodules:
- ``execute_run``     — folder-mode flow (cron-scheduled presets)
- ``quick_generate``  — library-mode flow (dashboard one-click)
- ``_shared``         — track selection, image selection, metadata generation

Re-exports the helper functions tests reach into directly:
``_select_tracks`` (track selection algorithm) and
``_format_duration`` (M:SS formatter).
"""
from __future__ import annotations

from typing import Callable, Optional

# Re-exports for backward compat with existing imports + tests.
from ._shared import (
    _format_duration,
    _select_tracks,
    format_duration,
    generate_metadata,
    select_image_from_library,
    select_tracks,
)
from .execute_run import run_execute
from .quick_generate import run_quick_generate


class AutomationService:
    """Thin orchestrator that delegates into the submodules.

    Kept as a class (rather than module-level functions) so callers
    can keep doing ``automation_service.execute_run(...)`` and tests
    can keep monkey-patching ``automation_service._select_image_from_library``.
    """

    async def execute_run(
        self,
        preset_id: int,
        on_progress: Optional[Callable[[float, str], None]] = None,
    ) -> dict:
        return await run_execute(preset_id, on_progress)

    async def quick_generate(
        self,
        channel_id: int,
        preset_id: Optional[int] = None,
        on_progress: Optional[Callable[[float, str], None]] = None,
        approved_package: Optional[dict] = None,
    ) -> dict:
        return await run_quick_generate(
            channel_id, preset_id, on_progress, approved_package=approved_package,
        )

    # Test surface — tests monkey-patch this on the singleton, so we
    # keep a thin method that delegates to the module-level helper.
    async def _select_image_from_library(
        self,
        channel_id: int,
        pinned_id: Optional[int] = None,
        *,
        include_used: bool = False,
    ):
        return await select_image_from_library(
            channel_id, pinned_id, include_used=include_used,
        )


# Module-level singleton (preserves the existing import path)
automation_service = AutomationService()


__all__ = [
    "AutomationService",
    "automation_service",
    "_format_duration",
    "_select_tracks",
    "format_duration",
    "select_tracks",
    "select_image_from_library",
    "generate_metadata",
    "run_execute",
    "run_quick_generate",
]
