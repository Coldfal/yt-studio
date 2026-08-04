from __future__ import annotations

import asyncio
import sys

import uvicorn
from app.config import settings

# On Windows, asyncio defaults to SelectorEventLoop which cannot create
# subprocesses (needed by the Claude CLI service). Switch to ProactorEventLoop
# before uvicorn takes over so subprocess calls work in all async contexts.
if sys.platform == "win32":
    asyncio.set_event_loop_policy(asyncio.WindowsProactorEventLoopPolicy())

if __name__ == "__main__":
    # Scope file watching to the ``app`` source tree only — otherwise
    # installing packages (numpy, Pillow, …) into venv triggers a reload
    # storm from the thousands of changed files inside site-packages.
    uvicorn.run(
        "app.main:app",
        host=settings.host,
        port=settings.port,
        reload=settings.debug,
        reload_dirs=["app"] if settings.debug else None,
    )
