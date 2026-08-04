"""Per-(provider, channel) token-bucket rate limiter (Phase 3).

The reasoning behind this rather than just "request per second" caps:

- **Suno / OpenAI / Claude / YouTube** all enforce daily/hourly
  budgets that drift between accounts. We need to track usage per
  account (i.e. per channel that owns the OAuth/API key) without
  hard-coding the limits.
- The plan calls out "token-bucket per (provider, channel_id)" so a
  spike on one channel can't starve another.

This module gives the worker pool (and the upcoming retry/backoff
helpers in ``task_runner``) a single async API:

    rate_limiter.acquire(provider="claude", channel_id=1, cost=1)

If the bucket has tokens, returns immediately. Otherwise sleeps
until one is available. Buckets are configured per-provider and
default-share when a channel hasn't been called out specifically.

In-memory only on purpose: the runner is single-process today, and
when Phase 3 retention deletes old rows the buckets reset naturally
on next backend restart. Persisting state across restarts would
need a Redis or DB-row store; not worth the complexity until we hit
multi-process.
"""
from __future__ import annotations

import asyncio
import logging
import time
from dataclasses import dataclass
from typing import Optional

logger = logging.getLogger(__name__)


# Per-provider default budgets. ``rate_per_minute`` is how fast tokens
# refill; ``capacity`` is the burst headroom. A bucket starts full so
# the first call doesn't have to wait. These numbers are deliberate:
#
# - youtube_upload: YouTube's quota is 10,000 units/day, an upload
#   costs 1,600. That's ~6/day. We rate-limit at 1/min so a flood
#   of retry-storms can't burn the daily budget in 30s.
# - youtube_api  : 10,000 units/day, a search/list costs 1-100. We
#   stay generous (60/min) and let YouTube's own 403 quota errors
#   tell us when we've hit a real limit.
# - claude_cli   : Subscription-tier rate limits aren't documented
#   exactly; ~30/min keeps us inside community-reported caps with
#   plenty of headroom.
# - openai_dalle : Dalle-3 image generation. ~5/min per the published
#   tier-1 limits.
# - suno         : Suno API doesn't publish a hard rate, but the
#   community-observed throttle is around 10/min per account.
@dataclass(frozen=True)
class _Budget:
    rate_per_minute: float
    capacity: int


_PROVIDER_BUDGETS: dict[str, _Budget] = {
    "youtube_upload": _Budget(rate_per_minute=1.0, capacity=2),
    "youtube_api":    _Budget(rate_per_minute=60.0, capacity=10),
    "claude_cli":     _Budget(rate_per_minute=30.0, capacity=5),
    "openai_dalle":   _Budget(rate_per_minute=5.0, capacity=2),
    "suno":           _Budget(rate_per_minute=10.0, capacity=3),
}
_DEFAULT_BUDGET = _Budget(rate_per_minute=30.0, capacity=5)


@dataclass
class _Bucket:
    """A single token bucket. Tokens refill linearly at
    ``budget.rate_per_minute / 60`` per second up to ``budget.capacity``.
    """
    budget: _Budget
    # Tokens currently available. Starts full so the first call
    # doesn't pay a refill wait.
    tokens: float
    # Wall-clock time of the last refill calculation. We update this
    # lazily on every acquire() rather than running a refill ticker.
    last_refill_at: float
    # asyncio.Lock so concurrent acquires on the same bucket don't
    # race the refill arithmetic. Cheap (no contention when buckets
    # have headroom).
    lock: asyncio.Lock

    def _refill(self) -> None:
        """Add tokens earned since the last refill, capped at capacity."""
        now = time.monotonic()
        elapsed = now - self.last_refill_at
        if elapsed <= 0:
            return
        per_second = self.budget.rate_per_minute / 60.0
        self.tokens = min(
            self.budget.capacity,
            self.tokens + elapsed * per_second,
        )
        self.last_refill_at = now

    def _seconds_until_n_tokens(self, n: float) -> float:
        """Estimate the wait until ``n`` tokens are available. Used by
        ``acquire`` to pick the next sleep interval. Never negative."""
        if self.tokens >= n:
            return 0.0
        per_second = self.budget.rate_per_minute / 60.0
        if per_second <= 0:
            # Pathological bucket — should never happen for known
            # providers, but a 0-rate bucket means "block forever".
            # Cap at 60s so the caller can be cancelled.
            return 60.0
        return (n - self.tokens) / per_second


class RateLimiter:
    """Per-(provider, channel) token bucket store. Singleton via the
    module-level ``rate_limiter`` below."""

    def __init__(self) -> None:
        self._buckets: dict[tuple[str, Optional[int]], _Bucket] = {}
        # Outer lock guards bucket creation only — once a bucket exists
        # its own lock is used.
        self._registry_lock = asyncio.Lock()

    async def _get_bucket(
        self, provider: str, channel_id: Optional[int]
    ) -> _Bucket:
        key = (provider, channel_id)
        bucket = self._buckets.get(key)
        if bucket is not None:
            return bucket
        async with self._registry_lock:
            # Double-check under the lock — another coroutine may have
            # created the bucket between our check and the acquire.
            bucket = self._buckets.get(key)
            if bucket is None:
                budget = _PROVIDER_BUDGETS.get(provider, _DEFAULT_BUDGET)
                bucket = _Bucket(
                    budget=budget,
                    tokens=float(budget.capacity),
                    last_refill_at=time.monotonic(),
                    lock=asyncio.Lock(),
                )
                self._buckets[key] = bucket
        return bucket

    async def acquire(
        self,
        *,
        provider: str,
        channel_id: Optional[int] = None,
        cost: int = 1,
    ) -> None:
        """Block until ``cost`` tokens are available, then deduct them.

        ``channel_id=None`` means "shared global bucket for this
        provider" — used for endpoints that aren't channel-scoped
        (e.g. keyword research that hits the YouTube Data API key
        configured at app level rather than per channel)."""
        if cost <= 0:
            return  # nothing to do
        bucket = await self._get_bucket(provider, channel_id)
        while True:
            async with bucket.lock:
                bucket._refill()
                if bucket.tokens >= cost:
                    bucket.tokens -= cost
                    return
                wait_s = bucket._seconds_until_n_tokens(cost)
            # Sleep outside the lock so other coroutines on the same
            # bucket can still see refills if THEIR cost is smaller.
            logger.debug(
                "Rate-limited on %s ch=%s — waiting %.2fs for %d token(s)",
                provider, channel_id, wait_s, cost,
            )
            await asyncio.sleep(min(wait_s + 0.05, 5.0))

    async def try_acquire(
        self,
        *,
        provider: str,
        channel_id: Optional[int] = None,
        cost: int = 1,
    ) -> bool:
        """Non-blocking variant — returns True if tokens were available
        and consumed, False otherwise. Used in code paths that prefer
        to fast-fail rather than block (e.g. keyword research where a
        cache hit is better than a 30s wait)."""
        if cost <= 0:
            return True
        bucket = await self._get_bucket(provider, channel_id)
        async with bucket.lock:
            bucket._refill()
            if bucket.tokens >= cost:
                bucket.tokens -= cost
                return True
            return False

    async def snapshot(
        self, provider: str, channel_id: Optional[int] = None
    ) -> dict:
        """Diagnostic — returns the current bucket state. Used by the
        ``/api/quota`` endpoint that the dashboard plans to surface."""
        bucket = await self._get_bucket(provider, channel_id)
        async with bucket.lock:
            bucket._refill()
            return {
                "provider": provider,
                "channel_id": channel_id,
                "capacity": bucket.budget.capacity,
                "rate_per_minute": bucket.budget.rate_per_minute,
                "tokens_available": round(bucket.tokens, 2),
                "seconds_until_full": (
                    round(bucket._seconds_until_n_tokens(bucket.budget.capacity), 1)
                ),
            }


# Module-level singleton.
rate_limiter = RateLimiter()
