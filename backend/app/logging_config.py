"""Structured logging setup.

Two outputs:

- **Console** — human-readable colored output. What you see in
  ``uvicorn``'s terminal. Good for development.
- **File** (``backend.log`` in the project root) — JSON lines, one
  log event per line. Easy to grep, parse, or feed into ``jq`` /
  log shippers later.

Every log event automatically gets these context fields when present:

- ``task_id`` — set by the task runner when it picks up a task
- ``channel_id`` — set when working on a specific channel
- ``phase`` — current phase of a multi-step pipeline
- ``error_type`` — exception class name on failure paths

Usage from anywhere:

    import structlog
    log = structlog.get_logger(__name__)
    log.info("compose_started", task_id=task_id, channel_id=cid)

Or via the standard library logger (already wired):

    logging.getLogger(__name__).info("compose_started",
        extra={"task_id": task_id})

Both routes end up in the same JSON blob in ``backend.log``.
"""
from __future__ import annotations

import logging
import logging.config
import sys
from pathlib import Path

import structlog
from structlog.types import EventDict

from app.config import settings


def _drop_color_message_key(_: object, __: str, event_dict: EventDict) -> EventDict:
    """uvicorn dumps `color_message` into the event for color console
    output. We don't want it in JSON files — strip it.
    """
    event_dict.pop("color_message", None)
    return event_dict


def configure_logging(log_path: Path | None = None) -> None:
    """Wire up structlog + the standard logging module so they share the
    same handlers and formatters.

    Idempotent — safe to call once at startup. Subsequent calls reset
    handlers to avoid duplicates if uvicorn reloads.
    """
    log_path = log_path or (settings.project_root / "backend.log")

    timestamper = structlog.processors.TimeStamper(fmt="iso")

    # Shared processors — applied to every record before formatting,
    # whether it came in via stdlib logging or structlog.
    shared_processors: list = [
        structlog.contextvars.merge_contextvars,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.add_log_level,
        structlog.processors.StackInfoRenderer(),
        timestamper,
        _drop_color_message_key,
    ]

    structlog.configure(
        processors=shared_processors + [
            # Hand off to stdlib formatters at the end.
            structlog.stdlib.ProcessorFormatter.wrap_for_formatter,
        ],
        logger_factory=structlog.stdlib.LoggerFactory(),
        cache_logger_on_first_use=True,
    )

    # JSON formatter for the log file
    file_formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.processors.JSONRenderer(),
        ],
    )

    # Pretty console formatter
    console_formatter = structlog.stdlib.ProcessorFormatter(
        foreign_pre_chain=shared_processors,
        processors=[
            structlog.stdlib.ProcessorFormatter.remove_processors_meta,
            structlog.dev.ConsoleRenderer(colors=True),
        ],
    )

    file_handler = logging.FileHandler(str(log_path), encoding="utf-8")
    file_handler.setFormatter(file_formatter)

    console_handler = logging.StreamHandler(sys.stdout)
    console_handler.setFormatter(console_formatter)

    root = logging.getLogger()
    # Remove anything that may have been attached previously (uvicorn
    # adds its own when it boots — we want to fully control format).
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(console_handler)
    root.addHandler(file_handler)
    root.setLevel(logging.DEBUG if settings.debug else logging.INFO)

    # Silence library noise that doesn't help us. Keep WARN/ERROR.
    for noisy in ("httpcore", "httpx", "urllib3", "google.auth.transport.requests"):
        logging.getLogger(noisy).setLevel(logging.WARNING)

    # SQLAlchemy echo is loud — leave it controlled by `settings.debug`
    # via the engine's own echo flag, not by us.
