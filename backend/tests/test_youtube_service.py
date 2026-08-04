"""Tests for YouTubeService.upload_video — localizations auto-apply.

YouTube's videos.insert silently ignores the `localizations` field, so
upload_video must call a follow-up videos.update to commit translations.
These tests verify that behaviour without hitting the real YouTube API.
"""
from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

import pytest

from app.services.youtube_service import YouTubeService


# ── Helpers ───────────────────────────────────────────────────────────────────

_FAKE_CREDS = json.dumps(
    {
        "token": "tok",
        "refresh_token": "rtok",
        "token_uri": "https://oauth2.googleapis.com/token",
        "client_id": "cid",
        "client_secret": "csec",
        "scopes": ["https://www.googleapis.com/auth/youtube.upload"],
    }
)

_LOCALIZATIONS = {
    "es": {"title": "Título ES", "description": "Descripción ES"},
    "fr": {"title": "Titre FR", "description": "Description FR"},
}


def _make_youtube_mock(video_id: str = "vid123") -> MagicMock:
    """Build a mock youtube client that returns `video_id` on insert."""
    yt = MagicMock()

    # videos().insert() — resumable upload simulation
    insert_req = MagicMock()
    insert_req.next_chunk.return_value = (None, {"id": video_id})
    yt.videos.return_value.insert.return_value = insert_req

    # videos().update() — must be called to commit localizations
    yt.videos.return_value.update.return_value.execute.return_value = {}

    # thumbnails().set() — not relevant, but prevent attribute errors
    yt.thumbnails.return_value.set.return_value.execute.return_value = {}

    return yt


# ── Tests ─────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_upload_applies_localizations_via_update():
    """When localizations are provided, videos.update is called after insert."""
    yt_mock = _make_youtube_mock("vid123")

    with (
        patch(
            "app.services.youtube_service.build",
            return_value=yt_mock,
        ),
        patch(
            "app.services.youtube_service.MediaFileUpload",
            return_value=MagicMock(),
        ),
        patch(
            "app.services.rate_limiter.rate_limiter.acquire",
            return_value=None,
        ),
    ):
        svc = YouTubeService()
        result = await svc.upload_video(
            credentials_json=_FAKE_CREDS,
            filepath="/tmp/fake.mp4",
            title="My Video",
            description="My Desc",
            localizations=_LOCALIZATIONS,
            default_language="en",
        )

    assert result["video_id"] == "vid123"

    # insert must have been called exactly once
    yt_mock.videos.return_value.insert.assert_called_once()

    # videos().list() should NOT be called — we build the snippet inline
    yt_mock.videos.return_value.list.assert_not_called()

    # update must have been called with the localizations payload
    update_call_args = yt_mock.videos.return_value.update.call_args
    assert update_call_args is not None, "videos().update() was never called"
    kwargs = update_call_args.kwargs
    assert kwargs["part"] == "snippet,localizations"
    body = kwargs["body"]
    assert body["id"] == "vid123"
    assert "es" in body["localizations"]
    assert "fr" in body["localizations"]
    # defaultLanguage must be on the snippet
    assert body["snippet"]["defaultLanguage"] == "en"
    # core snippet fields must be present (required by YouTube)
    assert "title" in body["snippet"]
    assert "description" in body["snippet"]
    assert "categoryId" in body["snippet"]


@pytest.mark.asyncio
async def test_upload_skips_update_when_no_localizations():
    """When no localizations are provided, videos.update is NOT called."""
    yt_mock = _make_youtube_mock("vid456")

    with (
        patch("app.services.youtube_service.build", return_value=yt_mock),
        patch("app.services.youtube_service.MediaFileUpload", return_value=MagicMock()),
        patch("app.services.rate_limiter.rate_limiter.acquire", return_value=None),
    ):
        svc = YouTubeService()
        result = await svc.upload_video(
            credentials_json=_FAKE_CREDS,
            filepath="/tmp/fake.mp4",
            title="No Translations",
            description="Plain upload",
            localizations=None,
        )

    assert result["video_id"] == "vid456"
    yt_mock.videos.return_value.update.assert_not_called()
    yt_mock.videos.return_value.list.assert_not_called()


@pytest.mark.asyncio
async def test_upload_succeeds_even_if_localization_update_fails():
    """A videos.update failure is caught; the upload result is still returned."""
    yt_mock = _make_youtube_mock("vid789")

    # Make the update call raise
    yt_mock.videos.return_value.update.return_value.execute.side_effect = (
        RuntimeError("YouTube 403 quotaExceeded")
    )

    with (
        patch("app.services.youtube_service.build", return_value=yt_mock),
        patch("app.services.youtube_service.MediaFileUpload", return_value=MagicMock()),
        patch("app.services.rate_limiter.rate_limiter.acquire", return_value=None),
    ):
        svc = YouTubeService()
        result = await svc.upload_video(
            credentials_json=_FAKE_CREDS,
            filepath="/tmp/fake.mp4",
            title="Fault Tolerant",
            description="Desc",
            localizations=_LOCALIZATIONS,
        )

    # Upload succeeds even when the follow-up update throws
    assert result["video_id"] == "vid789"
    assert "youtube.com" in result["url"]


@pytest.mark.asyncio
async def test_upload_uses_upload_category_id_in_update_snippet():
    """The same category_id passed to upload_video appears in the update snippet."""
    yt_mock = _make_youtube_mock("vidCAT")

    with (
        patch("app.services.youtube_service.build", return_value=yt_mock),
        patch("app.services.youtube_service.MediaFileUpload", return_value=MagicMock()),
        patch("app.services.rate_limiter.rate_limiter.acquire", return_value=None),
    ):
        svc = YouTubeService()
        await svc.upload_video(
            credentials_json=_FAKE_CREDS,
            filepath="/tmp/fake.mp4",
            title="Cat Test",
            description="Desc",
            localizations=_LOCALIZATIONS,
            category_id="22",  # People & Blogs
        )

    update_body = yt_mock.videos.return_value.update.call_args.kwargs["body"]
    assert update_body["snippet"]["categoryId"] == "22"


@pytest.mark.asyncio
async def test_upload_update_uses_correct_default_language():
    """default_language passed to upload_video is set on the update snippet."""
    yt_mock = _make_youtube_mock("vidLANG")

    with (
        patch("app.services.youtube_service.build", return_value=yt_mock),
        patch("app.services.youtube_service.MediaFileUpload", return_value=MagicMock()),
        patch("app.services.rate_limiter.rate_limiter.acquire", return_value=None),
    ):
        svc = YouTubeService()
        await svc.upload_video(
            credentials_json=_FAKE_CREDS,
            filepath="/tmp/fake.mp4",
            title="Lang Test",
            description="Desc",
            localizations=_LOCALIZATIONS,
            default_language="ja",
        )

    update_body = yt_mock.videos.return_value.update.call_args.kwargs["body"]
    assert update_body["snippet"]["defaultLanguage"] == "ja"


# ── Tag sanitization ──────────────────────────────────────────────────────────


async def _capture_insert_body(yt_mock: MagicMock, **upload_kwargs) -> dict:
    """Run upload_video with the patched mocks and return the snippet
    body sent to videos().insert(). Used for the tag-sanitization tests."""
    with (
        patch("app.services.youtube_service.build", return_value=yt_mock),
        patch("app.services.youtube_service.MediaFileUpload", return_value=MagicMock()),
        patch("app.services.rate_limiter.rate_limiter.acquire", return_value=None),
    ):
        svc = YouTubeService()
        await svc.upload_video(
            credentials_json=_FAKE_CREDS,
            filepath="/tmp/fake.mp4",
            **upload_kwargs,
        )
    insert_kwargs = yt_mock.videos.return_value.insert.call_args.kwargs
    return insert_kwargs["body"]


@pytest.mark.asyncio
async def test_tag_sanitization_strips_quotes_and_brackets():
    """Tags with ", ', <, > are scrubbed (these chars 400 the upload)."""
    yt_mock = _make_youtube_mock()
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=['has "quotes"', "angle <bracket>", "ok tag", "single ' quote"],
    )
    tags = body["snippet"]["tags"]
    # Every tag should have all forbidden chars removed
    joined = " ".join(tags)
    for ch in '"<>\'':
        assert ch not in joined, f"forbidden char {ch!r} survived in {tags!r}"
    # Non-empty tags survive
    assert "ok tag" in tags


@pytest.mark.asyncio
async def test_tag_sanitization_drops_empty_after_scrub():
    """A tag that's only forbidden chars gets dropped, not sent as empty."""
    yt_mock = _make_youtube_mock()
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=['""', "''", "<<>>", "real tag"],
    )
    tags = body["snippet"]["tags"]
    assert "" not in tags
    assert tags == ["real tag"]


@pytest.mark.asyncio
async def test_tag_sanitization_drops_pure_punctuation():
    """Tags that are only punctuation (no word chars) are dropped."""
    yt_mock = _make_youtube_mock()
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=["!!!", "...", "---", "real tag", "ok", ":-)"],
    )
    tags = body["snippet"]["tags"]
    assert "!!!" not in tags
    assert "---" not in tags
    assert ":-)" not in tags
    # "ok" is 2 chars and contains word chars → keeps
    assert "ok" in tags
    assert "real tag" in tags


@pytest.mark.asyncio
async def test_tag_sanitization_strips_control_chars():
    """Control characters and NULs are stripped before validation."""
    yt_mock = _make_youtube_mock()
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=["lofi\x00music", "chill\x07beats", "ok"],
    )
    tags = body["snippet"]["tags"]
    assert "lofi\x00music" not in tags
    assert any("lofi" in t and "\x00" not in t for t in tags)
    assert "ok" in tags


@pytest.mark.asyncio
async def test_tag_sanitization_dedupes_case_insensitive():
    """Duplicate tags (different casing) are collapsed."""
    yt_mock = _make_youtube_mock()
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=["Lofi", "lofi", "LOFI", "chill"],
    )
    tags = body["snippet"]["tags"]
    # First-seen casing wins; the duplicates are dropped
    assert sum(1 for t in tags if t.lower() == "lofi") == 1
    assert "chill" in tags


@pytest.mark.asyncio
async def test_tag_sanitization_caps_per_tag_at_30_utf16_units():
    """Tags over 30 UTF-16 code units are dropped (YouTube's per-tag limit)."""
    yt_mock = _make_youtube_mock()
    long_tag = "a" * 31
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=[long_tag, "short"],
    )
    tags = body["snippet"]["tags"]
    assert long_tag not in tags
    assert "short" in tags


@pytest.mark.asyncio
async def test_tag_sanitization_total_budget_under_500():
    """Total joined length (with separators) stays under YouTube's ~500 limit."""
    yt_mock = _make_youtube_mock()
    # 50 tags of length 25 — far over budget
    many_tags = [f"tag number {i:03d}" for i in range(50)]
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=many_tags,
    )
    tags = body["snippet"]["tags"]
    # Some get dropped — total budget caps at 500
    joined = ",".join(tags)
    assert len(joined) <= 500
    # But at least some tags made it through
    assert len(tags) > 0


@pytest.mark.asyncio
async def test_tag_sanitization_preserves_japanese_korean():
    """CJK / Hangul tags are kept (the channel uses them for SEO)."""
    yt_mock = _make_youtube_mock()
    body = await _capture_insert_body(
        yt_mock,
        title="t",
        description="d",
        tags=["瞑想音楽", "睡眠音楽", "수면 음악", "english tag"],
    )
    tags = body["snippet"]["tags"]
    assert "瞑想音楽" in tags
    assert "睡眠音楽" in tags
    assert "수면 음악" in tags
    assert "english tag" in tags
