from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

from app.config import settings
from app.database import init_db
from app.exceptions import AppError
from app.logging_config import configure_logging
from app.api.router import api_router
from app.workers.task_runner import task_runner
from app.workers.automation_scheduler import automation_scheduler_loop
from app.services.streaming_service import stream_manager

# Wire structured logging *before* any module-level loggers fire.
configure_logging()

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup

    # Bump the default ThreadPoolExecutor. asyncio's default sizes it
    # ``min(32, cpu_count + 4)`` — on a 4-core box that's 8 threads
    # total for the entire app. Composes pin ~2 threads each (one on
    # subprocess.wait() for the visualizer-engine node sidecar, one
    # on ffmpeg.wait() for the trim/extend step), so 2-3 parallel
    # composes already eat half the pool. Other ``run_in_executor``
    # callers (Claude CLI, ytdlp, sync DB ops in API handlers,
    # streaming helpers — 28 callsites total) end up waiting for a
    # thread. Bumping to 32 is essentially free: idle threads cost
    # ~8KB each and the OS will reclaim if unused. They're mostly
    # blocked on subprocess I/O anyway, not consuming CPU.
    import concurrent.futures as _cf
    _executor = _cf.ThreadPoolExecutor(
        max_workers=32, thread_name_prefix="app-executor",
    )
    asyncio.get_event_loop().set_default_executor(_executor)

    # Surface a missing / corrupt encryption key BEFORE we try to use it
    # mid-request. Logs a clear message instead of a stack trace.
    from app.utils.crypto import ensure_key_available, CryptoKeyError
    try:
        ensure_key_available()
    except CryptoKeyError as exc:
        import logging as _logging
        _logging.getLogger(__name__).error(
            "Backend cannot decrypt stored credentials: %s. "
            "OAuth tokens and API keys will be unreadable until this is fixed.",
            exc,
        )

    await init_db()
    runner_task = asyncio.create_task(task_runner.run())
    scheduler_task = asyncio.create_task(automation_scheduler_loop())

    # Event-loop lag monitor: every 100ms we schedule a callback that
    # checks how long it took to actually run. If the gap is >150ms,
    # *something* is doing synchronous work on the main loop and that
    # explains UI sluggishness during composes. Each stall is logged
    # so we can correlate with the operation that caused it.
    #
    # Stats are also exposed via GET /api/diagnostics/loop-lag so the
    # frontend / debugger can read recent stall history without
    # tailing the log file.
    from app.utils.loop_lag_monitor import LoopLagMonitor
    lag_monitor = LoopLagMonitor()
    lag_task = asyncio.create_task(lag_monitor.run())
    app.state.lag_monitor = lag_monitor

    # Mark orphaned streams as failed
    await stream_manager.recover_on_startup()

    # Sweep abandoned OAuth state rows (>15 min) so the app_settings table
    # doesn't accumulate thousands of stale `youtube_oauth_state__*` entries
    # over months of use.
    from app.api.youtube import expire_oauth_state_on_startup
    try:
        await expire_oauth_state_on_startup()
    except Exception as exc:
        import logging
        logging.getLogger(__name__).warning(
            "OAuth state startup sweep failed: %s", exc
        )

    # Recover any pending tasks from previous session
    from app.database import async_session
    from sqlalchemy import select
    from app.models.task import BackgroundTask
    async with async_session() as session:
        result = await session.execute(
            select(BackgroundTask.id).where(
                BackgroundTask.status.in_(["pending", "running"])
            )
        )
        stale_ids = [row[0] for row in result.all()]
        for tid in stale_ids:
            await task_runner.enqueue(tid)
        if stale_ids:
            import logging
            logging.getLogger(__name__).info(
                "Recovered %d pending tasks from previous session: %s",
                len(stale_ids), stale_ids,
            )

    yield
    # Shutdown
    await stream_manager.stop_all()
    scheduler_task.cancel()
    runner_task.cancel()
    lag_task.cancel()
    for t in (scheduler_task, runner_task, lag_task):
        try:
            await t
        except asyncio.CancelledError:
            pass


app = FastAPI(
    title="YT Studio",
    description="YouTube Channel Automation Studio",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url, "http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)


# ── Exception handlers ──────────────────────────────────────────────
# Map our custom AppError subclasses to consistent JSON responses so
# clients can rely on the shape regardless of which service raised.
@app.exception_handler(AppError)
async def _app_error_handler(request: Request, exc: AppError) -> JSONResponse:
    # 5xx are real bugs / outages — log with stack. 4xx are client
    # errors and should not pollute the log file.
    if exc.status_code >= 500:
        logger.exception(
            "AppError on %s %s: %s", request.method, request.url.path, exc.message
        )
    else:
        logger.info(
            "AppError on %s %s (%d): %s",
            request.method,
            request.url.path,
            exc.status_code,
            exc.message,
        )
    return JSONResponse(
        status_code=exc.status_code,
        content={
            "error": exc.code,
            "message": exc.message,
            "details": exc.details,
        },
    )


# Serve asset files
settings.assets_dir.mkdir(parents=True, exist_ok=True)
app.mount("/files", StaticFiles(directory=str(settings.assets_dir)), name="files")
