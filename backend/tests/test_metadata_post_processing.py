"""Tests for the title-scrubber + tracklist injection.

These two pieces caught a real regression: a YouTube upload went out
with an empty TRACKLIST section + a banned `☯` symbol in the title.
The tests below pin both behaviours so that doesn't recur silently.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest

from app.services.claude_cli_service import _scrub_title


# ── Title scrubber ───────────────────────────────────────────────────


def test_scrub_drops_yin_yang_symbol():
    out = _scrub_title("『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』☯ Foo Bar | Genre Tag")
    assert "☯" not in out
    assert "Foo Bar" in out
    assert "Genre Tag" in out


def test_scrub_drops_heart_emoji():
    out = _scrub_title("『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』 Shibuya Night 🤍 | Lofi")
    assert "🤍" not in out
    assert "Shibuya Night" in out


def test_scrub_drops_face_emoji():
    out = _scrub_title("Vibes 😎 Forever | Music")
    assert "😎" not in out


def test_scrub_keeps_typographic_decorations():
    # ⋆｡°✩ is geometric/CJK punctuation, NOT emoji — must survive.
    out = _scrub_title("『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』 Rainy Tokyo ⋆｡°✩ | Chill Rap")
    assert "『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』" in out
    assert "⋆｡°✩" in out
    assert " | Chill Rap" in out


def test_scrub_collapses_double_spaces_after_removal():
    # Removing "☯ " between two words must not leave a double space.
    out = _scrub_title("Foo ☯ Bar")
    assert "  " not in out
    assert out == "Foo Bar"


def test_scrub_strips_dangling_pipe():
    # Removing the only thing after the pipe should also remove the
    # pipe so we don't ship "Title |" to YouTube.
    out = _scrub_title("Lonely Title | 🤍")
    assert not out.endswith("|")
    assert "🤍" not in out


def test_scrub_idempotent_on_clean_title():
    clean = "『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』 Rainy Tokyo ⋆｡°✩ | Chill Rap・Pop R&B"
    assert _scrub_title(clean) == clean


# ── Tracklist injection ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_tracklist_lands_when_claude_leaves_header_blank(monkeypatch):
    """The exact failure mode the user hit: Claude returns a TRACKLIST
    header with nothing after it; our post-processor must inject
    the timestamped tracks before the closing divider."""
    from app.services.automation_service import _shared as mod

    fake_metadata = {
        "title": "『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』 Foo | Lofi",
        "description": (
            "Slow down.\n\n"
            "Curated playlist for late nights.\n\n"
            "Perfect for:\n"
            "→ Studying\n\n"
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "TRACKLIST\n\n\n"          # blank section, exactly like the bug
            "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n"
            "Channel pitch.\n\n"
            "#lofi #chill"
        ),
        "tags": ["lofi"],
        "category_id": "10",
    }

    # Patch the Claude CLI to return our canned blank-tracklist response.
    with patch(
        "app.services.claude_cli_service.claude_cli_service.generate_metadata",
        new=AsyncMock(return_value=fake_metadata),
    ):
        result = await mod._generate_metadata_claude(
            config={
                "channel_id": 1,
                "channel_name": "Test",
                "channel_niche": "lofi",
                "metadata_mode": "claude",
                "title_template": None,
                "description_template": None,
                "tags_template": None,
                "claude_prompt": None,
            },
            template_vars={
                "date": "2026-05-05",
                "short_date": "2026-05-05",
                "channel_name": "Test",
                "track_count": "3",
                "total_duration": "9:00",
                "tracklist": (
                    "0:00 - First Track\n"
                    "3:00 - Second Track\n"
                    "6:00 - Third Track"
                ),
                "niche": "lofi",
            },
            tracks=[
                {"title": "First Track", "filename": "1.mp3", "duration_seconds": 180},
                {"title": "Second Track", "filename": "2.mp3", "duration_seconds": 180},
                {"title": "Third Track", "filename": "3.mp3", "duration_seconds": 180},
            ],
        )

    desc = result["description"]
    # All three timestamped lines must be present, in order, between
    # the TRACKLIST header and the closing divider.
    assert "0:00 - First Track" in desc
    assert "3:00 - Second Track" in desc
    assert "6:00 - Third Track" in desc
    tracklist_pos = desc.index("TRACKLIST")
    closing_divider_pos = desc.index("━━━", tracklist_pos)
    assert tracklist_pos < desc.index("0:00 - First Track") < closing_divider_pos


@pytest.mark.asyncio
async def test_tracklist_injection_idempotent_when_already_present():
    """If Claude already wrote the tracklist in (it sometimes does),
    we shouldn't double up."""
    from app.services.automation_service import _shared as mod

    desc_with_tracks = (
        "Hook line.\n\n"
        "TRACKLIST\n\n"
        "0:00 - First Track\n"
        "3:00 - Second Track\n\n"
        "━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n"
    )
    fake_metadata = {
        "title": "X",
        "description": desc_with_tracks,
        "tags": [],
        "category_id": "10",
    }

    with patch(
        "app.services.claude_cli_service.claude_cli_service.generate_metadata",
        new=AsyncMock(return_value=fake_metadata),
    ):
        result = await mod._generate_metadata_claude(
            config={
                "channel_id": 1,
                "channel_name": "Test",
                "channel_niche": "",
                "metadata_mode": "claude",
                "title_template": None,
                "description_template": None,
                "tags_template": None,
                "claude_prompt": None,
            },
            template_vars={
                "date": "",
                "short_date": "",
                "channel_name": "Test",
                "track_count": "2",
                "total_duration": "6:00",
                "tracklist": "0:00 - First Track\n3:00 - Second Track",
                "niche": "",
            },
            tracks=[
                {"title": "First Track", "filename": "1.mp3", "duration_seconds": 180},
                {"title": "Second Track", "filename": "2.mp3", "duration_seconds": 180},
            ],
        )

    # Track lines should appear exactly once, not twice.
    assert result["description"].count("0:00 - First Track") == 1
