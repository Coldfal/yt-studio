"""Task runner unit tests.

Covers the bits that don't need a real handler: timeout/retry policy,
the retry classifier, the retry HTTP endpoint, and the task-state
machine for the simplest handler we can mock cleanly.
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock

import pytest

from app.exceptions import (
    CredentialError,
    ServiceError,
    TimeoutExceededError,
    ValidationError,
)
from app.models import BackgroundTask
from app.workers.task_runner import (
    _backoff,
    _is_retryable,
    _retries_for,
    _timeout_for,
    task_runner,
)


# Note: only async tests need the asyncio mark. Apply per-test below.


# ── Policy tables ────────────────────────────────────────────────────


def test_timeout_for_known_types():
    assert _timeout_for("video_composition") == 60 * 60
    assert _timeout_for("youtube_upload") == 30 * 60
    assert _timeout_for("metadata_generation") == 5 * 60


def test_timeout_for_unknown_type_falls_back_to_default():
    # Defaults to 30 min for anything we haven't classified.
    assert _timeout_for("totally_invented_task_type") == 30 * 60


def test_retries_for_compose_is_zero():
    # Compose is expensive — never auto-retry.
    assert _retries_for("video_composition") == 0


def test_retries_for_upload_is_two():
    # Network-y task; allow a couple of retries on transient 5xx.
    assert _retries_for("youtube_upload") == 2


def test_is_retryable_classifier():
    assert _is_retryable(ServiceError("transient")) is True
    assert _is_retryable(TimeoutExceededError("slow")) is True
    assert _is_retryable(ConnectionError("network")) is True
    assert _is_retryable(TimeoutError("io")) is True
    # Permanent failures must not retry.
    assert _is_retryable(CredentialError("bad token")) is False
    assert _is_retryable(ValidationError("bad input")) is False
    assert _is_retryable(ValueError("plain")) is False


# ── Backoff sleep ────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_backoff_sleeps_and_returns(monkeypatch):
    calls: list[float] = []

    async def fake_sleep(d: float) -> None:
        calls.append(d)

    monkeypatch.setattr(asyncio, "sleep", fake_sleep)
    await _backoff(0)
    await _backoff(1)
    await _backoff(2)
    # Each call must produce some delay >= base * 2**attempt.
    assert calls[0] >= 4.0
    assert calls[1] >= 8.0
    assert calls[2] >= 16.0
    # All capped at 60s + 25% jitter.
    assert all(d <= 75.0 for d in calls)


# ── Retry HTTP endpoint ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_retry_resets_failed_task_to_pending(db, channel, mocker):
    """The /retry route should reset state and re-enqueue."""
    enqueue = mocker.patch.object(task_runner, "enqueue", new=AsyncMock())

    t = BackgroundTask(
        task_type="metadata_generation",
        status="failed",
        channel_id=channel.id,
        progress=42.0,
        error="boom",
        result={"source": "test"},
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)

    # Import the route function and call it directly so we don't need
    # a TestClient + lifespan startup.
    from app.api.tasks import retry_task

    response = await retry_task(t.id, db=db)
    assert response.status == "pending"
    assert response.error is None
    assert response.progress == 0.0

    # Result blob must survive — handlers re-read input from it.
    assert response.result == {"source": "test"}

    # And the task must have been re-enqueued.
    enqueue.assert_awaited_once_with(t.id)


@pytest.mark.asyncio
async def test_retry_rejects_running_task(db, channel):
    t = BackgroundTask(
        task_type="metadata_generation",
        status="running",
        channel_id=channel.id,
    )
    db.add(t)
    await db.commit()
    await db.refresh(t)

    from fastapi import HTTPException

    from app.api.tasks import retry_task

    with pytest.raises(HTTPException) as exc_info:
        await retry_task(t.id, db=db)
    assert exc_info.value.status_code == 400
