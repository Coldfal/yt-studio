"""Tests for the per-(provider, channel) token-bucket rate limiter."""
from __future__ import annotations

import asyncio

import pytest

from app.services.rate_limiter import RateLimiter, _PROVIDER_BUDGETS


@pytest.mark.asyncio
async def test_acquire_succeeds_immediately_when_bucket_full():
    limiter = RateLimiter()
    # Suno bucket: capacity 3. First call should be instant.
    await asyncio.wait_for(
        limiter.acquire(provider="suno", channel_id=1),
        timeout=0.05,
    )


@pytest.mark.asyncio
async def test_acquire_blocks_when_bucket_drained():
    limiter = RateLimiter()
    # Drain the bucket. youtube_upload capacity = 2.
    await limiter.acquire(provider="youtube_upload", channel_id=1)
    await limiter.acquire(provider="youtube_upload", channel_id=1)
    # Third call should block — we cancel after a short wait.
    third = asyncio.create_task(
        limiter.acquire(provider="youtube_upload", channel_id=1),
    )
    done, pending = await asyncio.wait({third}, timeout=0.1)
    assert third in pending
    third.cancel()
    try:
        await third
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_buckets_are_isolated_by_channel():
    """Saturating channel 1 must not affect channel 2 — that's the
    whole point of per-channel keying."""
    limiter = RateLimiter()
    # Drain channel 1's youtube_upload bucket (capacity 2).
    await limiter.acquire(provider="youtube_upload", channel_id=1)
    await limiter.acquire(provider="youtube_upload", channel_id=1)
    # Channel 2 should be untouched and instant.
    await asyncio.wait_for(
        limiter.acquire(provider="youtube_upload", channel_id=2),
        timeout=0.05,
    )


@pytest.mark.asyncio
async def test_buckets_are_isolated_by_provider():
    """Saturating Suno on a channel must not affect Claude on the same
    channel."""
    limiter = RateLimiter()
    # Suno capacity 3 — drain it.
    await limiter.acquire(provider="suno", channel_id=1)
    await limiter.acquire(provider="suno", channel_id=1)
    await limiter.acquire(provider="suno", channel_id=1)
    # Claude on the same channel should be free.
    await asyncio.wait_for(
        limiter.acquire(provider="claude_cli", channel_id=1),
        timeout=0.05,
    )


@pytest.mark.asyncio
async def test_try_acquire_returns_false_when_bucket_drained():
    limiter = RateLimiter()
    # OpenAI dalle capacity 2 — drain it.
    assert await limiter.try_acquire(provider="openai_dalle", channel_id=1)
    assert await limiter.try_acquire(provider="openai_dalle", channel_id=1)
    # Third try fails fast, doesn't block.
    assert not await limiter.try_acquire(provider="openai_dalle", channel_id=1)


@pytest.mark.asyncio
async def test_try_acquire_returns_true_with_room():
    limiter = RateLimiter()
    assert await limiter.try_acquire(provider="claude_cli", channel_id=1)


@pytest.mark.asyncio
async def test_unknown_provider_uses_default_budget():
    """A new provider that isn't in _PROVIDER_BUDGETS should still get
    a working bucket (default capacity 5). Catches the case where a
    new provider integration ships before the budget table updates."""
    limiter = RateLimiter()
    for _ in range(5):
        assert await limiter.try_acquire(
            provider="brand_new_provider", channel_id=1,
        )
    # 6th call should fail.
    assert not await limiter.try_acquire(
        provider="brand_new_provider", channel_id=1,
    )


@pytest.mark.asyncio
async def test_snapshot_reports_bucket_state():
    limiter = RateLimiter()
    snap = await limiter.snapshot(provider="suno", channel_id=1)
    assert snap["provider"] == "suno"
    assert snap["channel_id"] == 1
    assert snap["capacity"] == _PROVIDER_BUDGETS["suno"].capacity
    assert snap["tokens_available"] == _PROVIDER_BUDGETS["suno"].capacity


@pytest.mark.asyncio
async def test_snapshot_reflects_consumption():
    limiter = RateLimiter()
    await limiter.acquire(provider="suno", channel_id=1)
    snap = await limiter.snapshot(provider="suno", channel_id=1)
    # We consumed 1 of 3 — 2 left (give or take refill in the
    # microseconds between calls).
    assert snap["tokens_available"] <= _PROVIDER_BUDGETS["suno"].capacity - 1
    assert snap["tokens_available"] >= _PROVIDER_BUDGETS["suno"].capacity - 1.5


@pytest.mark.asyncio
async def test_global_bucket_when_channel_id_none():
    """Some providers (e.g. youtube_api with the app-level API key)
    aren't channel-scoped. ``channel_id=None`` should give a separate
    shared bucket distinct from any per-channel bucket."""
    limiter = RateLimiter()
    snap_global = await limiter.snapshot(provider="youtube_api", channel_id=None)
    snap_ch1 = await limiter.snapshot(provider="youtube_api", channel_id=1)
    # Both buckets exist, neither has been consumed yet — so the
    # tokens_available is the full capacity for both. The point is
    # consuming from one shouldn't drain the other.
    assert snap_global["tokens_available"] == snap_ch1["tokens_available"]
    await limiter.acquire(provider="youtube_api", channel_id=None)
    snap_global = await limiter.snapshot(provider="youtube_api", channel_id=None)
    snap_ch1 = await limiter.snapshot(provider="youtube_api", channel_id=1)
    assert snap_global["tokens_available"] < snap_ch1["tokens_available"]
