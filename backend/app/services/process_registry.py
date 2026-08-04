"""Per-task subprocess registry.

When a background task spawns external processes (ffmpeg, node sidecar
for the visualizer engine, ytdlp, etc.), it registers the ``Popen``
here so the task cancel endpoint can hard-kill them. Without this, the
existing ``cancel_task`` endpoint only flipped the DB row to
``cancelled`` while the underlying ffmpeg kept burning CPU until it
finished naturally — operator-reported pain (2026-05-16) when trying
to abandon a stuck Isekai render.

Concurrency:
- The registry is shared mutable state accessed from both the
  asyncio main thread (cancel endpoint) and the executor threads
  where ``Popen`` lives. Guarded by ``threading.Lock``.
- ``CURRENT_TASK_ID`` is a ``ContextVar`` set by the handler in
  ``task_runner._dispatcher`` before running the task body. Python
  3.7+ ``loop.run_in_executor`` automatically copies the context to
  the executor thread, so subprocess wrappers can read the task_id
  without threading it through every function signature.
"""
from __future__ import annotations

import logging
import subprocess
import threading
from contextvars import ContextVar
from typing import Optional

logger = logging.getLogger(__name__)

# Stores live Popen instances per task_id. We hold tuples of
# (Popen, label) so logs can say which subprocess we're killing
# (ffmpeg vs. node sidecar etc.).
_lock = threading.Lock()
_registry: dict[int, list[tuple[subprocess.Popen, str]]] = {}

CURRENT_TASK_ID: ContextVar[Optional[int]] = ContextVar(
    "current_task_id", default=None,
)


def register(proc: subprocess.Popen, label: str = "subprocess") -> Optional[int]:
    """Register ``proc`` under the current task_id (from the ContextVar).
    Returns the task_id it was registered under, or None if no task
    context is active (e.g. a one-off ad-hoc call outside the handler
    chain — registration is a silent no-op in that case).
    """
    task_id = CURRENT_TASK_ID.get()
    if task_id is None:
        return None
    with _lock:
        _registry.setdefault(task_id, []).append((proc, label))
    logger.debug(
        "process_registry: registered %s pid=%s under task %d",
        label, proc.pid, task_id,
    )
    return task_id


def unregister(proc: subprocess.Popen) -> None:
    """Remove ``proc`` from whichever task slot it lives in. Safe to
    call multiple times — no-op if already removed."""
    with _lock:
        for tid, entries in list(_registry.items()):
            for i, (p, _label) in enumerate(entries):
                if p is proc:
                    entries.pop(i)
                    if not entries:
                        del _registry[tid]
                    return


def kill_task(task_id: int) -> int:
    """Terminate every subprocess registered under ``task_id``.
    Returns the count of processes that were still alive and got a
    kill signal. Idempotent — already-dead processes are silently
    skipped.

    Uses ``terminate()`` then escalates to ``kill()`` after 2 seconds
    for any process that refuses to die. ffmpeg responds to SIGTERM
    by flushing buffers + exiting cleanly within ~500ms; node
    sidecars usually go down on the first signal too.
    """
    import time
    with _lock:
        entries = list(_registry.get(task_id, []))
    if not entries:
        logger.info("process_registry: no subprocesses for task %d", task_id)
        return 0

    killed = 0
    pending: list[tuple[subprocess.Popen, str]] = []
    for proc, label in entries:
        try:
            if proc.poll() is None:
                logger.info(
                    "process_registry: terminating %s pid=%s for task %d",
                    label, proc.pid, task_id,
                )
                proc.terminate()
                pending.append((proc, label))
                killed += 1
        except Exception as exc:
            logger.warning(
                "process_registry: terminate failed for %s pid=%s: %s",
                label, getattr(proc, "pid", "?"), exc,
            )

    # Give them ~2s to exit gracefully, then SIGKILL any survivors.
    if pending:
        time.sleep(2.0)
        for proc, label in pending:
            try:
                if proc.poll() is None:
                    logger.info(
                        "process_registry: hard-killing %s pid=%s for task %d",
                        label, proc.pid, task_id,
                    )
                    proc.kill()
            except Exception as exc:
                logger.warning(
                    "process_registry: kill failed for %s pid=%s: %s",
                    label, getattr(proc, "pid", "?"), exc,
                )

    # Clean up registry entries.
    with _lock:
        _registry.pop(task_id, None)
    return killed


def active_task_ids() -> list[int]:
    """Snapshot of task_ids that currently have live subprocesses.
    Useful for diagnostics / the operator status surface."""
    with _lock:
        return list(_registry.keys())
