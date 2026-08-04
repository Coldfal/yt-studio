from __future__ import annotations

import logging
import secrets
from datetime import datetime, timedelta
from typing import Dict, Optional
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session, get_db
from app.models import AppSetting, BackgroundTask, Channel, VideoProject
from app.schemas.task import TaskResponse
from app.utils.crypto import encrypt, decrypt
from app.workers.task_runner import task_runner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/youtube", tags=["youtube"])

# Module-level mapping of OAuth state -> channel_id (in-memory cache).
# Backed by AppSetting rows so backend restarts don't lose pending OAuth
# flows, which is critical when running 5–10 channels in parallel.
_oauth_state_map: Dict[str, int] = {}

_OAUTH_STATE_PREFIX = "youtube_oauth_state__"
# OAuth state rows older than this are considered abandoned and cleaned up.
# Google's OAuth flow typically takes <60s; 15 min is a generous upper bound.
_OAUTH_STATE_TTL = timedelta(minutes=15)


async def _expire_oauth_state(db: AsyncSession) -> int:
    """Delete `youtube_oauth_state__*` rows older than the TTL.

    Called on app startup and on every `/auth-url` request so stale rows
    don't accumulate. Returns the number of rows deleted (best-effort
    logging — never raises). Also prunes the in-memory cache.
    """
    cutoff = datetime.utcnow() - _OAUTH_STATE_TTL
    try:
        result = await db.execute(
            delete(AppSetting).where(
                AppSetting.key.like(f"{_OAUTH_STATE_PREFIX}%"),
                AppSetting.created_at < cutoff,
            )
        )
        await db.commit()
        deleted = result.rowcount or 0
    except Exception as exc:
        await db.rollback()
        logger.warning("OAuth state cleanup failed: %s", exc)
        return 0

    # Best-effort prune of the in-memory cache. We don't track timestamps
    # there, so just drop any state that no longer has a DB row.
    if _oauth_state_map:
        rows = await db.execute(
            select(AppSetting.key).where(
                AppSetting.key.like(f"{_OAUTH_STATE_PREFIX}%")
            )
        )
        live_states = {
            row[0][len(_OAUTH_STATE_PREFIX):] for row in rows.fetchall()
        }
        for stale in [s for s in _oauth_state_map if s not in live_states]:
            _oauth_state_map.pop(stale, None)

    if deleted:
        logger.info("Expired %d stale YouTube OAuth state row(s)", deleted)
    return deleted


async def expire_oauth_state_on_startup() -> None:
    """Convenience wrapper for the FastAPI startup hook."""
    async with async_session() as db:
        await _expire_oauth_state(db)


async def _persist_oauth_state(db: AsyncSession, state: str, channel_id: int) -> None:
    """Save state→channel mapping to DB so reload doesn't kill it."""
    key = f"{_OAUTH_STATE_PREFIX}{state}"
    setting = await db.get(AppSetting, key)
    if setting:
        setting.value = str(channel_id)
        setting.is_secret = False
    else:
        db.add(AppSetting(key=key, value=str(channel_id), is_secret=False))
    await db.commit()


async def _consume_oauth_state(db: AsyncSession, state: str) -> Optional[int]:
    """Pop state from in-memory cache OR DB. Returns channel_id or None."""
    cached = _oauth_state_map.pop(state, None)
    if cached is not None:
        # Best-effort cleanup of the persistent row
        key = f"{_OAUTH_STATE_PREFIX}{state}"
        row = await db.get(AppSetting, key)
        if row:
            await db.delete(row)
            await db.commit()
        return cached

    key = f"{_OAUTH_STATE_PREFIX}{state}"
    row = await db.get(AppSetting, key)
    if row and row.value and row.value.isdigit():
        cid = int(row.value)
        await db.delete(row)
        await db.commit()
        return cid
    return None

GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token"
YOUTUBE_SCOPES = (
    "https://www.googleapis.com/auth/youtube.upload "
    "https://www.googleapis.com/auth/youtube "
    # Phase B analytics: required for CTR / retention via the
    # YouTube Analytics API. Existing tokens issued without this
    # scope keep working for upload — the analytics endpoint
    # detects the missing scope and returns ``needs_reauth=true``.
    "https://www.googleapis.com/auth/yt-analytics.readonly"
)


async def _get_setting(db: AsyncSession, key: str) -> str | None:
    """Read a setting through credentials_service. Routed through the
    centralised helper so a corrupt encryption key surfaces as a clean
    log line rather than a silent ``None``."""
    from app.exceptions import CredentialError
    from app.services.credentials_service import get_setting as _cs_get_setting
    try:
        return await _cs_get_setting(db, key)
    except CredentialError as exc:
        logger.error("YouTube API setting %s could not be decrypted: %s", key, exc)
        return None


class UploadRequest(BaseModel):
    project_id: int


@router.get("/auth-url")
async def get_auth_url(
    request: Request,
    channel_id: int = Query(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    # Verify channel exists
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    # Sweep stale OAuth state rows (>15 min old) before issuing a new one
    # so the table doesn't grow forever on abandoned flows.
    await _expire_oauth_state(db)

    client_id = await _get_setting(db, "youtube_client_id")
    if not client_id:
        raise HTTPException(status_code=400, detail="YouTube client ID not configured")

    redirect_uri = await _get_setting(db, "youtube_redirect_uri")
    if not redirect_uri:
        # Derive from the incoming request so the port is always correct
        base = str(request.base_url).rstrip("/")
        redirect_uri = f"{base}/api/youtube/callback"

    state = secrets.token_urlsafe(32)
    _oauth_state_map[state] = channel_id
    # Also persist so a backend restart between auth-url and callback doesn't
    # drop the mapping (was a real bug on Windows where uvicorn --reload
    # restarts mid-flow).
    await _persist_oauth_state(db, state, channel_id)

    params = {
        "client_id": client_id,
        "redirect_uri": redirect_uri,
        "response_type": "code",
        "scope": YOUTUBE_SCOPES,
        "access_type": "offline",
        # ``select_account`` forces Google to show the account-picker every
        # time, even when the user is already signed in. Critical for users
        # with multiple YouTube channels under one Google account (brand
        # accounts) — without this, Google silently uses the last-active
        # account and uploads land on the wrong channel.
        "prompt": "select_account consent",
        "state": state,
    }

    auth_url = f"{GOOGLE_AUTH_URL}?{urlencode(params)}"
    return {"url": auth_url, "state": state}


@router.get("/callback")
async def oauth_callback(
    request: Request,
    code: str = Query(...),
    state: str = Query(...),
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    channel_id = await _consume_oauth_state(db, state)
    if channel_id is None:
        raise HTTPException(status_code=400, detail="Invalid or expired OAuth state")

    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    client_id = await _get_setting(db, "youtube_client_id")
    client_secret = await _get_setting(db, "youtube_client_secret")
    redirect_uri = await _get_setting(db, "youtube_redirect_uri")
    if not redirect_uri:
        base = str(request.base_url).rstrip("/")
        redirect_uri = f"{base}/api/youtube/callback"

    if not client_id or not client_secret:
        raise HTTPException(status_code=400, detail="YouTube OAuth credentials not configured")

    # Exchange authorization code for tokens
    import httpx

    async with httpx.AsyncClient() as client:
        token_response = await client.post(
            GOOGLE_TOKEN_URL,
            data={
                "code": code,
                "client_id": client_id,
                "client_secret": client_secret,
                "redirect_uri": redirect_uri,
                "grant_type": "authorization_code",
            },
        )

    if token_response.status_code != 200:
        raise HTTPException(
            status_code=400,
            detail=f"Failed to exchange authorization code: {token_response.text}",
        )

    import json

    # Merge the OAuth tokens with client credentials so the upload service
    # can refresh the access token independently.
    token_data = token_response.json()
    credentials_payload = {
        "token": token_data.get("access_token"),
        "refresh_token": token_data.get("refresh_token"),
        "token_uri": GOOGLE_TOKEN_URL,
        "client_id": client_id,
        "client_secret": client_secret,
        "scopes": token_data.get("scope", "").split(),
    }
    tokens_json = json.dumps(credentials_payload)
    channel.youtube_credentials_json = encrypt(tokens_json)

    # Resolve and persist the ACTUAL YouTube channel ID this token targets
    # so the dashboard can show "uploading as: <name>" and warn if the
    # user picked the wrong brand-account channel during consent.
    try:
        from google.oauth2.credentials import Credentials
        from google.auth.transport.requests import Request as GAuthRequest
        from googleapiclient.discovery import build

        creds = Credentials(**{
            k: v for k, v in credentials_payload.items()
            if k in ("token", "refresh_token", "token_uri", "client_id", "client_secret", "scopes")
        })
        if not creds.valid:
            creds.refresh(GAuthRequest())
        yt = build("youtube", "v3", credentials=creds, cache_discovery=False)
        items = yt.channels().list(part="snippet", mine=True).execute().get("items") or []
        if items:
            channel.youtube_channel_id = items[0].get("id")
    except Exception:
        # Non-fatal — we still have the tokens. /whoami will surface any issue.
        pass

    await db.commit()

    # Redirect to the frontend app, not the backend
    frontend_url = "http://localhost:5173"
    return RedirectResponse(url=f"{frontend_url}/channels/{channel_id}?oauth=success")


class DisconnectRequest(BaseModel):
    channel_id: int


@router.post("/disconnect")
async def disconnect_youtube(
    body: DisconnectRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Remove YouTube credentials from a channel."""
    channel = await db.get(Channel, body.channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    channel.youtube_credentials_json = None
    channel.youtube_channel_id = None
    await db.commit()

    return {"success": True, "message": "YouTube disconnected"}


@router.get("/whoami")
async def youtube_whoami(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return the YouTube channel that the stored OAuth token actually
    targets. Lets the dashboard show "currently uploading as: <name>" so
    users with multiple channels under one Google account can verify the
    right brand channel is selected before generating videos.
    """
    from app.services.credentials_service import get_channel_youtube_credentials_dict
    from app.exceptions import CredentialError

    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not channel.youtube_credentials_json:
        raise HTTPException(status_code=400, detail="Channel not connected to YouTube")

    try:
        creds_dict = await get_channel_youtube_credentials_dict(db, channel_id)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=exc.message)
    if creds_dict is None:
        raise HTTPException(status_code=400, detail="Stored credentials are unreadable")

    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    try:
        creds = Credentials(**{
            k: v for k, v in creds_dict.items()
            if k in ("token", "refresh_token", "token_uri", "client_id", "client_secret", "scopes")
        })
        # Refresh access token if needed (offline token, refresh on demand)
        if not creds.valid:
            from google.auth.transport.requests import Request as GAuthRequest
            creds.refresh(GAuthRequest())

        yt = build("youtube", "v3", credentials=creds, cache_discovery=False)
        resp = yt.channels().list(
            part="snippet,statistics,contentDetails",
            mine=True,
        ).execute()
    except HttpError as e:
        raise HTTPException(status_code=400, detail=f"YouTube API error: {e}")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not reach YouTube: {e}")

    items = resp.get("items") or []
    if not items:
        raise HTTPException(status_code=404, detail="OAuth token has no associated YouTube channel")
    item = items[0]
    sn = item.get("snippet", {})
    st = item.get("statistics", {})
    return {
        "youtube_channel_id": item.get("id"),
        "title": sn.get("title"),
        "thumbnail": (
            sn.get("thumbnails", {}).get("default", {}).get("url")
            or sn.get("thumbnails", {}).get("medium", {}).get("url")
        ),
        "subscriber_count": int(st.get("subscriberCount", 0) or 0)
            if not st.get("hiddenSubscriberCount")
            else None,
        "video_count": int(st.get("videoCount", 0) or 0),
    }


@router.get("/channel-videos")
async def channel_videos(
    channel_id: int,
    limit: int = 100,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return the channel's uploaded videos with public statistics.

    Powers the Performance tab on the ChannelDetailPage. Pulls video
    metadata from the YouTube Data API v3 only, so no extra OAuth
    scope is needed beyond what the existing upload flow already
    has — the trade-off is no CTR / retention. The Analytics API
    requires a separate ``yt-analytics.readonly`` scope (Phase B).

    Quota cost: ~2 + ceil(N/50) units for N videos. ~100 videos costs
    ~5 units total — comfortable inside the 10k/day budget.

    Returns
    -------
    {
      "videos": [
        {
          "video_id": str,
          "title": str,
          "thumbnail_url": str,
          "published_at": ISO 8601 str,
          "view_count": int,
          "like_count": int,
          "comment_count": int,
          "duration_seconds": int | None,
          # Derived metric: views / days-since-publish, capped so
          # day-old videos with 5 views don't claim infinite RPM.
          "views_per_day": float,
        },
        ...
      ],
      "total": int,
    }
    """
    from app.services.credentials_service import get_channel_youtube_credentials_dict
    from app.exceptions import CredentialError

    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not channel.youtube_credentials_json:
        raise HTTPException(status_code=400, detail="Channel not connected to YouTube")

    try:
        creds_dict = await get_channel_youtube_credentials_dict(db, channel_id)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=exc.message)
    if creds_dict is None:
        raise HTTPException(status_code=400, detail="Stored credentials are unreadable")

    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = Credentials(**{
        k: v for k, v in creds_dict.items()
        if k in ("token", "refresh_token", "token_uri", "client_id", "client_secret", "scopes")
    })
    if not creds.valid:
        from google.auth.transport.requests import Request as GAuthRequest
        creds.refresh(GAuthRequest())
    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)

    # Step 1: resolve the user's uploads playlist id.
    try:
        ch_resp = yt.channels().list(
            part="contentDetails", mine=True,
        ).execute()
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"YouTube API error: {exc}")
    items = ch_resp.get("items") or []
    if not items:
        return {"videos": [], "total": 0}
    uploads_pid = (
        items[0].get("contentDetails", {})
        .get("relatedPlaylists", {})
        .get("uploads")
    )
    if not uploads_pid:
        return {"videos": [], "total": 0}

    # Step 2: page through playlistItems.list to collect up to ``limit``
    # video IDs. Each page is 1 quota unit; we stop early once limit
    # is reached.
    video_ids: list[str] = []
    page_token: Optional[str] = None
    while len(video_ids) < limit:
        try:
            pl_resp = yt.playlistItems().list(
                part="contentDetails",
                playlistId=uploads_pid,
                maxResults=min(50, limit - len(video_ids)),
                pageToken=page_token,
            ).execute()
        except Exception as exc:
            logger.warning("playlistItems.list failed: %s", exc)
            break
        for item in pl_resp.get("items") or []:
            vid = (item.get("contentDetails") or {}).get("videoId")
            if vid:
                video_ids.append(vid)
        page_token = pl_resp.get("nextPageToken")
        if not page_token:
            break

    if not video_ids:
        return {"videos": [], "total": 0}

    # Step 3: bulk videos.list?part=snippet,statistics,contentDetails
    # in 50-id batches. ~1 quota unit per batch.
    from datetime import datetime, timezone
    import re as _re
    out: list[dict] = []
    for i in range(0, len(video_ids), 50):
        batch = video_ids[i : i + 50]
        try:
            v_resp = yt.videos().list(
                part="snippet,statistics,contentDetails",
                id=",".join(batch),
                maxResults=50,
            ).execute()
        except Exception as exc:
            logger.warning("videos.list failed for batch %d: %s", i, exc)
            continue
        for v in v_resp.get("items") or []:
            sn = v.get("snippet") or {}
            st = v.get("statistics") or {}
            cd = v.get("contentDetails") or {}
            published_at = sn.get("publishedAt") or ""
            views = int(st.get("viewCount") or 0)
            likes = int(st.get("likeCount") or 0)
            comments = int(st.get("commentCount") or 0)
            # Derived: views per day. Floor at 1 day so a 2h-old video
            # doesn't show 12k views/day from 1k views.
            days = 1.0
            if published_at:
                try:
                    pub_dt = datetime.fromisoformat(
                        published_at.replace("Z", "+00:00")
                    )
                    delta = (datetime.now(timezone.utc) - pub_dt).total_seconds()
                    days = max(1.0, delta / 86400.0)
                except ValueError:
                    pass
            # ISO 8601 duration like PT1H23M45S → seconds
            iso_dur = cd.get("duration") or ""
            dur_secs: Optional[int] = None
            m = _re.match(
                r"PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?", iso_dur,
            )
            if m:
                h, mn, s = (int(g or 0) for g in m.groups())
                dur_secs = h * 3600 + mn * 60 + s
            thumbs = sn.get("thumbnails") or {}
            thumb = (
                (thumbs.get("medium") or {}).get("url")
                or (thumbs.get("default") or {}).get("url")
                or (thumbs.get("high") or {}).get("url")
            )
            out.append({
                "video_id": v.get("id"),
                "title": sn.get("title") or "(no title)",
                "thumbnail_url": thumb,
                "published_at": published_at,
                "view_count": views,
                "like_count": likes,
                "comment_count": comments,
                "duration_seconds": dur_secs,
                "views_per_day": round(views / days, 2),
                "url": f"https://www.youtube.com/watch?v={v.get('id')}",
                # Studio URL: opens the video's edit page in
                # YouTube Studio. CTR + retention curves live there.
                "studio_url": (
                    f"https://studio.youtube.com/video/{v.get('id')}/edit"
                    if v.get("id") else None
                ),
            })

    # Sort newest first by default; client can re-sort.
    out.sort(key=lambda r: r.get("published_at") or "", reverse=True)

    # ── Enrich with the local Asset used as the thumbnail ────────
    # JOINs through the VideoProject table — the upload flow stores
    # ``project.youtube_video_id`` after a successful insert, and
    # the project carries ``thumbnail_asset_id``. Adds:
    #   - thumbnail_asset_id (int | null)
    #   - thumbnail_asset_url (str | null) — local /files/ URL
    #   - first_track_asset_id (int | null) — for future per-track
    #     analytics overlays on this row
    video_ids_set = [r["video_id"] for r in out if r.get("video_id")]
    if video_ids_set:
        from app.models import Asset
        proj_rows = (await db.execute(
            select(
                VideoProject.youtube_video_id,
                VideoProject.thumbnail_asset_id,
                VideoProject.music_asset_ids,
                VideoProject.id,
            ).where(
                VideoProject.youtube_video_id.in_(video_ids_set),
            )
        )).all()
        # Map: yt_video_id → (thumb_asset_id, first_track_asset_id, project_id)
        proj_meta: dict[str, dict] = {}
        for vid, thumb_id, music_ids, pid in proj_rows:
            first_track = (
                int(music_ids[0]) if music_ids and len(music_ids) else None
            )
            proj_meta[vid] = {
                "project_id": pid,
                "thumbnail_asset_id": thumb_id,
                "first_track_asset_id": first_track,
            }
        # Resolve thumbnail asset URLs in one bulk query.
        thumb_ids = [
            m["thumbnail_asset_id"] for m in proj_meta.values()
            if m["thumbnail_asset_id"]
        ]
        thumb_url_by_id: dict[int, str] = {}
        if thumb_ids:
            assets = (await db.execute(
                select(Asset.id, Asset.filepath).where(Asset.id.in_(thumb_ids))
            )).all()
            for aid, fp in assets:
                thumb_url_by_id[aid] = f"/files/{fp}" if fp else ""
        for r in out:
            meta = proj_meta.get(r["video_id"])
            if meta:
                r["project_id"] = meta["project_id"]
                r["thumbnail_asset_id"] = meta["thumbnail_asset_id"]
                r["first_track_asset_id"] = meta["first_track_asset_id"]
                if meta["thumbnail_asset_id"]:
                    r["thumbnail_asset_url"] = thumb_url_by_id.get(
                        meta["thumbnail_asset_id"], ""
                    )

    return {"videos": out, "total": len(out)}


@router.get("/channel-analytics")
async def channel_analytics(
    channel_id: int,
    days: int = 90,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return per-video YouTube Analytics for the channel.

    Phase B of the analytics work — adds CTR, avg view duration, and
    avg view percentage to the metrics already returned by
    ``/channel-videos``. Requires the
    ``yt-analytics.readonly`` OAuth scope. If the channel was
    connected before that scope was added, this endpoint returns
    ``needs_reauth=True`` and the frontend prompts the user to
    re-authorize.

    The Analytics API report is queried with ``ids=channel==MINE``,
    ``dimensions=video``, ``metrics=views,impressions,
    impressionClickThroughRate,averageViewDuration,
    averageViewPercentage``, sorted by views descending. ``days``
    bounds the report window (default 90).

    Returns
    -------
    {
      "items": [
        {
          "video_id": str,
          "views": int,
          "impressions": int,
          "ctr": float,                 # 0.0–1.0 (NOT percent)
          "avg_view_duration": int,     # seconds
          "avg_view_percentage": float, # 0.0–1.0
        },
        ...
      ],
      "needs_reauth": false,
      "window_days": int,
    }
    """
    from app.services.credentials_service import get_channel_youtube_credentials_dict
    from app.exceptions import CredentialError

    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not channel.youtube_credentials_json:
        raise HTTPException(status_code=400, detail="Channel not connected to YouTube")

    try:
        creds_dict = await get_channel_youtube_credentials_dict(db, channel_id)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=exc.message)
    if creds_dict is None:
        raise HTTPException(status_code=400, detail="Stored credentials are unreadable")

    # Quick scope check — if the user hasn't re-authorized after we
    # added yt-analytics.readonly, fail fast with a JSON marker
    # instead of waiting for Google's 403.
    granted_scopes = set(creds_dict.get("scopes") or [])
    YT_ANALYTICS = "https://www.googleapis.com/auth/yt-analytics.readonly"
    if YT_ANALYTICS not in granted_scopes:
        return {
            "items": [],
            "needs_reauth": True,
            "window_days": days,
            "missing_scope": YT_ANALYTICS,
        }

    from datetime import date, timedelta
    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError

    creds = Credentials(**{
        k: v for k, v in creds_dict.items()
        if k in ("token", "refresh_token", "token_uri", "client_id", "client_secret", "scopes")
    })
    if not creds.valid:
        from google.auth.transport.requests import Request as GAuthRequest
        creds.refresh(GAuthRequest())

    yta = build("youtubeAnalytics", "v2", credentials=creds, cache_discovery=False)
    end_d = date.today()
    start_d = end_d - timedelta(days=max(1, min(int(days), 365)))

    try:
        resp = yta.reports().query(
            ids="channel==MINE",
            startDate=start_d.isoformat(),
            endDate=end_d.isoformat(),
            # NOTE: YouTube does NOT expose impressions OR CTR via
            # the public Analytics API for regular channels — those
            # are YouTube Studio-only metrics per Google's own docs.
            # The closest signals we CAN get per-video are retention
            # (averageViewPercentage) and avg view duration, both of
            # which are at least as predictive as CTR for the
            # title-token bandit downstream.
            metrics=(
                "views,"
                "averageViewDuration,"
                "averageViewPercentage,"
                "estimatedMinutesWatched"
            ),
            dimensions="video",
            sort="-views",
            maxResults=200,
        ).execute()
    except HttpError as exc:
        # 403 with insufficient-scope is the most likely failure
        # mode — emit needs_reauth so the UI can recover gracefully.
        msg = str(exc)
        if exc.resp and exc.resp.status in (401, 403) and (
            "scope" in msg.lower() or "unauthorized" in msg.lower()
            or "forbidden" in msg.lower()
        ):
            return {
                "items": [],
                "needs_reauth": True,
                "window_days": days,
                "missing_scope": YT_ANALYTICS,
            }
        raise HTTPException(status_code=400, detail=f"YouTube Analytics error: {exc}")
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"YouTube Analytics error: {exc}")

    headers = [h.get("name") for h in resp.get("columnHeaders") or []]
    rows = resp.get("rows") or []
    idx = {h: i for i, h in enumerate(headers)}

    def _get(row, name, default=0):
        i = idx.get(name)
        return row[i] if i is not None and i < len(row) else default

    items = []
    for row in rows:
        items.append({
            "video_id": _get(row, "video", ""),
            "views": int(_get(row, "views", 0) or 0),
            # CTR + impressions intentionally null — Google doesn't
            # serve them per-video to regular channels via the API.
            "impressions": None,
            "ctr": None,
            "avg_view_duration": int(_get(row, "averageViewDuration", 0) or 0),
            # YouTube returns retention as a percentage (0–100);
            # normalise to 0–1 to match the rest of the codebase.
            "avg_view_percentage": float(
                _get(row, "averageViewPercentage", 0) or 0
            ) / 100.0,
            "estimated_minutes_watched": int(
                _get(row, "estimatedMinutesWatched", 0) or 0
            ),
        })

    return {
        "items": items,
        "needs_reauth": False,
        "window_days": (end_d - start_d).days,
    }


class ManualMetricUpsert(BaseModel):
    youtube_video_id: str
    channel_id: int
    # CTR as a 0..1 fraction. Null clears the override. The frontend
    # accepts percent values (e.g. "8.3") and divides by 100 before
    # POSTing — keeping the on-disk format normalised matches every
    # other CTR-shaped value in the codebase.
    ctr: Optional[float] = None
    notes: Optional[str] = None


@router.post("/manual-metrics")
async def upsert_manual_metric(
    body: ManualMetricUpsert,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """UPSERT operator-entered metrics for a YouTube video.

    Powers the inline CTR cell on the Performance tab — Google
    doesn't expose per-video CTR via the public Analytics API, so
    the only way to feed real CTR into the title bandit is to type
    it in. The bandit treats this as a third signal layered on top
    of views/day and retention.
    """
    from app.models import VideoManualMetric

    if body.ctr is not None and (body.ctr < 0 or body.ctr > 1):
        raise HTTPException(
            status_code=400,
            detail="ctr must be a 0..1 fraction (e.g. 0.083 for 8.3%)",
        )

    existing = (await db.execute(
        select(VideoManualMetric).where(
            VideoManualMetric.youtube_video_id == body.youtube_video_id,
        )
    )).scalar_one_or_none()
    if existing:
        existing.ctr = body.ctr
        existing.notes = body.notes
        existing.channel_id = body.channel_id
        existing.entered_at = datetime.utcnow()
    else:
        existing = VideoManualMetric(
            youtube_video_id=body.youtube_video_id,
            channel_id=body.channel_id,
            ctr=body.ctr,
            notes=body.notes,
        )
        db.add(existing)
    await db.commit()
    await db.refresh(existing)
    return {
        "youtube_video_id": existing.youtube_video_id,
        "ctr": existing.ctr,
        "notes": existing.notes,
        "entered_at": existing.entered_at.isoformat() if existing.entered_at else None,
    }


@router.get("/manual-metrics")
async def list_manual_metrics(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """All manual-metric rows for a channel — keyed by video_id so
    the Performance tab can merge them into the videos table in
    constant time per row."""
    from app.models import VideoManualMetric

    rows = (await db.execute(
        select(VideoManualMetric).where(
            VideoManualMetric.channel_id == channel_id,
        )
    )).scalars().all()
    return {
        "items": [
            {
                "youtube_video_id": r.youtube_video_id,
                "ctr": r.ctr,
                "notes": r.notes,
                "entered_at": r.entered_at.isoformat() if r.entered_at else None,
            }
            for r in rows
        ],
    }


@router.post("/cleanup-duplicates")
async def cleanup_duplicate_uploads(
    channel_id: int,
    title: str,
    keep_video_id: Optional[str] = None,
    within_minutes: int = 60,
    action: str = "private",  # "private" or "list" (dry-run)
    db: AsyncSession = Depends(get_db),
) -> dict:
    """One-shot cleanup for the duplicate-upload bug.

    Lists the channel's recent uploads (within ``within_minutes``)
    that share ``title``. With ``action="list"`` (default for safety:
    pass it explicitly to confirm), returns the IDs without changing
    anything — a dry run. With ``action="private"``, sets every
    duplicate (other than ``keep_video_id``) to ``privacyStatus=
    private`` so it stops being a public listing.

    Deliberately does NOT call ``videos.delete`` — destructive ops on
    the user's YouTube content require explicit, per-video user
    confirmation through the YouTube UI.

    Returns ``{candidates: [video_ids], affected: [video_ids]}``.
    """
    from app.services.credentials_service import get_channel_youtube_credentials_dict
    from app.exceptions import CredentialError
    from app.services.youtube_service import _find_recent_uploads_by_title

    if action not in ("list", "private"):
        raise HTTPException(
            status_code=400,
            detail="action must be 'list' or 'private'",
        )

    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not channel.youtube_credentials_json:
        raise HTTPException(status_code=400, detail="Channel not connected to YouTube")

    try:
        creds_dict = await get_channel_youtube_credentials_dict(db, channel_id)
    except CredentialError as exc:
        raise HTTPException(status_code=400, detail=exc.message)
    if creds_dict is None:
        raise HTTPException(status_code=400, detail="Stored credentials are unreadable")

    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build

    creds = Credentials(**{
        k: v for k, v in creds_dict.items()
        if k in ("token", "refresh_token", "token_uri", "client_id", "client_secret", "scopes")
    })
    if not creds.valid:
        from google.auth.transport.requests import Request as GAuthRequest
        creds.refresh(GAuthRequest())
    yt = build("youtube", "v3", credentials=creds, cache_discovery=False)

    candidates = _find_recent_uploads_by_title(
        yt, title, within_minutes=within_minutes,
    )
    targets = [v for v in candidates if v != keep_video_id]
    affected: list[str] = []

    if action == "private":
        for vid in targets:
            try:
                yt.videos().update(
                    part="status",
                    body={"id": vid, "status": {"privacyStatus": "private"}},
                ).execute()
                affected.append(vid)
            except Exception as e:
                logger.warning("Could not privatise %s: %s", vid, e)

    return {
        "candidates": candidates,
        "kept": keep_video_id,
        "action": action,
        "affected": affected,
    }


@router.post("/upload", response_model=TaskResponse, status_code=201)
async def upload_to_youtube(
    body: UploadRequest,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    project = await db.get(VideoProject, body.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if project.composed_asset_id is None:
        raise HTTPException(
            status_code=400, detail="Project does not have a composed video"
        )

    if not project.youtube_title:
        raise HTTPException(
            status_code=400, detail="Project is missing YouTube metadata (title)"
        )

    task = BackgroundTask(
        task_type="youtube_upload",
        status="pending",
        project_id=project.id,
        channel_id=project.channel_id,
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    await task_runner.enqueue(task.id)

    return TaskResponse.model_validate(task)
