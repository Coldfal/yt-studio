from __future__ import annotations

import asyncio
import json
import logging
import secrets
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

import httpx
from google.oauth2.credentials import Credentials
from google_auth_oauthlib.flow import Flow
from googleapiclient.discovery import build
from googleapiclient.http import MediaFileUpload

from app.database import async_session
from app.exceptions import CredentialError
from app.services.credentials_service import get_setting

logger = logging.getLogger(__name__)


def _truncate_utf16(s: str, max_units: int = 100) -> str:
    """Truncate ``s`` to at most ``max_units`` UTF-16 code units. If
    truncation occurs, an ellipsis (U+2026, one code unit) is appended
    within the cap — the result is GUARANTEED to fit.

    Fixes the operator-reported invalidVideoMetadata bug 2026-05-17:
    the previous truncation logic cut to exactly ``max_units`` and then
    appended ``…``, producing ``max_units + 1`` units, which YouTube's
    videos.update / videos.insert rejects with the generic
    ``invalidVideoMetadata`` error. The Spanish localised title for
    project 164 was 101 units, tripping this exact case.

    YouTube counts in UTF-16 code units (not Python codepoints) — so
    BMP chars (Korean, Japanese, Chinese, ASCII) cost 1 unit and
    supplementary-plane chars (most emoji, math-bold/script Unicode)
    cost 2. We encode to UTF-16-LE, slice on byte boundaries, and
    decode with errors='ignore' to drop any trailing half-codepoint
    cleanly.
    """
    utf16 = s.encode("utf-16-le")
    if len(utf16) // 2 <= max_units:
        return s
    # Reserve exactly 1 unit for the ellipsis. Decode ignoring any
    # half-codepoint at the slice boundary, strip trailing whitespace
    # AND any pre-existing trailing ellipsis (avoids '……'), then
    # append a single ellipsis.
    head = utf16[: (max_units - 1) * 2].decode("utf-16-le", errors="ignore").rstrip()
    while head.endswith("…"):
        head = head[:-1].rstrip()
    candidate = head + "…"
    # Belt-and-braces: rstrip on a multi-unit trailing char could
    # leave the candidate slightly over. Drop the ellipsis if so —
    # never return over-cap.
    if len(candidate.encode("utf-16-le")) // 2 > max_units:
        return head
    return candidate

_SCOPES = [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube",
    # Phase B of the analytics work: CTR, retention, traffic sources,
    # average-view-duration. Existing tokens issued before this scope
    # was added will still work for upload and channel listing — they
    # just 403 on the YouTube Analytics API. The frontend Performance
    # tab detects that case and shows a "Re-authorize" prompt.
    "https://www.googleapis.com/auth/yt-analytics.readonly",
]

# Module-level mapping: OAuth state token -> channel_id
_pending_auth: Dict[str, int] = {}


async def _get_setting(key: str) -> Optional[str]:
    """Read a setting through credentials_service. See openai_service for
    the rationale — was a local helper that hid decrypt failures."""
    async with async_session() as session:
        try:
            return await get_setting(session, key)
        except CredentialError as exc:
            logger.error("YouTube setting %s could not be decrypted: %s", key, exc)
            return None


def _find_recent_uploads_by_title(
    youtube,
    title: str,
    *,
    within_minutes: int = 60,
    page_size: int = 25,
) -> list[str]:
    """Return YouTube video IDs from the authenticated channel's
    uploads playlist whose snippet title matches ``title`` exactly,
    published within the last ``within_minutes``.

    Used by ``upload_video`` to detect duplicates that the resumable-
    upload retry path occasionally creates during long stalls. Cheap
    in quota terms: one ``channels.list`` (1 unit) + one
    ``playlistItems.list`` (1 unit, 25 rows is more than enough since
    we only care about the LAST hour). Returns the IDs ordered by
    ``publishedAt`` descending — newest first — so callers that want
    "the canonical one" can pick index 0.
    """
    from datetime import datetime, timedelta, timezone
    if not title:
        return []
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=within_minutes)

    # Resolve the user's "uploads" playlist ID (every YouTube channel
    # has one automatically; that's where every uploaded video lives).
    try:
        ch_resp = youtube.channels().list(
            part="contentDetails", mine=True,
        ).execute()
    except Exception as exc:
        logger.debug("channels.list mine=True failed: %s", exc)
        return []
    items = ch_resp.get("items") or []
    if not items:
        return []
    uploads_pid = (
        items[0].get("contentDetails", {})
        .get("relatedPlaylists", {})
        .get("uploads")
    )
    if not uploads_pid:
        return []

    try:
        pl_resp = youtube.playlistItems().list(
            part="snippet,contentDetails",
            playlistId=uploads_pid,
            maxResults=page_size,
        ).execute()
    except Exception as exc:
        logger.debug("playlistItems.list failed: %s", exc)
        return []

    matches: list[tuple[datetime, str]] = []
    for it in pl_resp.get("items") or []:
        snippet = it.get("snippet") or {}
        if (snippet.get("title") or "").strip() != (title or "").strip():
            continue
        published = (
            it.get("contentDetails", {}).get("videoPublishedAt")
            or snippet.get("publishedAt")
        )
        if not published:
            continue
        try:
            # YouTube returns RFC 3339 like "2026-05-08T10:55:00Z".
            ts = datetime.fromisoformat(published.replace("Z", "+00:00"))
        except ValueError:
            continue
        if ts < cutoff:
            continue
        vid = (snippet.get("resourceId") or {}).get("videoId")
        if vid:
            matches.append((ts, vid))
    matches.sort(reverse=True)  # newest first
    return [vid for _, vid in matches]


class YouTubeServiceError(Exception):
    """Raised when a YouTube API operation fails."""


class YouTubeService:
    """YouTube Data API v3 -- OAuth + Upload."""

    # ------------------------------------------------------------------
    # OAuth helpers
    # ------------------------------------------------------------------

    async def build_auth_url(
        self,
        channel_id: int,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
    ) -> tuple[str, str]:
        """Build a Google OAuth authorisation URL.

        Returns
        -------
        tuple[str, str]
            ``(auth_url, state)``
        """
        state = secrets.token_urlsafe(32)
        _pending_auth[state] = channel_id

        client_config = {
            "installed": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/v2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [redirect_uri],
            }
        }

        def _build() -> str:
            flow = Flow.from_client_config(
                client_config,
                scopes=_SCOPES,
                redirect_uri=redirect_uri,
            )
            auth_url, _ = flow.authorization_url(
                access_type="offline",
                prompt="consent",
                state=state,
            )
            return auth_url

        loop = asyncio.get_event_loop()
        auth_url = await loop.run_in_executor(None, _build)

        logger.info(
            "Built OAuth URL for channel %d (state=%s…)", channel_id, state[:8]
        )
        return auth_url, state

    async def handle_callback(
        self,
        code: str,
        state: str,
        client_id: str,
        client_secret: str,
        redirect_uri: str,
    ) -> dict:
        """Exchange an authorisation code for OAuth tokens.

        Returns
        -------
        dict
            Token / credential payload suitable for storage.
        """
        channel_id = _pending_auth.pop(state, None)
        if channel_id is None:
            raise YouTubeServiceError(
                "Invalid or expired OAuth state. Please start the auth flow again."
            )

        client_config = {
            "installed": {
                "client_id": client_id,
                "client_secret": client_secret,
                "auth_uri": "https://accounts.google.com/o/oauth2/v2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": [redirect_uri],
            }
        }

        def _exchange() -> dict:
            flow = Flow.from_client_config(
                client_config,
                scopes=_SCOPES,
                redirect_uri=redirect_uri,
            )
            flow.fetch_token(code=code)
            creds = flow.credentials
            return {
                "token": creds.token,
                "refresh_token": creds.refresh_token,
                "token_uri": creds.token_uri,
                "client_id": creds.client_id,
                "client_secret": creds.client_secret,
                "scopes": list(creds.scopes or []),
                "channel_id": channel_id,
            }

        loop = asyncio.get_event_loop()
        try:
            credentials_dict = await loop.run_in_executor(None, _exchange)
        except Exception as exc:
            raise YouTubeServiceError(
                f"Failed to exchange authorisation code: {exc}"
            ) from exc

        logger.info("OAuth tokens obtained for channel %d", channel_id)
        return credentials_dict

    # ------------------------------------------------------------------
    # Upload
    # ------------------------------------------------------------------

    async def upload_video(
        self,
        credentials_json: str,
        filepath: str,
        title: str,
        description: str,
        tags: Optional[List[str]] = None,
        category_id: str = "10",
        privacy: str = "private",
        scheduled_at: Optional[datetime] = None,
        thumbnail_path: Optional[str] = None,
        made_for_kids: bool = False,
        on_progress: Optional[Callable[[float], Any]] = None,
        localizations: Optional[Dict[str, Dict[str, str]]] = None,
        default_language: str = "en",
        channel_id: Optional[int] = None,
    ) -> dict:
        """Upload a video to YouTube.

        Parameters
        ----------
        credentials_json
            JSON string containing OAuth2 credentials (token, refresh_token, etc.).
        filepath
            Local path to the video file.
        title, description, tags, category_id, privacy
            Standard YouTube video metadata.
        scheduled_at
            If provided, the video is set to private and ``publishAt`` is
            set so YouTube publishes it automatically.
        thumbnail_path
            Optional local path to a custom thumbnail image.
        on_progress
            Called with a float 0.0-1.0 during the resumable upload.

        Returns
        -------
        dict
            ``{"video_id": str, "url": str}``
        """
        # Rate-limit: youtube_upload bucket is intentionally tight
        # (1/min, capacity 2). Stops a retry storm from burning the
        # daily quota in 30 seconds. Per-channel keying so one
        # channel's flurry doesn't starve another.
        from app.services.rate_limiter import rate_limiter
        await rate_limiter.acquire(
            provider="youtube_upload", channel_id=channel_id,
        )

        creds_data = self._parse_credentials(credentials_json)
        credentials = Credentials(
            token=creds_data.get("token"),
            refresh_token=creds_data.get("refresh_token"),
            token_uri=creds_data.get("token_uri", "https://oauth2.googleapis.com/token"),
            client_id=creds_data.get("client_id"),
            client_secret=creds_data.get("client_secret"),
            scopes=creds_data.get("scopes", _SCOPES),
        )

        # ── Sanitize per YouTube's strict limits ────────────────────────
        # Hard limits per the API docs (https://developers.google.com/youtube/v3/docs/videos):
        #   - title: 100 chars (UTF-16 code units)
        #   - description: 5000 chars
        #   - tags: combined length ≤500 chars (commas count); per-tag ~30
        #   - title/description forbid '<' and '>' characters
        # Without this, uploads with our house-style title (which can run
        # 100-120 chars) silently fail-over to "completed" status without a
        # video being created — confusing the user.
        clean_title = (title or "").replace("<", "").replace(">", "")
        # YouTube counts in UTF-16 code units, not Python codepoints — so
        # surrogate-pair characters (some emoji, mathematical bold) count
        # as 2. Operator bug 2026-05-17: the previous algorithm
        # truncated to 100 units THEN appended an ellipsis = 101 units,
        # which YouTube rejects with the generic invalidVideoMetadata
        # error. Use the shared helper that reserves 1 unit for the
        # ellipsis inside the cap.
        before_units = len(clean_title.encode("utf-16-le")) // 2
        clean_title = _truncate_utf16(clean_title, max_units=100)
        after_units = len(clean_title.encode("utf-16-le")) // 2
        if after_units < before_units:
            logger.warning(
                "Truncated title from %d to %d UTF-16 code units",
                before_units, after_units,
            )

        clean_desc = (description or "").replace("<", "").replace(">", "")
        if len(clean_desc) > 5000:
            clean_desc = clean_desc[:4997] + "..."

        # Tags: filter empty/oversize, scrub forbidden chars, dedupe, then
        # trim until the joined length fits YouTube's ~500-char budget.
        #
        # YouTube's "invalidTags" 400 fires on a few patterns we keep
        # tripping into:
        #   - quotes (``"`` or ``'``) anywhere in a tag — YouTube parses
        #     the tag list as a comma-separated string and quotes break it
        #   - control chars / NULs from upstream Claude noise
        #   - tags that are pure punctuation or whitespace after stripping
        #   - HTML angle brackets (already filtered for title/desc, do tags
        #     too for symmetry)
        # Per-tag length cap is 30 (YouTube's documented practical limit;
        # longer tags occasionally land but inconsistently — being safe).
        import re as _re
        clean_tags: list[str] = []
        seen: set[str] = set()
        running_len = 0
        # Strip ANY of these chars wherever they appear:
        # < > " '   — quotes / brackets that break YouTube's parser
        # control chars (0x00-0x1f, 0x7f) — NULs, BOMs, etc.
        FORBIDDEN = _re.compile(r"[<>\"'\x00-\x1f\x7f]")
        for raw in (tags or []):
            t = str(raw)
            t = FORBIDDEN.sub("", t)
            t = t.strip().lstrip("#").strip()
            # Collapse internal whitespace runs to a single space — some
            # Claude outputs have non-breaking spaces or tabs that read
            # weird in YouTube's UI.
            t = _re.sub(r"\s+", " ", t)
            if not t:
                continue
            # Reject pure-punctuation / single-char tags — YouTube treats
            # those as invalid keywords.
            if len(t) < 2 or not _re.search(r"[\w぀-ヿ一-鿿가-힯]", t):
                continue
            # Per-tag length cap (UTF-16 code units to match YouTube's count).
            t_utf16_units = len(t.encode("utf-16-le")) // 2
            if t_utf16_units > 30:
                continue
            key = t.lower()
            if key in seen:
                continue
            seen.add(key)
            # +3 for surrounding quotes + comma in the joined header
            # (YouTube auto-quotes tags with spaces).
            extra = t_utf16_units + 3
            if running_len + extra > 450:
                break
            clean_tags.append(t)
            running_len += extra
        if (tags or []) and not clean_tags:
            logger.warning(
                "All %d tags were filtered out as invalid — uploading without tags",
                len(tags or []),
            )

        # Build the request body
        status: Dict[str, Any] = {
            "privacyStatus": privacy,
            "selfDeclaredMadeForKids": made_for_kids,
        }
        if scheduled_at is not None:
            status["privacyStatus"] = "private"
            status["publishAt"] = scheduled_at.strftime("%Y-%m-%dT%H:%M:%S.000Z")

        snippet: Dict[str, Any] = {
            "title": clean_title,
            "description": clean_desc,
            "tags": clean_tags,
            "categoryId": category_id,
        }
        # Setting defaultLanguage on the snippet is what tells YouTube the
        # `localizations` map applies to this video — without it the API
        # accepts the localizations silently but never serves them. We
        # only set it when we actually have translations to ship.
        clean_localizations = self._clean_localizations(localizations)
        if clean_localizations:
            snippet["defaultLanguage"] = default_language

        body: Dict[str, Any] = {
            "snippet": snippet,
            "status": status,
        }
        if clean_localizations:
            body["localizations"] = clean_localizations

        upload_part = "snippet,status"
        if clean_localizations:
            upload_part = "snippet,status,localizations"

        def _do_upload() -> dict:
            youtube = build("youtube", "v3", credentials=credentials)

            # ── Pre-upload idempotency check ─────────────────────────
            # YouTube's resumable-upload protocol can produce duplicate
            # videos on the channel when the network drops and the
            # apiclient restarts a resumable session instead of
            # resuming. Before kicking off a fresh upload, look for a
            # recent video by this channel with the same title. If we
            # find one < 1 h old we treat it as "already done" and
            # return its id, avoiding a duplicate upload entirely.
            # Cheap (<5 quota units): one channels.list + one
            # playlistItems.list.
            existing = _find_recent_uploads_by_title(
                youtube, clean_title, within_minutes=60,
            )
            if existing:
                video_id = existing[0]
                logger.warning(
                    "Skipping upload: a video with the same title was "
                    "already uploaded by this channel in the last hour "
                    "(id=%s). This usually means a previous upload of the "
                    "same project succeeded mid-retry. Reusing that id.",
                    video_id,
                )
                return {
                    "video_id": video_id,
                    "url": f"https://www.youtube.com/watch?v={video_id}",
                }

            media = MediaFileUpload(
                filepath,
                resumable=True,
                chunksize=10 * 1024 * 1024,  # 10 MB chunks
            )

            request = youtube.videos().insert(
                part=upload_part,
                body=body,
                media_body=media,
            )

            response = None
            while response is None:
                status_obj, response = request.next_chunk()
                if status_obj is not None and on_progress is not None:
                    fraction = status_obj.progress()
                    try:
                        on_progress(fraction)
                    except Exception:
                        logger.debug("on_progress callback error", exc_info=True)

            video_id = response.get("id", "")
            logger.info("Video uploaded successfully: %s", video_id)

            # ── Post-upload duplicate detection ──────────────────────
            # If the resumable upload retried badly DURING this run
            # we'll have the canonical video_id we want to keep, plus
            # 0..N "ghost" videos with the same title also created on
            # YouTube. Find them and force them to private so they
            # don't ship publicly. We deliberately DO NOT call
            # videos().delete — destructive operations on the user's
            # actual YouTube content require explicit consent.
            try:
                dupes = _find_recent_uploads_by_title(
                    youtube, clean_title, within_minutes=60,
                )
                ghosts = [vid for vid in dupes if vid != video_id]
                for ghost_id in ghosts:
                    try:
                        youtube.videos().update(
                            part="status",
                            body={
                                "id": ghost_id,
                                "status": {"privacyStatus": "private"},
                            },
                        ).execute()
                        logger.warning(
                            "Forced duplicate video %s to PRIVATE "
                            "(same title as our canonical %s). Review "
                            "and delete manually if desired.",
                            ghost_id, video_id,
                        )
                    except Exception as exc:
                        logger.warning(
                            "Could not privatise duplicate video %s: %s",
                            ghost_id, exc,
                        )
            except Exception as exc:
                logger.warning(
                    "Post-upload duplicate sweep failed (non-fatal): %s",
                    exc,
                )

            # Set custom thumbnail if provided
            if thumbnail_path and video_id:
                try:
                    thumb_media = MediaFileUpload(thumbnail_path)
                    youtube.thumbnails().set(
                        videoId=video_id,
                        media_body=thumb_media,
                    ).execute()
                    logger.info("Custom thumbnail set for video %s", video_id)
                except Exception as exc:
                    logger.warning(
                        "Failed to set custom thumbnail for video %s: %s",
                        video_id,
                        exc,
                    )

            # Apply localizations via a follow-up videos.update call.
            # YouTube's videos.insert silently ignores the `localizations`
            # field even when it is included in `part` — translations only
            # stick when applied through videos.update after the video exists.
            #
            # We build the snippet from the values already in scope rather
            # than calling videos.list first: the list call on a freshly-
            # uploaded video can return an empty `items` array while YouTube
            # is still processing, which would silently skip the update.
            if clean_localizations and video_id:
                try:
                    upd_snippet: dict = {
                        "title": clean_title,
                        "description": clean_desc,
                        "tags": clean_tags,
                        "categoryId": category_id,
                        # defaultLanguage is required for YouTube to actually
                        # serve any localization — without it the API accepts
                        # the localizations object silently but never shows it.
                        "defaultLanguage": default_language,
                    }
                    youtube.videos().update(
                        part="snippet,localizations",
                        body={
                            "id": video_id,
                            "snippet": upd_snippet,
                            "localizations": clean_localizations,
                        },
                    ).execute()
                    logger.info(
                        "Applied %d localizations to video %s",
                        len(clean_localizations),
                        video_id,
                    )
                except Exception as exc:
                    logger.warning(
                        "Failed to apply localizations to video %s: %s",
                        video_id,
                        exc,
                    )

            return {
                "video_id": video_id,
                "url": f"https://www.youtube.com/watch?v={video_id}",
            }

        loop = asyncio.get_event_loop()
        try:
            result = await loop.run_in_executor(None, _do_upload)
        except Exception as exc:
            raise YouTubeServiceError(
                f"YouTube upload failed: {exc}"
            ) from exc

        # Final progress callback
        if on_progress is not None:
            try:
                on_progress(1.0)
            except Exception:
                logger.debug("on_progress callback error", exc_info=True)

        return result

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    @staticmethod
    def _clean_localizations(
        localizations: Optional[Dict[str, Dict[str, str]]],
    ) -> Optional[Dict[str, Dict[str, str]]]:
        """Apply YouTube's per-snippet sanitisation rules to each localised
        title + description. Drops empty entries.

        Same caps as the primary snippet: title ≤100 UTF-16 code units,
        description ≤5000 chars, ``<`` / ``>`` stripped. We don't try to
        validate the language code itself — YouTube returns a clear API
        error if it's bogus, and that error is more useful than ours.
        """
        if not localizations:
            return None
        out: Dict[str, Dict[str, str]] = {}
        for code, entry in localizations.items():
            if not isinstance(entry, dict):
                continue
            t = (entry.get("title") or "").replace("<", "").replace(">", "")
            d = (entry.get("description") or "").replace("<", "").replace(">", "")
            if not t and not d:
                continue
            # Same off-by-one fix as the primary snippet: shared helper
            # caps at exactly 100 UTF-16 units INCLUDING the appended
            # ellipsis (operator-reported invalidVideoMetadata 2026-05-17
            # caused by a 101-unit Spanish localised title).
            t = _truncate_utf16(t, max_units=100)
            if len(d) > 5000:
                d = d[:4997] + "..."
            out[str(code)] = {"title": t, "description": d}
        return out or None

    @staticmethod
    def _parse_credentials(credentials_json: str) -> dict:
        """Parse and validate a credentials JSON string."""
        try:
            data = json.loads(credentials_json)
        except (json.JSONDecodeError, TypeError) as exc:
            raise YouTubeServiceError(
                f"Invalid credentials JSON: {exc}"
            ) from exc

        if not isinstance(data, dict):
            raise YouTubeServiceError("Credentials JSON must be a dict/object.")

        if not data.get("token") and not data.get("refresh_token"):
            raise YouTubeServiceError(
                "Credentials JSON must contain at least a 'token' or 'refresh_token'."
            )

        return data


# Module-level singleton
youtube_service = YouTubeService()
