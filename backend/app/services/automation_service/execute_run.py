"""Cron-fired automation runs.

Historically this module ran a separate "folder-scan" pipeline that
read music + images directly from on-disk paths configured on the
``AutomationPreset`` (``music_folder_path`` / ``image_folder_path``),
copied them into the channel's asset library, then composed +
uploaded.

In the streamlined-automation revamp (Phase 1) we collapsed that into
a thin shim that delegates to ``run_quick_generate`` so cron-fired
runs go through *exactly* the same code the dashboard's "Generate
now" button uses. One code path, one bug surface, one set of
behaviours.

Why a shim instead of deleting outright
---------------------------------------
A handful of import sites still reference ``run_execute`` /
``automation_service.execute_run`` (the AutomationService method
wrapper, the task_runner's legacy fallback branch, possibly old
tests). Replacing those in lockstep is more risk than keeping a
two-line redirect that's free at runtime. After a week of clean
scheduled runs we can delete this file and the wrapper method.

Operator note
-------------
Channels that previously had folder-only assets (the preset's
``music_folder_path`` pointed at a directory but no Asset rows
existed in the library) will now fail the pre-flight in
``run_quick_generate`` with a clear "0 music assets" error. The fix
is a one-time import via the Library page's "Import folder" action.
"""
from __future__ import annotations

import logging
from typing import Callable, Optional

from app.database import async_session
from app.models import AutomationPreset

from .quick_generate import run_quick_generate

logger = logging.getLogger(__name__)


async def run_execute(
    preset_id: int,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> dict:
    """Run a scheduled automation. Now a shim over ``run_quick_generate``.

    Resolves the preset's channel_id and forwards the call. Behaviour
    is identical to clicking the dashboard's "Generate now" button on
    that channel, with the preset's saved settings applied.
    """
    async with async_session() as session:
        preset = await session.get(AutomationPreset, preset_id)
        if preset is None:
            raise ValueError(f"AutomationPreset {preset_id} not found")
        channel_id = preset.channel_id

    logger.info(
        "execute_run -> quick_generate (preset=%d, channel=%d)",
        preset_id, channel_id,
    )
    return await run_quick_generate(
        channel_id=channel_id,
        preset_id=preset_id,
        on_progress=on_progress,
    )
