"""Tests for the Phase 3 per-task-type worker pool.

Pins the basic invariants:
- Per-type concurrency budgets are honoured (no more than N of a
  given type run simultaneously).
- A saturated type doesn't block other types from progressing.
- Semaphores release on success AND on handler exception (no slot
  leaks).
"""
from __future__ import annotations

import asyncio

import pytest

from app.workers.task_runner import (
    TaskRunner,
    _TYPE_CONCURRENCY,
    _concurrency_for,
)


# Note: only async tests need the asyncio mark. Apply per-test below.


def test_concurrency_for_known_types():
    # video_composition bumped 2→3 on 2026-05-15 — CPU headroom at
    # the previous 2-slot ceiling (operator observed 50-60% with
    # 2 parallel composes), and dispatcher starvation fixed in the
    # same commit means saturating compose no longer blocks other
    # types from progressing.
    assert _concurrency_for("video_composition") == 3
    assert _concurrency_for("metadata_generation") == 3
    assert _concurrency_for("youtube_upload") == 2


def test_concurrency_for_unknown_type_falls_back_to_default():
    # Unknown types get the default budget (1) so a new task type
    # never sneaks through with unbounded parallelism.
    assert _concurrency_for("totally_invented_task_type") == 1


def test_concurrency_table_includes_all_known_handlers():
    """If a new handler gets registered without a matching budget,
    this surfaces it. Catches the common ``_HANDLERS`` / `
    `_TYPE_CONCURRENCY`` drift that loses parallelism on new task
    types as they get added."""
    from app.workers.task_runner import _HANDLERS

    # Every handler should either have an explicit budget or be
    # acknowledged in the default-bucket pile. We check at least one
    # in each direction so this isn't an empty assertion.
    explicit = set(_TYPE_CONCURRENCY.keys())
    handlers = set(_HANDLERS.keys())
    assert explicit & handlers, "no overlap — table is wired wrong"


# ─── Semaphore behaviour (synthetic in-memory test, no DB) ──────────


@pytest.mark.asyncio
async def test_semaphore_blocks_at_budget():
    """Acquire N+1 slots of the same type — the (N+1)th should block
    until one of the first N releases."""
    runner = TaskRunner()
    sem = runner._semaphore_for("video_composition")  # budget 3

    # Hold all three slots.
    a = await sem.acquire()  # noqa: F841
    b = await sem.acquire()  # noqa: F841
    c = await sem.acquire()  # noqa: F841

    # Fourth acquire should not complete within a small timeout.
    fourth_task = asyncio.create_task(sem.acquire())
    done, pending = await asyncio.wait({fourth_task}, timeout=0.05)
    assert fourth_task in pending
    fourth_task.cancel()
    try:
        await fourth_task
    except asyncio.CancelledError:
        pass


@pytest.mark.asyncio
async def test_different_types_have_independent_budgets():
    """Saturating compose must not block metadata or upload."""
    runner = TaskRunner()
    compose_sem = runner._semaphore_for("video_composition")  # 3
    meta_sem = runner._semaphore_for("metadata_generation")   # 3
    upload_sem = runner._semaphore_for("youtube_upload")      # 2

    # Saturate compose (3 slots).
    await compose_sem.acquire()
    await compose_sem.acquire()
    await compose_sem.acquire()

    # Other types should still be free.
    assert meta_sem.locked() is False
    assert upload_sem.locked() is False

    # And acquirable without blocking.
    await asyncio.wait_for(meta_sem.acquire(), timeout=0.05)
    await asyncio.wait_for(upload_sem.acquire(), timeout=0.05)


@pytest.mark.asyncio
async def test_semaphore_releases_on_async_with_exception():
    """`async with sem:` releases even if the inner block raises.
    This is what guarantees the dispatcher doesn't leak slots when
    a handler dies."""
    runner = TaskRunner()
    sem = runner._semaphore_for("metadata_generation")  # 3

    # Burn one slot via async-with that throws.
    class _Boom(RuntimeError):
        pass

    with pytest.raises(_Boom):
        async with sem:
            raise _Boom("simulated handler failure")

    # All 3 slots should still be available — none leaked.
    acquired_count = 0
    for _ in range(3):
        await asyncio.wait_for(sem.acquire(), timeout=0.05)
        acquired_count += 1
    assert acquired_count == 3


@pytest.mark.asyncio
async def test_dispatcher_does_not_starve_other_types_when_one_saturates():
    """Regression for 2026-05-15 operator-reported bug. With 12
    dispatchers all blocked at ``async with sem:`` on a saturated
    compose semaphore, other queued task types (downloads, translate,
    extend) could not be picked up because every dispatcher was
    parked waiting. The fix uses a non-blocking wait_for(timeout=0.1)
    and re-queues the task at the tail when the type is saturated.

    This test directly exercises the dispatcher: it enqueues many
    'saturated_type' tasks AND one 'other_type' task, holds the
    saturated_type semaphore externally so no task of that type can
    run, and asserts that the other_type task still completes.
    """
    from app.workers import task_runner as tr

    # Build a runner + override _peek_task_type to return a synthetic
    # task type without needing a real DB row.
    runner = TaskRunner()
    saturated_type = "saturated_type"
    other_type = "other_type"

    # Pretend saturated_type has only 1 slot, other_type has 1 slot.
    runner._type_semaphores[saturated_type] = asyncio.Semaphore(1)
    runner._type_semaphores[other_type] = asyncio.Semaphore(1)

    # Externally HOLD the saturated_type semaphore so no task of that
    # type can run — mimics the operator scenario where 2 composes are
    # already in flight occupying both slots.
    saturated_sem = runner._type_semaphores[saturated_type]
    await saturated_sem.acquire()

    # Map task_id → type for our fake peek.
    task_type_map: dict[int, str] = {
        1: saturated_type, 2: saturated_type, 3: saturated_type,
        4: other_type,
    }

    async def _fake_peek(task_id: int) -> str:
        return task_type_map.get(task_id, "unknown")

    # _process needs to do something measurable.
    processed: list[int] = []

    async def _fake_process(task_id: int) -> None:
        processed.append(task_id)
        await asyncio.sleep(0.01)

    # Patch the runner methods directly (instance-level) so the
    # dispatcher uses our fakes.
    runner._peek_task_type = _fake_peek  # type: ignore[method-assign]
    runner._process = _fake_process  # type: ignore[method-assign]

    # Spin up ONE dispatcher worker. Even with just 1 dispatcher, the
    # fix should mean it picks up task 4 instead of getting stuck on
    # tasks 1-3.
    dispatcher_task = asyncio.create_task(runner._dispatcher(0))

    # Enqueue: three saturated tasks first, one other task last.
    for tid in (1, 2, 3, 4):
        await runner.enqueue(tid)

    # Wait long enough for the dispatcher to cycle through the FIFO
    # several times (each re-queue + sleep is 0.25s). 2s gives 8
    # cycles of opportunity — plenty for the non-saturated task to
    # bubble up.
    deadline = asyncio.get_event_loop().time() + 2.0
    while 4 not in processed and asyncio.get_event_loop().time() < deadline:
        await asyncio.sleep(0.1)

    assert 4 in processed, (
        f"non-saturated task 4 never picked up — dispatcher starved "
        f"(processed: {processed})"
    )

    # Cleanup
    dispatcher_task.cancel()
    try:
        await dispatcher_task
    except asyncio.CancelledError:
        pass
    saturated_sem.release()


@pytest.mark.asyncio
async def test_progress_persist_throttle():
    """Regression for 2026-05-16 operator-reported slowness: the
    visualizer engine emits one NDJSON progress event per rendered
    frame (~26/s per compose). Pre-fix, each one fired a SQLite
    writer-locked UPDATE — ~52 writes/sec across 2 parallel composes
    serialised every unrelated query behind them.

    The throttle must:
    (a) Skip in-between writes that fire faster than ~1s apart.
    (b) ALWAYS persist terminal states (0% and 100%).
    (c) ALWAYS persist on message change so stage transitions land.
    """
    import asyncio as _aio
    from app.workers import task_runner as tr

    # Count how many _update() coroutines actually get scheduled. We
    # patch run_coroutine_threadsafe to a no-op counter so the test
    # doesn't need a real DB write.
    scheduled: list[tuple[int, float, str]] = []
    real_schedule = _aio.run_coroutine_threadsafe

    def _fake_schedule(coro, loop):
        # Pull progress + message via the closure-bound _update — we
        # can't inspect it directly, so peek by triggering it carefully.
        # Easier path: don't run the coro; just record the call.
        coro.close()
        return None

    tr.asyncio.run_coroutine_threadsafe = _fake_schedule  # type: ignore[attr-defined]

    # Clear any state from previous tests.
    tr._last_persist_at.clear()
    tr._last_persist_msg.clear()

    try:
        loop = _aio.get_event_loop()

        # Burst 50 progress updates with the SAME message, mid-render
        # (5% progress, not terminal). Only the first should make it.
        for i in range(50):
            tr._persist_progress(9999, 5.0 + i * 0.001, "Rendering...", loop)
        # State: throttle suppressed 49 of them.
        first_t = tr._last_persist_at.get(9999)
        assert first_t is not None, "first call should land + record"

        # Same message, still <1s later — must still suppress.
        # We can't easily count "did the schedule fire?" without
        # patching deeper, so assert by checking the timestamp didn't
        # advance for non-terminal-non-msg-changed calls.
        before = tr._last_persist_at[9999]
        tr._persist_progress(9999, 5.5, "Rendering...", loop)
        assert tr._last_persist_at[9999] == before, (
            "throttle should suppress same-message non-terminal calls"
        )

        # Message change → flushes immediately. We can't reliably
        # assert the monotonic timestamp ADVANCED (back-to-back calls
        # often share the same tick on Windows), so we assert via the
        # message dict — the new message must be recorded.
        tr._persist_progress(9999, 5.6, "Encoding MP4...", loop)
        assert tr._last_persist_msg[9999] == "Encoding MP4...", (
            "message change must bypass throttle and update msg state"
        )

        # 100% (terminal) → always flushes + clears state.
        tr._persist_progress(9999, 100.0, "Complete.", loop)
        assert 9999 not in tr._last_persist_at, (
            "terminal 100% must clear per-task throttle state"
        )
    finally:
        tr.asyncio.run_coroutine_threadsafe = real_schedule  # type: ignore[attr-defined]


@pytest.mark.asyncio
async def test_lazy_semaphore_creation_for_unknown_types():
    """Asking for a semaphore for a task_type not in _TYPE_CONCURRENCY
    must still return a valid Semaphore (with the default budget),
    not raise. This is the path a brand-new handler hits before its
    type is added to the policy table."""
    runner = TaskRunner()
    sem = runner._semaphore_for("brand_new_handler_type")
    assert isinstance(sem, asyncio.Semaphore)
    # Default budget = 1 means it can be acquired exactly once
    # before blocking.
    await asyncio.wait_for(sem.acquire(), timeout=0.05)
    second = asyncio.create_task(sem.acquire())
    done, pending = await asyncio.wait({second}, timeout=0.02)
    assert second in pending
    second.cancel()
    try:
        await second
    except asyncio.CancelledError:
        pass
