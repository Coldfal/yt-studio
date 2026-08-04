"""YouTube Studio sync service — Phase 6 of farm redesign.

The public YouTube Analytics API doesn't expose per-video CTR or
impressions for regular channels — those numbers only live in YouTube
Studio. To feed real CTR into the bandit we need a scrape path.

Design choice: the backend stays headless. The actual page navigation
+ DOM scraping is done by the operator's Claude session via the
Claude in Chrome MCP. The operator (or their Claude session) submits
the harvested CTR rows to this service which UPSERTs them into
today's ``VideoAnalyticsSnapshot`` rows.

Calling pattern:
    rows = [
        {"video_id": "abc123", "impressions": 1820, "ctr_pct": 7.3},
        ...
    ]
    summary = await ingest_studio_snapshot(channel_id, rows)
"""
from __future__ import annotations

import logging
from datetime import date as _date
from typing import Any

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.database import async_session
from app.models import Channel, VideoAnalyticsSnapshot


logger = logging.getLogger(__name__)


async def ingest_studio_snapshot(
    channel_id: int,
    rows: list[dict[str, Any]],
) -> dict[str, int]:
    """Persist scraped Studio rows into today's snapshots.

    ``rows`` entries can be partial — we fill in whatever values are
    provided and leave the rest unchanged. Specifically:
      - ``impressions``: integer count of impressions in Studio's
        last-28-day window.
      - ``ctr_pct`` OR ``ctr``: CTR as a percent (8.3) OR a fraction
        (0.083). We store fraction; convert if needed.
      - ``avg_view_percentage`` (optional): retention as a fraction.
      - ``views``: optional — only used to refresh the view_count
        field on today's snapshot.

    Returns ``{updated, created, skipped}``. ``skipped`` means rows
    that had no usable signal (missing video_id or no metric values).
    """
    channel = None
    async with async_session() as session:
        channel = await session.get(Channel, channel_id)
    if not channel:
        raise ValueError(f"Channel {channel_id} not found")

    today = _date.today()
    summary = {"updated": 0, "created": 0, "skipped": 0}

    async with async_session() as session:
        for raw in rows:
            vid = (raw.get("video_id") or raw.get("youtube_video_id") or "").strip()
            if not vid:
                summary["skipped"] += 1
                continue

            # Normalise CTR to a fraction. Studio shows percent; the
            # caller may pass either ``ctr_pct`` (percent) or ``ctr``
            # (already fractional).
            ctr_value: float | None = None
            if "ctr_pct" in raw and raw["ctr_pct"] is not None:
                try:
                    ctr_value = float(raw["ctr_pct"]) / 100.0
                except (TypeError, ValueError):
                    ctr_value = None
            elif "ctr" in raw and raw["ctr"] is not None:
                try:
                    ctr_value = float(raw["ctr"])
                except (TypeError, ValueError):
                    ctr_value = None

            impressions: int | None = None
            if "impressions" in raw and raw["impressions"] is not None:
                try:
                    impressions = int(raw["impressions"])
                except (TypeError, ValueError):
                    impressions = None

            avg_view_pct: float | None = None
            if "avg_view_percentage" in raw and raw["avg_view_percentage"] is not None:
                try:
                    v = float(raw["avg_view_percentage"])
                    # accept either fraction or percent
                    avg_view_pct = v / 100.0 if v > 1.0 else v
                except (TypeError, ValueError):
                    avg_view_pct = None

            if ctr_value is None and impressions is None and avg_view_pct is None:
                summary["skipped"] += 1
                continue

            # Build the values dict — UPSERT against (video_id,
            # snapshot_date) so today's row is touched in place. The
            # row may not exist yet (e.g. the daily refresh hasn't
            # run), in which case we create a stub.
            values = {
                "channel_id": channel_id,
                "youtube_video_id": vid,
                "snapshot_date": today,
                # Required NOT NULL fields — fill with 0 when creating
                # a brand-new stub. UPSERT path only updates the
                # specific columns below, so existing rows keep their
                # view/like/comment counts.
                "view_count": int(raw.get("views") or 0),
                "like_count": 0,
                "comment_count": 0,
                "views_per_day": 0.0,
                "impressions": impressions,
                "ctr": ctr_value,
                "avg_view_percentage": avg_view_pct,
            }
            stmt = sqlite_insert(VideoAnalyticsSnapshot).values(**values)
            # On conflict (row exists for today), only update the
            # Studio-derived columns — never clobber view_count etc.
            update_set: dict[str, Any] = {}
            if impressions is not None:
                update_set["impressions"] = stmt.excluded.impressions
            if ctr_value is not None:
                update_set["ctr"] = stmt.excluded.ctr
            if avg_view_pct is not None:
                update_set["avg_view_percentage"] = stmt.excluded.avg_view_percentage
            stmt = stmt.on_conflict_do_update(
                index_elements=["youtube_video_id", "snapshot_date"],
                set_=update_set,
            )
            result = await session.execute(stmt)
            # rowcount=1 with no prior row → created; otherwise updated.
            # SQLite UPSERT reports both as 1, so we infer by querying
            # whether the row pre-existed. Cheap enough at scrape scale.
            existing_check = await session.execute(
                select(VideoAnalyticsSnapshot.id).where(
                    VideoAnalyticsSnapshot.youtube_video_id == vid,
                    VideoAnalyticsSnapshot.snapshot_date == today,
                )
            )
            if existing_check.scalar_one_or_none() is not None:
                # If we got here after the insert, the row exists. Treat
                # rowcount==1 as updated and anything else as created.
                if result.rowcount == 1:
                    summary["updated"] += 1
                else:
                    summary["created"] += 1
            else:
                summary["created"] += 1
        await session.commit()

    logger.info(
        "Studio sync channel=%d updated=%d created=%d skipped=%d",
        channel_id, summary["updated"], summary["created"], summary["skipped"],
    )
    return summary
