"""Aggregated analytics endpoints used by the standalone Analytics
page (cross-channel overview + recent-videos table).

Distinct from the per-channel ``/api/youtube/channel-videos`` and
``/api/youtube/channel-analytics`` endpoints which hit YouTube live
on each call. These endpoints read from the ``video_analytics_snapshots``
table that the scheduled refresh worker writes daily, so:

- Page loads are instant (one indexed SELECT, no quota burn).
- Cross-channel queries are trivial (snapshots are already homogenised).
- Trend math is possible (look back N days, compute deltas).
"""
from __future__ import annotations

import logging
from collections import defaultdict
from datetime import date, datetime, timedelta
from typing import Any, List, Optional

from fastapi import APIRouter, Depends
from sqlalchemy import func as sa_func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Channel, VideoAnalyticsSnapshot

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/overview")
async def overview(
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Per-channel summary cards for the Analytics page top strip.

    For each connected channel returns:
      - latest snapshot date
      - top performer in the last 28 days (highest views_per_day)
      - median CTR + median retention across last-28d snapshots
      - current vs previous 28-day delta on views_per_day median
    """
    cutoff_28 = date.today() - timedelta(days=28)
    cutoff_56 = date.today() - timedelta(days=56)

    ch_rows = (await db.execute(
        select(Channel.id, Channel.name).where(
            Channel.youtube_credentials_json.isnot(None),
        )
    )).all()
    if not ch_rows:
        return {"channels": []}

    channel_ids = [c[0] for c in ch_rows]
    name_by_id = {c[0]: c[1] for c in ch_rows}

    # Pull every snapshot row from the last 56 days for these
    # channels in a single query, then aggregate in Python — saves
    # multiple round-trips and SQLite handles a few thousand rows
    # without breaking a sweat.
    rows = (await db.execute(
        select(
            VideoAnalyticsSnapshot.channel_id,
            VideoAnalyticsSnapshot.youtube_video_id,
            VideoAnalyticsSnapshot.snapshot_date,
            VideoAnalyticsSnapshot.title_at_snapshot,
            VideoAnalyticsSnapshot.views_per_day,
            VideoAnalyticsSnapshot.ctr,
            VideoAnalyticsSnapshot.avg_view_percentage,
        ).where(
            VideoAnalyticsSnapshot.channel_id.in_(channel_ids),
            VideoAnalyticsSnapshot.snapshot_date >= cutoff_56,
        )
    )).all()

    # Bucket rows by channel and 28-day window.
    by_channel: dict[int, dict[str, list]] = defaultdict(lambda: {
        "current": [],   # last 28d
        "previous": [],  # the 28d before that
        "all": [],       # full 56d (for "top performer")
    })
    for r in rows:
        cid = r[0]
        snap_date = r[2]
        bucket = by_channel[cid]
        bucket["all"].append(r)
        if snap_date >= cutoff_28:
            bucket["current"].append(r)
        else:
            bucket["previous"].append(r)

    out: list[dict[str, Any]] = []
    for cid in channel_ids:
        bucket = by_channel.get(cid, {"current": [], "previous": [], "all": []})
        cur_vpd = sorted(r[4] for r in bucket["current"] if r[4] is not None)
        prev_vpd = sorted(r[4] for r in bucket["previous"] if r[4] is not None)
        cur_ctr = sorted(r[5] for r in bucket["current"] if r[5] is not None)
        cur_ret = sorted(r[6] for r in bucket["current"] if r[6] is not None)
        cur_median_vpd = _median(cur_vpd)
        prev_median_vpd = _median(prev_vpd)
        delta_vpd = (
            (cur_median_vpd - prev_median_vpd) / prev_median_vpd
            if prev_median_vpd > 0 else 0.0
        )
        # Top performer: row with the highest views_per_day in the
        # last 28d. We pick the LATEST snapshot for that video so
        # numbers reflect today, not the day it was first seen.
        top_video = None
        if bucket["current"]:
            best = max(bucket["current"], key=lambda r: r[4] or 0)
            top_video = {
                "video_id": best[1],
                "title": best[3] or "(no title)",
                "views_per_day": float(best[4] or 0),
            }
        out.append({
            "channel_id": cid,
            "channel_name": name_by_id.get(cid, ""),
            "videos_in_window": len({r[1] for r in bucket["current"]}),
            "median_views_per_day": cur_median_vpd,
            "previous_median_views_per_day": prev_median_vpd,
            "delta_views_per_day": delta_vpd,
            "median_ctr": _median(cur_ctr),
            "median_retention": _median(cur_ret),
            "top_video": top_video,
        })

    return {"channels": out, "window_days": 28}


@router.get("/recent-videos")
async def recent_videos(
    days: int = 14,
    limit: int = 50,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Cross-channel recent videos sorted by views/day.

    For each video uploaded by any connected channel within the
    window we return the LATEST snapshot row. Useful for the
    Analytics page's "what's outperforming this week" table.
    """
    cutoff = date.today() - timedelta(days=days)

    ch_map_rows = (await db.execute(
        select(Channel.id, Channel.name).where(
            Channel.youtube_credentials_json.isnot(None),
        )
    )).all()
    name_by_id = {c[0]: c[1] for c in ch_map_rows}
    channel_ids = list(name_by_id.keys())
    if not channel_ids:
        return {"items": []}

    # For each video: latest snapshot row in the window. We get this
    # by fetching all rows in window then keeping the max-id per
    # (channel, video). For the volumes we deal with (a few thousand
    # rows in a 14d window) this is fine in memory.
    rows = (await db.execute(
        select(VideoAnalyticsSnapshot).where(
            VideoAnalyticsSnapshot.channel_id.in_(channel_ids),
            VideoAnalyticsSnapshot.snapshot_date >= cutoff,
        )
    )).scalars().all()

    latest_by_vid: dict[str, VideoAnalyticsSnapshot] = {}
    for r in rows:
        prev = latest_by_vid.get(r.youtube_video_id)
        if prev is None or r.snapshot_date > prev.snapshot_date:
            latest_by_vid[r.youtube_video_id] = r

    items = sorted(
        latest_by_vid.values(),
        key=lambda r: r.views_per_day or 0,
        reverse=True,
    )[:limit]

    # Bring in operator-entered CTR overrides for these videos in
    # one shot. The Analytics page renders an inline editor in the
    # CTR column — having the value already merged in the response
    # means the cell shows "8.3%" instead of "—" without an extra
    # round-trip per channel.
    from app.models import VideoManualMetric
    vids = [r.youtube_video_id for r in items]
    manual_ctr_by_vid: dict[str, float] = {}
    if vids:
        m_rows = (await db.execute(
            select(
                VideoManualMetric.youtube_video_id,
                VideoManualMetric.ctr,
            ).where(
                VideoManualMetric.youtube_video_id.in_(vids),
            )
        )).all()
        for vid, c in m_rows:
            if c is not None:
                manual_ctr_by_vid[vid] = float(c)

    return {
        "items": [
            {
                "channel_id": r.channel_id,
                "channel_name": name_by_id.get(r.channel_id, ""),
                "youtube_video_id": r.youtube_video_id,
                "title": r.title_at_snapshot or "(no title)",
                "snapshot_date": r.snapshot_date.isoformat(),
                "view_count": r.view_count,
                "like_count": r.like_count,
                "comment_count": r.comment_count,
                "views_per_day": r.views_per_day,
                # Manual CTR wins; the API column is null for
                # regular channels anyway.
                "ctr": manual_ctr_by_vid.get(r.youtube_video_id, r.ctr),
                "avg_view_duration": r.avg_view_duration,
                "avg_view_percentage": r.avg_view_percentage,
                # Public watch URL.
                "url": f"https://www.youtube.com/watch?v={r.youtube_video_id}",
                # YouTube Studio link — when the operator clicks the
                # external-link icon they want to jump to Studio
                # (CTR, retention curve, edit metadata) not just the
                # public watch page. Studio's video URL works for any
                # video the authenticated user owns.
                "studio_url": (
                    f"https://studio.youtube.com/video/{r.youtube_video_id}/edit"
                ),
            }
            for r in items
        ],
        "window_days": days,
    }


@router.get("/top-tracks")
async def top_tracks(
    channel_id: int,
    limit: int = 25,
    db: AsyncSession = Depends(get_db),
) -> dict[str, Any]:
    """Per-track aggregate for a channel — first-track attribution.

    Reads from ``track_performance_stats`` (rebuilt nightly by the
    scheduler tick after each successful analytics refresh). Sorted
    by score descending so the table on the Analytics page leads
    with the proven performers.
    """
    from app.models import TrackPerformanceStat

    rows = (await db.execute(
        select(TrackPerformanceStat)
        .where(TrackPerformanceStat.channel_id == channel_id)
        .order_by(TrackPerformanceStat.score.desc())
        .limit(limit)
    )).scalars().all()

    return {
        "items": [
            {
                "track_asset_id": r.track_asset_id,
                "track_title": r.track_title,
                "track_filename": r.track_filename,
                "videos_used_in": r.videos_used_in,
                "total_views": r.total_views,
                "mean_views_per_day": (
                    r.total_views_per_day / r.videos_used_in
                    if r.videos_used_in else 0.0
                ),
                "mean_retention": (
                    r.total_retention_sum / r.total_retention_samples
                    if r.total_retention_samples else None
                ),
                "score": r.score,
            }
            for r in rows
        ],
    }


def _median(sorted_list: list[float]) -> float:
    if not sorted_list:
        return 0.0
    n = len(sorted_list)
    if n % 2 == 1:
        return float(sorted_list[n // 2])
    return float((sorted_list[n // 2 - 1] + sorted_list[n // 2]) / 2)


# ── Phase 3: Bandit decisions panel + recompute + feedback ─────────


from pydantic import BaseModel as _PD
from app.models import TitleTokenStat as _TitleTokenStat, MetadataFeedback as _MetadataFeedback


@router.post("/recompute-bandit/{channel_id}")
async def recompute_bandit_for_channel(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Run the bandit recompute synchronously for one channel.

    Useful right after the operator enters a manual CTR or thumbs-up
    a preview — re-runs the aggregation so the next Quick Generate
    reflects the new signal immediately, without waiting for the
    scheduler's nightly tick.
    """
    from app.services.title_bandit_service import recompute_token_stats
    summary = await recompute_token_stats(channel_id)
    return summary


@router.get("/bandit-decisions/{channel_id}")
async def bandit_decisions(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """The 'what's the bandit currently telling Claude' panel.

    Returns, for each kind, the 5 top winners + 5 cold + 5 highest-
    scored exploring tokens with their sample counts and scores so
    the operator can audit the bandit's current opinion.
    """
    out: dict[str, dict] = {}
    for kind in ("title", "description", "tag"):
        result = await db.execute(
            select(_TitleTokenStat)
            .where(
                _TitleTokenStat.channel_id == channel_id,
                _TitleTokenStat.kind == kind,
            )
            .order_by(_TitleTokenStat.score.desc())
        )
        rows = list(result.scalars().all())
        winners = sorted(
            [r for r in rows if r.classification == "winner"],
            key=lambda r: -r.score,
        )[:5]
        cold = sorted(
            [r for r in rows if r.classification == "cold"],
            key=lambda r: r.score,
        )[:5]
        exploring = sorted(
            [r for r in rows if r.classification == "exploring"],
            key=lambda r: -r.score,
        )[:5]
        out[kind] = {
            "total_tokens": len(rows),
            "winners": [
                {"token": r.token, "samples": r.samples, "score": round(r.score, 3)}
                for r in winners
            ],
            "cold": [
                {"token": r.token, "samples": r.samples, "score": round(r.score, 3)}
                for r in cold
            ],
            "exploring": [
                {"token": r.token, "samples": r.samples, "score": round(r.score, 3)}
                for r in exploring
            ],
        }
    return out


class _FeedbackRequest(_PD):
    channel_id: int
    project_id: Optional[int] = None
    generated_title: Optional[str] = None
    generated_description: Optional[str] = None
    generated_tags: Optional[list] = None
    operator_rating: int  # -1, 0, or +1
    notes: Optional[str] = None


@router.post("/metadata-feedback")
async def submit_metadata_feedback(
    body: _FeedbackRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Operator thumbs up/down on a previewed metadata package.

    Append-only. The bandit recompute walks these rows alongside real
    snapshot data — see ``_recompute_one_kind`` for the weighting.
    """
    if body.operator_rating not in (-1, 0, 1):
        raise HTTPException(
            status_code=400,
            detail="operator_rating must be -1, 0, or +1",
        )
    fb = _MetadataFeedback(
        channel_id=body.channel_id,
        project_id=body.project_id,
        generated_title=body.generated_title,
        generated_description=body.generated_description,
        generated_tags=body.generated_tags,
        operator_rating=body.operator_rating,
        notes=body.notes,
    )
    db.add(fb)
    await db.commit()
    await db.refresh(fb)
    return {"id": fb.id, "created_at": fb.created_at.isoformat()}


# ── Phase 6: YouTube Studio sync ───────────────────────────────────


class StudioSyncRow(_PD):
    video_id: str
    impressions: Optional[int] = None
    ctr_pct: Optional[float] = None       # 8.3 (percent)
    ctr: Optional[float] = None           # 0.083 (fraction) - alternative
    avg_view_percentage: Optional[float] = None
    views: Optional[int] = None


class StudioSyncRequest(_PD):
    rows: List[StudioSyncRow]


# Resolve the forward-ref so FastAPI/Pydantic can build the type
# adapter despite `from __future__ import annotations` at the top.
StudioSyncRequest.model_rebuild()


@router.post("/studio-sync/{channel_id}")
async def studio_sync(
    channel_id: int,
    body: StudioSyncRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Ingest scraped YouTube Studio rows into today's snapshots.

    Phase 6 of farm redesign. The operator (or their Claude session
    with the Claude in Chrome MCP) scrapes
    studio.youtube.com/channel/.../analytics and POSTs the harvested
    {video_id, impressions, ctr_pct} rows here. We UPSERT into the
    existing snapshot rows for today so the bandit's next recompute
    picks up the new CTR signal.

    Auto-recomputes the bandit after ingestion so the
    /bandit-decisions endpoint reflects the new signal immediately.
    """
    from app.services.youtube_studio_scraper_service import (
        ingest_studio_snapshot,
    )
    rows = [r.model_dump() for r in body.rows]
    try:
        summary = await ingest_studio_snapshot(channel_id, rows)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))

    # Re-run the bandit so the new CTR signal lands in the next pick.
    try:
        from app.services.title_bandit_service import recompute_token_stats
        await recompute_token_stats(channel_id)
    except Exception as exc:
        logger.warning(
            "Studio-sync recompute_token_stats failed (non-fatal): %s",
            exc,
        )

    return summary
