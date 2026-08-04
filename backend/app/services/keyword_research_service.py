"""Keyword research service for YouTube SEO.

Pulls real-world signal from free/cheap sources before metadata generation:

  - YouTube autocomplete (suggestqueries) — free, no auth, returns the actual
    queries users are typing right now. Best signal-to-effort by far.
  - YouTube Data API v3 — when an API key is configured. ``videos.list?
    chart=mostPopular`` (1 unit) gives top trending videos by category.
    ``search.list`` (100 units) is reserved for explicit niche searches and
    cached aggressively to stay within the 10 000-units/day project quota.

Results are cached per channel/day in a tiny on-disk JSON file so we don't
re-research between every video creation.

Usage:

    from app.services.keyword_research_service import keyword_research_service
    research = await keyword_research_service.research(
        channel_id=channel.id,
        niche=channel.niche,
        seed_keywords=["lofi", "study", "chill"],
        category_id="10",  # Music
    )
    # research = {
    #   "autocomplete": ["lofi hip hop", "lofi beats", "lofi study", ...],
    #   "trending_titles": ["...", "..."],
    #   "trending_tags": ["lofi", "chill beats", ...],
    #   "competitor_videos": [{"title": "...", "tags": [...], "views": 1234567}, ...],
    # }

The data is shaped to be dropped straight into a Claude prompt as plain text
so we don't add another layer of abstraction. See `claude_cli_service.py`
``generate_metadata`` for how it's consumed.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from pathlib import Path
from typing import Any, Dict, List, Optional

import httpx

from app.config import settings


logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Cache (one JSON file per channel/day under data/cache/keyword_research)
# ---------------------------------------------------------------------------

_CACHE_DIR = settings.data_dir / "cache" / "keyword_research"
_CACHE_TTL_SECONDS = 12 * 3600  # refresh twice a day max


def _cache_path(channel_id: int, niche: str) -> Path:
    _CACHE_DIR.mkdir(parents=True, exist_ok=True)
    safe_niche = "".join(c for c in (niche or "default") if c.isalnum() or c in "-_")[:24]
    return _CACHE_DIR / f"channel_{channel_id}_{safe_niche or 'default'}.json"


def _load_cache(channel_id: int, niche: str) -> Optional[Dict[str, Any]]:
    p = _cache_path(channel_id, niche)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        ts = float(data.get("_cached_at", 0))
        if time.time() - ts < _CACHE_TTL_SECONDS:
            return data
    except (OSError, ValueError, json.JSONDecodeError):
        return None
    return None


def _save_cache(channel_id: int, niche: str, data: Dict[str, Any]) -> None:
    p = _cache_path(channel_id, niche)
    try:
        payload = {**data, "_cached_at": time.time()}
        p.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    except OSError:
        logger.warning("Failed to write keyword cache to %s", p)


# ---------------------------------------------------------------------------
# YouTube autocomplete (free, no auth)
# ---------------------------------------------------------------------------

# We deliberately fan out two levels: seed → suggestions → recursive
# suggestions. Two levels with ~5 first-level suggestions tends to yield
# 25–40 distinct long-tail phrases — plenty for Claude to anchor on
# without hammering the endpoint.
_AUTOCOMPLETE_URL = "https://suggestqueries.google.com/complete/search"
_AUTOCOMPLETE_CONCURRENCY = 4


async def _fetch_autocomplete_one(
    client: httpx.AsyncClient, seed: str, hl: str = "en", gl: str = "US",
) -> List[str]:
    """Fetch one batch of autocomplete suggestions for a seed query."""
    if not seed.strip():
        return []
    params = {"client": "firefox", "ds": "yt", "q": seed, "hl": hl, "gl": gl}
    try:
        r = await client.get(_AUTOCOMPLETE_URL, params=params, timeout=4.0)
        r.raise_for_status()
        data = r.json()
        if isinstance(data, list) and len(data) >= 2 and isinstance(data[1], list):
            # Format: [seed, [suggestions]]
            return [str(s).strip() for s in data[1] if isinstance(s, str) and s.strip()]
    except (httpx.HTTPError, ValueError, json.JSONDecodeError) as e:
        logger.debug("autocomplete failed for %s: %s", seed, e)
    return []


async def gather_autocomplete(
    seeds: List[str], depth: int = 2, max_total: int = 80,
) -> List[str]:
    """Recursively fetch autocomplete for *seeds* up to *depth* levels.

    Returns a deduplicated list, ordered by frequency of appearance across
    the BFS so the most consistently-suggested phrases come first.
    """
    seen: Dict[str, int] = {}
    current = [s.strip() for s in seeds if s.strip()]
    sem = asyncio.Semaphore(_AUTOCOMPLETE_CONCURRENCY)

    async with httpx.AsyncClient(headers={"User-Agent": "Mozilla/5.0"}) as client:
        for level in range(depth):
            if not current:
                break

            async def _one(seed: str) -> List[str]:
                async with sem:
                    return await _fetch_autocomplete_one(client, seed)

            results = await asyncio.gather(*[_one(s) for s in current])
            next_round: List[str] = []
            for batch in results:
                for s in batch:
                    seen[s] = seen.get(s, 0) + 1
                    if level < depth - 1 and len(seen) < max_total:
                        next_round.append(s)
            current = list(dict.fromkeys(next_round))[: max_total - len(seen)]
            if not current:
                break

    ranked = sorted(seen.items(), key=lambda kv: (-kv[1], kv[0]))
    return [k for k, _v in ranked][:max_total]


# ---------------------------------------------------------------------------
# YouTube Data API v3 (requires settings.youtube_api_key)
# ---------------------------------------------------------------------------

_YT_API_BASE = "https://www.googleapis.com/youtube/v3"
_TRENDING_REGION_DEFAULT = "US"


async def _resolve_api_key() -> str:
    """Find the YouTube Data API key, preferring the DB-stored secret over env."""
    # 1) DB-stored AppSetting (user-entered via Settings page, encrypted)
    try:
        from app.database import async_session
        from app.exceptions import CredentialError
        from app.services.credentials_service import get_setting
        async with async_session() as session:
            try:
                value = await get_setting(session, "youtube_api_key")
            except CredentialError:
                # Stored value is corrupt — fall through to env fallback.
                value = None
            if value:
                return value.strip()
    except Exception as e:
        logger.debug("DB-stored youtube_api_key lookup failed: %s", e)
    # 2) env / Settings fallback (YTS_YOUTUBE_API_KEY)
    return (getattr(settings, "youtube_api_key", "") or "").strip()


async def _yt_api_get(
    client: httpx.AsyncClient, path: str, params: Dict[str, Any],
) -> Optional[Dict[str, Any]]:
    api_key = await _resolve_api_key()
    if not api_key:
        return None
    full_params = {**params, "key": api_key}
    try:
        r = await client.get(f"{_YT_API_BASE}/{path}", params=full_params, timeout=8.0)
        if r.status_code == 403:
            logger.warning("YouTube Data API 403 (quota?) on %s: %s", path, r.text[:200])
            return None
        r.raise_for_status()
        return r.json()
    except httpx.HTTPError as e:
        logger.debug("YT API %s failed: %s", path, e)
        return None


async def fetch_trending_videos(
    category_id: Optional[str] = None,
    region: str = _TRENDING_REGION_DEFAULT,
    max_results: int = 25,
) -> List[Dict[str, Any]]:
    """``videos.list?chart=mostPopular``. Cost: 1 unit per call.

    Returns list of {title, tags, views, video_id}. Empty list if no API key
    is configured or the call fails.
    """
    params: Dict[str, Any] = {
        "part": "snippet,statistics",
        "chart": "mostPopular",
        "regionCode": region,
        "maxResults": min(50, max_results),
    }
    if category_id:
        params["videoCategoryId"] = str(category_id)

    async with httpx.AsyncClient() as client:
        data = await _yt_api_get(client, "videos", params)
    if not data:
        return []

    out: List[Dict[str, Any]] = []
    for item in data.get("items", []):
        sn = item.get("snippet", {})
        st = item.get("statistics", {})
        out.append({
            "video_id": item.get("id"),
            "title": sn.get("title", ""),
            "tags": list(sn.get("tags") or []),
            "views": int(st.get("viewCount", 0) or 0),
            "channel": sn.get("channelTitle", ""),
        })
    return out


async def search_competitor_videos(
    query: str, max_results: int = 25, region: str = _TRENDING_REGION_DEFAULT,
) -> List[Dict[str, Any]]:
    """``search.list`` (100 units) → ``videos.list`` (1 unit) for tags.

    Use sparingly — caller should cache for at least a day.
    """
    async with httpx.AsyncClient() as client:
        search = await _yt_api_get(
            client,
            "search",
            {
                "part": "snippet",
                "q": query,
                "type": "video",
                "regionCode": region,
                "order": "viewCount",
                "maxResults": min(50, max_results),
            },
        )
        if not search:
            return []
        ids = [it["id"]["videoId"] for it in search.get("items", []) if "videoId" in it.get("id", {})]
        if not ids:
            return []

        videos = await _yt_api_get(
            client, "videos", {"part": "snippet,statistics", "id": ",".join(ids)},
        )
    if not videos:
        return []

    out: List[Dict[str, Any]] = []
    for item in videos.get("items", []):
        sn = item.get("snippet", {})
        st = item.get("statistics", {})
        out.append({
            "video_id": item.get("id"),
            "title": sn.get("title", ""),
            "tags": list(sn.get("tags") or []),
            "views": int(st.get("viewCount", 0) or 0),
            "channel": sn.get("channelTitle", ""),
        })
    return out


# ---------------------------------------------------------------------------
# Aggregation
# ---------------------------------------------------------------------------

# YouTube category IDs for `videos.list?chart=mostPopular&videoCategoryId=`
NICHE_CATEGORY_MAP = {
    "lofi": "10",
    "music": "10",
    "asmr": "10",          # most ASMR is uploaded under Music or People & Blogs
    "education": "27",
    "motivation": "22",    # People & Blogs
    "stories": "24",       # Entertainment
    "tech": "28",
    "finance": "25",       # News & Politics is closest
    "custom": None,
}


class KeywordResearchService:
    """Aggregate keyword/trend signals for a channel niche."""

    async def research(
        self,
        channel_id: int,
        niche: str,
        seed_keywords: List[str],
        category_id: Optional[str] = None,
        force_refresh: bool = False,
    ) -> Dict[str, Any]:
        """Return cached-or-fresh research for the given channel/niche.

        Result shape:
            {
                "niche": str,
                "autocomplete": [str, ...],
                "trending_videos": [{title, tags, views, channel}, ...],
                "trending_tags": [str, ...],   # frequency-ranked
                "trending_titles": [str, ...],
                "sources": ["autocomplete", "trending_videos"],
                "fetched_at": float (unix ts),
            }
        """
        if not force_refresh:
            cached = _load_cache(channel_id, niche)
            if cached:
                return cached

        if not seed_keywords:
            seed_keywords = [niche or "music"]

        category = category_id or NICHE_CATEGORY_MAP.get(niche.lower(), None)

        # Run autocomplete and trending in parallel
        autocomplete_task = asyncio.create_task(
            gather_autocomplete(seed_keywords, depth=2, max_total=60)
        )
        trending_task = asyncio.create_task(
            fetch_trending_videos(category_id=category, max_results=25)
        )
        autocomplete, trending_videos = await asyncio.gather(
            autocomplete_task, trending_task, return_exceptions=False,
        )

        # Frequency-rank tags across all trending videos
        tag_freq: Dict[str, int] = {}
        for v in trending_videos:
            for t in v.get("tags", []):
                t = str(t).strip().lower()
                if 2 <= len(t) <= 60:
                    tag_freq[t] = tag_freq.get(t, 0) + 1
        trending_tags = [
            t for t, _f in sorted(tag_freq.items(), key=lambda kv: (-kv[1], kv[0]))
        ][:40]

        trending_titles = [v["title"] for v in trending_videos if v.get("title")][:25]

        sources: List[str] = []
        if autocomplete:
            sources.append("autocomplete")
        if trending_videos:
            sources.append("trending_videos")

        result: Dict[str, Any] = {
            "niche": niche,
            "autocomplete": autocomplete,
            "trending_videos": trending_videos,
            "trending_tags": trending_tags,
            "trending_titles": trending_titles,
            "sources": sources,
            "fetched_at": time.time(),
        }

        _save_cache(channel_id, niche, result)
        return result

    @staticmethod
    def format_for_prompt(research: Dict[str, Any], max_chars: int = 4000) -> str:
        """Format the research dict into a readable block for the Claude prompt."""
        if not research:
            return ""
        parts: List[str] = ["## Real-time research signals"]

        ac = research.get("autocomplete") or []
        if ac:
            parts.append(
                "Top YouTube autocomplete queries for this niche right now "
                "(what people are actually searching for):"
            )
            parts.append("\n".join(f"- {q}" for q in ac[:30]))

        tt = research.get("trending_tags") or []
        if tt:
            parts.append(
                "\nMost-used tags across the current top trending videos in "
                "this category (frequency-ranked):"
            )
            parts.append(", ".join(tt[:25]))

        ttl = research.get("trending_titles") or []
        if ttl:
            parts.append(
                "\nExample titles of the top trending videos in this category "
                "(study the patterns — front-loaded keywords, length, brackets, "
                "numbers — but DO NOT copy them):"
            )
            parts.append("\n".join(f"- {t}" for t in ttl[:15]))

        text = "\n".join(parts)
        if len(text) > max_chars:
            text = text[: max_chars - 3] + "..."
        return text


keyword_research_service = KeywordResearchService()
