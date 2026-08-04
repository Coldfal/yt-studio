"""Title-token bandit (Phase 3 of analytics-driven generation).

This module is the only place the system makes data-driven decisions
about which title tokens to recommend. It is intentionally pure code,
NOT a Claude prompt — the user explicitly asked: "We need some code
that does that, not AI prompts."

Design
------
For each channel we walk the LATEST snapshot per video (one row per
video from ``video_analytics_snapshots``), tokenise the cached title,
and aggregate per token:

  - ``samples``         number of distinct videos using the token
  - ``mean_views_per_day`` sum / samples
  - ``ctr_weighted_mean``  Σ(ctr × impressions) / Σ impressions
  - ``score``           combined: z-score of mean_views_per_day plus
                        a CTR boost plus a UCB1-style exploration
                        bonus (so under-sampled tokens still get a
                        chance to climb)

We then classify:
  - ``winner``    score >= median + 1σ
  - ``cold``      score <= median − 1σ AND samples >= 5
  - ``exploring`` everything else, including under-sampled tokens

When the metadata generator asks for a "title pool", we return:
  - ``must_include``: 2 random winners (rotates so the same word
    isn't in every title forever)
  - ``banned``: every cold token
  - ``explore_pool``: a small random sample from the exploring set
    so we keep trying new things

Cold-start safety: if ``samples`` is too low channel-wide
(< 8 distinct videos with snapshots), we return an empty pool —
the generator falls back to its existing channel-voice example
without imposing made-up constraints.
"""
from __future__ import annotations

import logging
import math
import random
import re
from collections import defaultdict
from typing import Iterable, Optional

from sqlalchemy import select, delete
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.database import async_session
from app.models import TitleTokenStat, VideoAnalyticsSnapshot

logger = logging.getLogger(__name__)


# Stop-words and decorative chars — these never participate in the
# bandit. Mirror the frontend's ``tokeniseTitle`` so what shows up in
# the Performance tab matches what the bandit thinks about.
_STOP_WORDS = {
    "and", "the", "for", "with", "your", "from", "this", "that", "you",
    "are", "was", "but", "all", "any", "out", "into", "over", "play",
    "playlist", "mix", "music", "song", "songs",
}
# Permissive token pattern: ASCII letters/digits + Japanese/Korean
# blocks. Multi-codepoint emoji and box-drawing get stripped.
_TOKEN_RE = re.compile(
    r"[A-Za-z0-9぀-ヿ一-鿿가-힯]+",
    flags=re.UNICODE,
)


def tokenise(text: str) -> list[str]:
    """Return a list of lowercased tokens worth tracking."""
    if not text:
        return []
    raw = _TOKEN_RE.findall(text.lower())
    return [w for w in raw if len(w) >= 3 and w not in _STOP_WORDS]


# Minimum unique-video samples for the bandit to be allowed to
# recommend anything. Below this, the generator should just use the
# channel's ai_voice example unaltered.
MIN_VIDEOS_FOR_BANDIT = 8

# Per-token sample threshold for being eligible to be classified
# "cold" — we don't condemn a token after seeing it in just one
# under-performing title.
MIN_SAMPLES_FOR_COLD = 5


def _tokens_for_kind(kind: str, snap: dict) -> set[str]:
    """Extract the set of bandit tokens from a snapshot for one kind.

    Each "kind" answers the question "what should the bandit learn
    from on this video?":
      - ``title``: word tokens from the title.
      - ``description``: word tokens from the description's TOP only
        (the human-facing copy above TRACKLIST). The tracklist and
        hashtags are noise for SEO signal.
      - ``tag``: each YouTube tag is a token verbatim — they're
        already curated short phrases, not free-text we tokenise.
    """
    if kind == "title":
        return set(tokenise(snap.get("title") or ""))
    if kind == "description":
        from app.utils.description_parts import split_top_and_rest
        top, _ = split_top_and_rest(snap.get("description") or "")
        return set(tokenise(top))
    if kind == "tag":
        # ``tags_at_snapshot`` is a JSON list — tokens are the tags
        # themselves, normalised to lowercase + whitespace-trimmed
        # so casing variations don't fragment the bandit's view.
        return {
            str(t).strip().lower()
            for t in (snap.get("tags") or [])
            if t and str(t).strip()
        }
    return set()


async def recompute_token_stats(
    channel_id: int,
    *,
    kinds: tuple[str, ...] = ("title", "description", "tag"),
) -> dict[str, int]:
    """Walk the channel's latest-per-video snapshots and rebuild
    ``title_token_stats`` rows for the given ``kinds``.

    Phase 3 of farm redesign: ``"description"`` and ``"tag"`` are now
    first-class kinds alongside ``"title"``. Each kind runs the same
    UCB1-ish scoring loop against the same snapshot population — only
    the token extractor differs (see ``_tokens_for_kind``).

    Returns a summary: ``{samples_seen, tokens_tracked, winners, cold,
    exploring}`` aggregating across all requested kinds.
    """
    summary: dict[str, int] = {
        "samples_seen": 0,
        "tokens_tracked": 0,
        "winners": 0,
        "cold": 0,
        "exploring": 0,
    }

    # ── 1) Pull the latest snapshot per video (once, shared across kinds) ──
    async with async_session() as session:
        rows = (await session.execute(
            select(
                VideoAnalyticsSnapshot.youtube_video_id,
                VideoAnalyticsSnapshot.snapshot_date,
                VideoAnalyticsSnapshot.title_at_snapshot,
                VideoAnalyticsSnapshot.description_at_snapshot,
                VideoAnalyticsSnapshot.tags_at_snapshot,
                VideoAnalyticsSnapshot.views_per_day,
                VideoAnalyticsSnapshot.ctr,
                VideoAnalyticsSnapshot.impressions,
                VideoAnalyticsSnapshot.avg_view_percentage,
            ).where(VideoAnalyticsSnapshot.channel_id == channel_id)
        )).all()

    # Latest per video, packed into a small dict
    latest: dict[str, dict] = {}
    latest_date: dict[str, "object"] = {}  # noqa: F821
    for r in rows:
        vid, snap_date, title, desc, tags, vpd, ctr, imps, retention = r
        prev_date = latest_date.get(vid)
        if prev_date is None or snap_date > prev_date:
            latest_date[vid] = snap_date
            latest[vid] = {
                "title": title,
                "description": desc,
                "tags": tags,
                "vpd": float(vpd or 0.0),
                "ctr": ctr,
                "impressions": imps,
                "retention": float(retention) if retention is not None else None,
            }
    summary["samples_seen"] = len(latest)

    # Pull manual CTR + operator feedback once (shared across kinds).
    from app.models import VideoManualMetric, MetadataFeedback
    async with async_session() as session:
        manual_rows = (await session.execute(
            select(
                VideoManualMetric.youtube_video_id,
                VideoManualMetric.ctr,
            ).where(VideoManualMetric.channel_id == channel_id)
        )).all()
        feedback_rows = (await session.execute(
            select(
                MetadataFeedback.generated_title,
                MetadataFeedback.generated_description,
                MetadataFeedback.generated_tags,
                MetadataFeedback.operator_rating,
            ).where(MetadataFeedback.channel_id == channel_id)
        )).all()
    manual_ctr_by_vid: dict[str, float] = {
        vid: float(c) for vid, c in manual_rows if c is not None
    }

    # ── 2) Per-kind aggregate + score + write ─────────────────────────
    for kind in kinds:
        if kind not in ("title", "description", "tag"):
            continue
        kind_summary = await _recompute_one_kind(
            channel_id, kind, latest, manual_ctr_by_vid, feedback_rows,
        )
        summary["tokens_tracked"] += kind_summary["tokens_tracked"]
        summary["winners"] += kind_summary["winners"]
        summary["cold"] += kind_summary["cold"]
        summary["exploring"] += kind_summary["exploring"]

    return summary


async def _recompute_one_kind(
    channel_id: int,
    kind: str,
    latest: dict[str, dict],
    manual_ctr_by_vid: dict[str, float],
    feedback_rows: list[tuple],
) -> dict[str, int]:
    """Aggregate + score + write title_token_stats for one kind.

    Same scoring math as before; the kind only affects WHICH tokens
    we extract from each snapshot. ``feedback_rows`` contributes a
    small operator-gut-signal term — helpful on cold channels with
    too little real data.
    """
    Aggregate = lambda: {  # noqa: E731
        "samples": 0,
        "vpd_sum": 0.0,
        "retention_sum": 0.0,
        "retention_samples": 0,
        "manual_ctr_sum": 0.0,
        "manual_ctr_samples": 0,
        # Operator feedback (Phase 3 fast-signal): +1 per thumbs-up
        # row that touched this token, -1 per thumbs-down.
        "feedback_sum": 0,
        "feedback_samples": 0,
        "vpds": [],
    }
    by_token: dict[str, dict] = defaultdict(Aggregate)
    all_vpds: list[float] = []
    all_retentions: list[float] = []
    all_manual_ctrs: list[float] = []

    for vid, snap in latest.items():
        v = snap["vpd"]
        all_vpds.append(v)
        ret = snap.get("retention")
        manual_ctr = manual_ctr_by_vid.get(vid)
        if ret is not None:
            all_retentions.append(ret)
        if manual_ctr is not None:
            all_manual_ctrs.append(manual_ctr)
        toks = _tokens_for_kind(kind, snap)
        for t in toks:
            agg = by_token[t]
            agg["samples"] += 1
            agg["vpd_sum"] += v
            agg["vpds"].append(v)
            if ret is not None:
                agg["retention_sum"] += ret
                agg["retention_samples"] += 1
            if manual_ctr is not None:
                agg["manual_ctr_sum"] += manual_ctr
                agg["manual_ctr_samples"] += 1

    # Feedback layer (Phase 3) — walk MetadataFeedback rows, extract
    # tokens for THIS kind, credit/debit them. Cold-start booster
    # when the channel has < MIN_VIDEOS_FOR_BANDIT real samples.
    for fb_title, fb_desc, fb_tags, rating in feedback_rows:
        synth_snap = {
            "title": fb_title or "",
            "description": fb_desc or "",
            "tags": fb_tags or [],
        }
        fb_tokens = _tokens_for_kind(kind, synth_snap)
        for t in fb_tokens:
            agg = by_token[t]
            agg["feedback_sum"] += int(rating or 0)
            agg["feedback_samples"] += 1

    # Channel-level z-score basis. With < MIN_VIDEOS_FOR_BANDIT we
    # set σ=1 so scores stay tame and no token gets boldly classified.
    if all_vpds:
        mean_vpd = sum(all_vpds) / len(all_vpds)
        var = sum((v - mean_vpd) ** 2 for v in all_vpds) / max(1, len(all_vpds))
        std_vpd = math.sqrt(var) or 1.0
    else:
        mean_vpd = 0.0
        std_vpd = 1.0

    channel_mean_ret = (
        sum(all_retentions) / len(all_retentions)
        if all_retentions else 0.0
    )
    channel_mean_ctr = (
        sum(all_manual_ctrs) / len(all_manual_ctrs)
        if all_manual_ctrs else 0.0
    )

    # Score formula:
    #   z_vpd     = (mean_vpd_token − channel_mean_vpd) / std_vpd
    #   ret_lift  = (mean_ret_token / channel_mean_ret) − 1.0
    #   ctr_lift  = (mean_ctr_token / channel_mean_ctr) − 1.0
    #   fb_lift   = mean_feedback_token (in [-1, 1])
    #   ucb_bonus = sqrt(2 ln(N+1) / samples)
    #   score     = z_vpd + 1.5·ret_lift + 1.5·ctr_lift + 1.0·fb_lift + 0.7·ucb_bonus
    # Feedback weight (1.0) is intentionally just under retention
    # so a single thumbs-up doesn't override 8 videos of real signal,
    # but on a cold-start channel feedback drives the ranking.
    scored: list[tuple[str, dict, float]] = []
    N = max(1, len(latest) + len(feedback_rows))
    for tok, agg in by_token.items():
        if agg["samples"] == 0 and agg["feedback_samples"] == 0:
            continue
        token_mean_vpd = (
            agg["vpd_sum"] / agg["samples"] if agg["samples"] else mean_vpd
        )
        z_vpd = (token_mean_vpd - mean_vpd) / std_vpd
        if agg["retention_samples"] > 0 and channel_mean_ret > 0:
            token_ret = agg["retention_sum"] / agg["retention_samples"]
            ret_lift = (token_ret / channel_mean_ret) - 1.0
        else:
            ret_lift = 0.0
        if agg["manual_ctr_samples"] > 0 and channel_mean_ctr > 0:
            token_ctr = agg["manual_ctr_sum"] / agg["manual_ctr_samples"]
            ctr_lift = (token_ctr / channel_mean_ctr) - 1.0
        else:
            ctr_lift = 0.0
        fb_lift = (
            agg["feedback_sum"] / agg["feedback_samples"]
            if agg["feedback_samples"] else 0.0
        )
        total_samples = max(1, agg["samples"] + agg["feedback_samples"])
        ucb_bonus = math.sqrt(2 * math.log(N + 1) / total_samples)
        score = z_vpd + 1.5 * ret_lift + 1.5 * ctr_lift + 1.0 * fb_lift + 0.7 * ucb_bonus
        scored.append((tok, agg, score))

    # Classify.
    classifications: dict[str, str] = {}
    if len(scored) >= 6:
        scores = sorted(s for _, _, s in scored)
        median = scores[len(scores) // 2]
        mean_s = sum(scores) / len(scores)
        var_s = sum((s - mean_s) ** 2 for s in scores) / len(scores)
        std_s = math.sqrt(var_s) or 1.0
        win_thr = median + std_s
        cold_thr = median - std_s
        for tok, agg, score in scored:
            if score >= win_thr:
                classifications[tok] = "winner"
            elif (
                score <= cold_thr
                and agg["samples"] >= MIN_SAMPLES_FOR_COLD
            ):
                classifications[tok] = "cold"
            else:
                classifications[tok] = "exploring"
    else:
        for tok, _agg, _s in scored:
            classifications[tok] = "exploring"

    summary = {
        "tokens_tracked": len(by_token),
        "winners": sum(1 for c in classifications.values() if c == "winner"),
        "cold": sum(1 for c in classifications.values() if c == "cold"),
        "exploring": sum(1 for c in classifications.values() if c == "exploring"),
    }

    # UPSERT into title_token_stats — kind-specific delete first to
    # clear stale rows.
    async with async_session() as session:
        await session.execute(
            delete(TitleTokenStat).where(
                TitleTokenStat.channel_id == channel_id,
                TitleTokenStat.kind == kind,
            )
        )
        for tok, agg, score in scored:
            stmt = sqlite_insert(TitleTokenStat).values(
                channel_id=channel_id,
                kind=kind,
                token=tok,
                samples=agg["samples"],
                total_views_per_day=agg["vpd_sum"],
                total_ctr_weighted_sum=agg["retention_sum"],
                total_impressions=agg["retention_samples"],
                score=score,
                classification=classifications.get(tok, "exploring"),
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=["channel_id", "kind", "token"],
                set_={
                    "samples": stmt.excluded.samples,
                    "total_views_per_day": stmt.excluded.total_views_per_day,
                    "total_ctr_weighted_sum": stmt.excluded.total_ctr_weighted_sum,
                    "total_impressions": stmt.excluded.total_impressions,
                    "score": stmt.excluded.score,
                    "classification": stmt.excluded.classification,
                },
            )
            await session.execute(stmt)
        await session.commit()

    logger.info(
        "Bandit recompute channel=%d kind=%s tokens=%d "
        "winners=%d cold=%d exploring=%d",
        channel_id, kind, summary["tokens_tracked"],
        summary["winners"], summary["cold"], summary["exploring"],
    )
    return summary


async def get_pool(
    channel_id: int,
    *,
    kind: str = "title",
    must_n: int = 2,
    explore_n: int = 5,
) -> dict[str, list[str]]:
    """Return the bandit's recommendation pools for ``kind``.

    Phase 3: ``kind`` can be ``"title"``, ``"description"``, or
    ``"tag"``. Each draws from the same scoring algo but its own
    token population.

    Returns ``{must_include, banned, explore_pool}``. Empty when the
    channel has too little data — the generator falls back to its
    saved channel-voice example unaltered.
    """
    empty: dict[str, list[str]] = {
        "must_include": [], "banned": [], "explore_pool": [],
    }
    async with async_session() as session:
        rows = (await session.execute(
            select(TitleTokenStat).where(
                TitleTokenStat.channel_id == channel_id,
                TitleTokenStat.kind == kind,
            )
        )).scalars().all()
    if not rows:
        return empty
    samples_total = sum(r.samples for r in rows)
    if samples_total < MIN_VIDEOS_FOR_BANDIT:
        return empty

    winners = [r.token for r in rows if r.classification == "winner"]
    cold = [r.token for r in rows if r.classification == "cold"]
    exploring = [r.token for r in rows if r.classification == "exploring"]

    # ROTATE which winners we ask for so the same word isn't in
    # every single title forever. Random selection is fine — we
    # don't need cryptographic fairness here.
    must = random.sample(winners, k=min(must_n, len(winners))) if winners else []
    explore = (
        random.sample(exploring, k=min(explore_n, len(exploring)))
        if exploring else []
    )
    return {
        "must_include": must,
        "banned": cold,
        "explore_pool": explore,
    }


async def get_title_pool(
    channel_id: int,
    *,
    must_n: int = 2,
    explore_n: int = 5,
) -> dict[str, list[str]]:
    """Backward-compat alias — pre-Phase-3 callsites still work."""
    return await get_pool(
        channel_id, kind="title", must_n=must_n, explore_n=explore_n,
    )


async def recompute_for_all_channels(
    channel_ids: Optional[Iterable[int]] = None,
) -> list[dict]:
    """Convenience helper for the scheduler tick to recompute a batch
    of channels in one go. Returns a list of per-channel summaries.
    """
    from app.models import Channel
    out = []
    async with async_session() as session:
        if channel_ids is None:
            ch_rows = await session.execute(
                select(Channel.id).where(
                    Channel.youtube_credentials_json.isnot(None),
                )
            )
            channel_ids = [r[0] for r in ch_rows.all()]
    for cid in channel_ids:
        try:
            out.append({"channel_id": cid, **(await recompute_token_stats(cid))})
        except Exception:
            logger.exception("recompute_token_stats failed for channel %d", cid)
            out.append({"channel_id": cid, "error": True})
    return out
