"""Per-track retention + view aggregator.

Walks every uploaded VideoProject for a channel, takes the latest
snapshot of its YouTube video, and attributes the views + retention
to that project's FIRST music track. Per the operator's design
call: "if a video gets good retention or watch time, we can safely
assume the first track is doing very well for that video — only the
first track should be mapped to those stats."

Why first-track-only: in a multi-track video most viewers don't
finish the whole set. The first track is what every viewer hears,
so its hooks/mood are doing the heaviest lifting on retention.
Attributing equally to all tracks would dilute the signal.

The aggregate row in ``track_performance_stats`` is intended to
power:
- The Analytics page's Top performing tracks card.
- A future track-bandit that biases ``select_tracks`` (in
  ``automation_service/_shared.py``) toward proven performers.
"""
from __future__ import annotations

import logging
import math
from collections import defaultdict
from typing import Optional

from sqlalchemy import select, delete
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.database import async_session
from app.models import (
    Asset,
    TrackPerformanceStat,
    VideoAnalyticsSnapshot,
    VideoProject,
)

logger = logging.getLogger(__name__)


async def recompute_track_stats(channel_id: int) -> dict:
    """Rebuild ``track_performance_stats`` for one channel.

    Returns a small summary the caller can log:
      ``{tracks_tracked, videos_attributed}``.
    """
    summary = {"tracks_tracked": 0, "videos_attributed": 0}

    # ── 1) Pull projects with a YouTube video for this channel ──────
    async with async_session() as session:
        projects = (await session.execute(
            select(VideoProject).where(
                VideoProject.channel_id == channel_id,
                VideoProject.youtube_video_id.isnot(None),
            )
        )).scalars().all()
        if not projects:
            await session.execute(
                delete(TrackPerformanceStat).where(
                    TrackPerformanceStat.channel_id == channel_id,
                )
            )
            await session.commit()
            return summary

        # Project → first music asset id. Prefer the m2m table
        # (VideoProjectTrack at position 0) if present, otherwise
        # fall back to the legacy JSON column.
        from app.models.video_project import VideoProjectTrack
        first_track_by_project: dict[int, int] = {}
        ordered = (await session.execute(
            select(VideoProjectTrack.project_id, VideoProjectTrack.asset_id)
            .where(
                VideoProjectTrack.project_id.in_([p.id for p in projects]),
                VideoProjectTrack.position == 0,
            )
        )).all()
        for pid, aid in ordered:
            first_track_by_project[pid] = aid
        for p in projects:
            if p.id not in first_track_by_project:
                ids = p.music_asset_ids or []
                if ids:
                    first_track_by_project[p.id] = int(ids[0])

        # ── 2) Latest snapshot per video for this channel ───────────
        snap_rows = (await session.execute(
            select(
                VideoAnalyticsSnapshot.youtube_video_id,
                VideoAnalyticsSnapshot.snapshot_date,
                VideoAnalyticsSnapshot.view_count,
                VideoAnalyticsSnapshot.views_per_day,
                VideoAnalyticsSnapshot.avg_view_percentage,
            ).where(VideoAnalyticsSnapshot.channel_id == channel_id)
        )).all()
        latest: dict[str, tuple] = {}
        for r in snap_rows:
            prev = latest.get(r[0])
            if prev is None or r[1] > prev[1]:
                latest[r[0]] = r

        # ── 3) Aggregate views + retention per first-track ──────────
        # Map yt_video_id → (project_id, first_track_id) so we know
        # which track to credit.
        video_to_track: dict[str, int] = {}
        for p in projects:
            if not p.youtube_video_id:
                continue
            track_id = first_track_by_project.get(p.id)
            if track_id is None:
                continue
            video_to_track[p.youtube_video_id] = track_id

        Aggregate = lambda: {  # noqa: E731
            "videos_used_in": 0,
            "total_views": 0,
            "total_views_per_day": 0.0,
            "total_retention_sum": 0.0,
            "total_retention_samples": 0,
        }
        by_track: dict[int, dict] = defaultdict(Aggregate)
        for vid, snap in latest.items():
            tid = video_to_track.get(vid)
            if tid is None:
                continue
            agg = by_track[tid]
            agg["videos_used_in"] += 1
            agg["total_views"] += int(snap[2] or 0)
            agg["total_views_per_day"] += float(snap[3] or 0.0)
            if snap[4] is not None:
                agg["total_retention_sum"] += float(snap[4])
                agg["total_retention_samples"] += 1
            summary["videos_attributed"] += 1

        if not by_track:
            await session.execute(
                delete(TrackPerformanceStat).where(
                    TrackPerformanceStat.channel_id == channel_id,
                )
            )
            await session.commit()
            return summary

        # ── 4) Resolve track titles + filenames in one query ────────
        track_assets = (await session.execute(
            select(Asset).where(Asset.id.in_(list(by_track.keys())))
        )).scalars().all()
        meta_by_id = {a.id: a for a in track_assets}

        # ── 5) Score each track ─────────────────────────────────────
        # Score formula mirrors the title bandit's structure but
        # over tracks:
        #   z_vpd  = (mean_vpd_track − channel_mean_vpd) / std_vpd
        #   ret_l  = (mean_ret_track / channel_mean_ret) − 1
        #   ucb    = √(2 ln N+1 / videos_used_in)
        #   score  = z_vpd + 1.5·ret_l + 0.7·ucb
        all_vpds = [
            agg["total_views_per_day"] / max(1, agg["videos_used_in"])
            for agg in by_track.values()
        ]
        if all_vpds:
            mean_vpd = sum(all_vpds) / len(all_vpds)
            var = sum((v - mean_vpd) ** 2 for v in all_vpds) / max(1, len(all_vpds))
            std_vpd = math.sqrt(var) or 1.0
        else:
            mean_vpd = 0.0
            std_vpd = 1.0
        all_ret_means = [
            agg["total_retention_sum"] / agg["total_retention_samples"]
            for agg in by_track.values()
            if agg["total_retention_samples"] > 0
        ]
        channel_mean_ret = (
            sum(all_ret_means) / len(all_ret_means) if all_ret_means else 0.0
        )
        N = max(1, sum(a["videos_used_in"] for a in by_track.values()))

        # ── 6) Clear + re-INSERT ────────────────────────────────────
        await session.execute(
            delete(TrackPerformanceStat).where(
                TrackPerformanceStat.channel_id == channel_id,
            )
        )
        for tid, agg in by_track.items():
            mean_vpd_track = agg["total_views_per_day"] / max(1, agg["videos_used_in"])
            z_vpd = (mean_vpd_track - mean_vpd) / std_vpd
            if agg["total_retention_samples"] > 0 and channel_mean_ret > 0:
                token_ret = agg["total_retention_sum"] / agg["total_retention_samples"]
                ret_lift = (token_ret / channel_mean_ret) - 1.0
            else:
                ret_lift = 0.0
            ucb = math.sqrt(2 * math.log(N + 1) / max(1, agg["videos_used_in"]))
            score = z_vpd + 1.5 * ret_lift + 0.7 * ucb
            asset = meta_by_id.get(tid)
            stmt = sqlite_insert(TrackPerformanceStat).values(
                channel_id=channel_id,
                track_asset_id=tid,
                track_title=(asset.title if asset else None),
                track_filename=(asset.filename if asset else None),
                videos_used_in=agg["videos_used_in"],
                total_views=agg["total_views"],
                total_views_per_day=agg["total_views_per_day"],
                total_retention_sum=agg["total_retention_sum"],
                total_retention_samples=agg["total_retention_samples"],
                score=score,
            )
            stmt = stmt.on_conflict_do_update(
                index_elements=["channel_id", "track_asset_id"],
                set_={
                    "track_title": stmt.excluded.track_title,
                    "track_filename": stmt.excluded.track_filename,
                    "videos_used_in": stmt.excluded.videos_used_in,
                    "total_views": stmt.excluded.total_views,
                    "total_views_per_day": stmt.excluded.total_views_per_day,
                    "total_retention_sum": stmt.excluded.total_retention_sum,
                    "total_retention_samples": stmt.excluded.total_retention_samples,
                    "score": stmt.excluded.score,
                },
            )
            await session.execute(stmt)
            summary["tracks_tracked"] += 1
        await session.commit()

    logger.info(
        "Track performance recompute channel=%d → %d tracks (%d videos attributed)",
        channel_id, summary["tracks_tracked"], summary["videos_attributed"],
    )
    return summary
