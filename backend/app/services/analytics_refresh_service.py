"""Daily analytics refresh worker.

Pulls the public stats and (when scope + Cloud-API permit) the
YouTube Analytics CTR/retention numbers for a channel's videos, and
UPSERTs them into ``video_analytics_snapshots``. One row per (video,
day). Idempotent on the unique (youtube_video_id, snapshot_date)
constraint — re-runs same day overwrite, not duplicate.

Designed to be called from:
- ``automation_scheduler.py``'s tick (production: once per channel
  per ~24h)
- A future ``POST /api/analytics/refresh/{channel_id}`` endpoint
  (operator's "refresh now" button on the analytics page)

Failure modes
-------------
- **Token revoked / refresh fails**: caught, logged, run marked
  ``failed`` with the error string. Scheduler keeps trying daily.
- **YouTube Analytics API not enabled / scope missing**: public stats
  still get written, run completes with ``analytics_skipped=True``.
  The UI can nudge the operator to enable / re-auth.
- **Rate limit (HTTP 403 quotaExceeded)**: caught, run marked
  failed; the next tick (next day) tries again.

Quota cost per channel (200 videos, default cap):
- channels.list: 1 unit
- playlistItems.list: ~4 units (50 per page × 4 pages = 200)
- videos.list?part=snippet,statistics,contentDetails: ~4 units
- youtubeAnalytics.reports().query: 1 unit
- Total: ~10 units. Daily across 10 channels = 100 units. Well under
  the 10000/day default budget.
"""
from __future__ import annotations

import logging
import re
from datetime import date, datetime, timedelta, timezone
from typing import Optional

from sqlalchemy import select
from sqlalchemy.dialects.sqlite import insert as sqlite_insert

from app.database import async_session
from app.models import (
    AnalyticsRunLog,
    Channel,
    VideoAnalyticsSnapshot,
)

logger = logging.getLogger(__name__)

_YT_ANALYTICS_SCOPE = "https://www.googleapis.com/auth/yt-analytics.readonly"
_ISO_DUR = re.compile(r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?")


def _parse_iso_duration(iso: str) -> Optional[int]:
    if not iso:
        return None
    m = _ISO_DUR.match(iso)
    if not m:
        return None
    h, mn, s = (int(g or 0) for g in m.groups())
    return h * 3600 + mn * 60 + s


async def refresh_channel_analytics(
    channel_id: int,
    *,
    days_window: int = 90,
    video_limit: int = 200,
) -> dict:
    """Run a full refresh for one channel. Returns a small summary
    dict the caller can log or surface.

    The ``AnalyticsRunLog`` row is written by this function — the
    caller doesn't need to track state. Always returns; never raises
    (unless something truly catastrophic happens that means we can't
    even reach the DB).
    """
    started_at = datetime.utcnow()
    log_id: Optional[int] = None
    videos_processed = 0
    analytics_skipped = False
    fail_msg: Optional[str] = None

    # Open a "running" log row up front so the dashboard can see the
    # in-flight state (and so a crash mid-run doesn't leave us
    # silent — there's always a row that says "started_at, no
    # completed_at yet").
    async with async_session() as session:
        log = AnalyticsRunLog(
            channel_id=channel_id, status="running", started_at=started_at,
        )
        session.add(log)
        await session.flush()
        log_id = log.id
        await session.commit()

    try:
        async with async_session() as session:
            channel = await session.get(Channel, channel_id)
            if not channel:
                raise ValueError(f"Channel {channel_id} not found")
            if not channel.youtube_credentials_json:
                raise ValueError("Channel not connected to YouTube")

        # Resolve credentials. Imports inside the function so this
        # module stays cheap to import on every backend boot.
        from app.services.credentials_service import (
            get_channel_youtube_credentials_dict,
        )
        from app.exceptions import CredentialError
        try:
            async with async_session() as session:
                creds_dict = await get_channel_youtube_credentials_dict(
                    session, channel_id,
                )
        except CredentialError as exc:
            raise ValueError(f"Credentials decrypt failed: {exc}")
        if creds_dict is None:
            raise ValueError("Stored credentials are unreadable")

        from google.oauth2.credentials import Credentials
        from googleapiclient.discovery import build
        from googleapiclient.errors import HttpError
        from google.auth.transport.requests import Request as GAuthRequest

        creds = Credentials(**{
            k: v for k, v in creds_dict.items()
            if k in (
                "token", "refresh_token", "token_uri",
                "client_id", "client_secret", "scopes",
            )
        })
        if not creds.valid:
            creds.refresh(GAuthRequest())

        granted_scopes = set(creds_dict.get("scopes") or [])
        has_analytics = _YT_ANALYTICS_SCOPE in granted_scopes

        yt = build("youtube", "v3", credentials=creds, cache_discovery=False)

        # ── 1) uploads playlist ──────────────────────────────────────
        ch_resp = yt.channels().list(part="contentDetails", mine=True).execute()
        ch_items = ch_resp.get("items") or []
        if not ch_items:
            raise ValueError("OAuth token has no associated YouTube channel")
        uploads_pid = (
            ch_items[0].get("contentDetails", {})
            .get("relatedPlaylists", {})
            .get("uploads")
        )
        if not uploads_pid:
            raise ValueError("Channel has no uploads playlist")

        # ── 2) collect video ids (pages of 50, capped) ───────────────
        video_ids: list[str] = []
        page_token: Optional[str] = None
        while len(video_ids) < video_limit:
            pl_resp = yt.playlistItems().list(
                part="contentDetails",
                playlistId=uploads_pid,
                maxResults=min(50, video_limit - len(video_ids)),
                pageToken=page_token,
            ).execute()
            for item in pl_resp.get("items") or []:
                vid = (item.get("contentDetails") or {}).get("videoId")
                if vid:
                    video_ids.append(vid)
            page_token = pl_resp.get("nextPageToken")
            if not page_token:
                break

        # ── 3) fetch public stats in 50-id batches ───────────────────
        public_rows: dict[str, dict] = {}
        for i in range(0, len(video_ids), 50):
            batch = video_ids[i : i + 50]
            v_resp = yt.videos().list(
                part="snippet,statistics,contentDetails",
                id=",".join(batch),
                maxResults=50,
            ).execute()
            for v in v_resp.get("items") or []:
                sn = v.get("snippet") or {}
                st = v.get("statistics") or {}
                cd = v.get("contentDetails") or {}
                published_at = sn.get("publishedAt") or ""
                # Compute views/day with a 1-day floor so freshly-
                # uploaded videos don't get astronomical numbers.
                days = 1.0
                if published_at:
                    try:
                        pub_dt = datetime.fromisoformat(
                            published_at.replace("Z", "+00:00"),
                        )
                        delta = (
                            datetime.now(timezone.utc) - pub_dt
                        ).total_seconds()
                        days = max(1.0, delta / 86400.0)
                    except ValueError:
                        pass
                views = int(st.get("viewCount") or 0)
                public_rows[v.get("id") or ""] = {
                    "title": sn.get("title") or "",
                    # Phase 3: cache description + tags so the
                    # description/tag bandits can tokenise them later.
                    # Tags from the YT API arrive as a list of strings.
                    "description": sn.get("description") or "",
                    "tags": list(sn.get("tags") or []),
                    "view_count": views,
                    "like_count": int(st.get("likeCount") or 0),
                    "comment_count": int(st.get("commentCount") or 0),
                    "duration_seconds": _parse_iso_duration(
                        cd.get("duration") or ""
                    ),
                    "views_per_day": round(views / days, 4),
                    "published_at": published_at,
                }

        # ── 4) Analytics API (CTR, retention) ────────────────────────
        analytics_rows: dict[str, dict] = {}
        if has_analytics:
            try:
                yta = build(
                    "youtubeAnalytics", "v2",
                    credentials=creds, cache_discovery=False,
                )
                end_d = date.today()
                start_d = end_d - timedelta(days=max(1, min(days_window, 365)))
                # YouTube's Analytics API does NOT expose
                # impressions or CTR per-video for regular channels
                # (per Google's own metric reference) — those numbers
                # only show in YouTube Studio. We use retention
                # (averageViewPercentage) instead, which is just as
                # strong a signal for whether a title/thumbnail
                # combo is working.
                a_resp = yta.reports().query(
                    ids="channel==MINE",
                    startDate=start_d.isoformat(),
                    endDate=end_d.isoformat(),
                    metrics=(
                        "views,averageViewDuration,"
                        "averageViewPercentage,estimatedMinutesWatched"
                    ),
                    dimensions="video",
                    sort="-views",
                    maxResults=200,
                ).execute()
                headers = [h.get("name") for h in a_resp.get("columnHeaders") or []]
                idx = {h: i for i, h in enumerate(headers)}

                def _g(row, name, default=0):
                    i = idx.get(name)
                    return row[i] if i is not None and i < len(row) else default

                for row in a_resp.get("rows") or []:
                    vid = _g(row, "video", "")
                    if not vid:
                        continue
                    # CTR + impressions stay null in the snapshot —
                    # they're not available via the API. The bandit
                    # uses retention as the secondary signal instead.
                    analytics_rows[vid] = {
                        "impressions": None,
                        "ctr": None,
                        "avg_view_duration": int(
                            _g(row, "averageViewDuration", 0) or 0
                        ),
                        "avg_view_percentage": float(
                            _g(row, "averageViewPercentage", 0) or 0
                        ) / 100.0,
                    }
            except HttpError as exc:
                # API not enabled / scope insufficient = soft fail.
                # Public stats still got written; log and keep going.
                analytics_skipped = True
                logger.warning(
                    "Analytics API failed for channel %d (skipping): %s",
                    channel_id, exc,
                )
            except Exception as exc:
                analytics_skipped = True
                logger.warning(
                    "Analytics API error for channel %d (skipping): %s",
                    channel_id, exc,
                )
        else:
            analytics_skipped = True

        # ── 5) UPSERT one snapshot per video for today ───────────────
        today = date.today()
        async with async_session() as session:
            for vid, pub in public_rows.items():
                an = analytics_rows.get(vid) or {}
                values = {
                    "channel_id": channel_id,
                    "youtube_video_id": vid,
                    "snapshot_date": today,
                    "view_count": pub["view_count"],
                    "like_count": pub["like_count"],
                    "comment_count": pub["comment_count"],
                    "views_per_day": pub["views_per_day"],
                    "title_at_snapshot": pub["title"],
                    "description_at_snapshot": pub.get("description") or None,
                    "tags_at_snapshot": pub.get("tags") or None,
                    "impressions": an.get("impressions"),
                    "ctr": an.get("ctr"),
                    "avg_view_duration": an.get("avg_view_duration"),
                    "avg_view_percentage": an.get("avg_view_percentage"),
                }
                # SQLite UPSERT — INSERT ... ON CONFLICT (video,
                # snapshot_date) DO UPDATE SET ... — keeps the daily
                # snapshot idempotent if the worker fires twice.
                stmt = sqlite_insert(VideoAnalyticsSnapshot).values(**values)
                stmt = stmt.on_conflict_do_update(
                    index_elements=["youtube_video_id", "snapshot_date"],
                    set_={k: v for k, v in values.items()
                          if k not in ("channel_id", "youtube_video_id",
                                       "snapshot_date")},
                )
                await session.execute(stmt)
                videos_processed += 1
            await session.commit()
    except Exception as exc:
        fail_msg = str(exc)
        logger.exception(
            "Analytics refresh failed for channel %d", channel_id,
        )

    # ── Finalise the audit row ───────────────────────────────────────
    async with async_session() as session:
        if log_id is not None:
            log = await session.get(AnalyticsRunLog, log_id)
            if log:
                log.completed_at = datetime.utcnow()
                log.videos_processed = videos_processed
                log.analytics_skipped = 1 if analytics_skipped else 0
                if fail_msg:
                    log.status = "failed"
                    log.error = fail_msg[:1000]
                else:
                    log.status = "completed"
                await session.commit()

    return {
        "channel_id": channel_id,
        "videos_processed": videos_processed,
        "analytics_skipped": analytics_skipped,
        "status": "failed" if fail_msg else "completed",
        "error": fail_msg,
    }
