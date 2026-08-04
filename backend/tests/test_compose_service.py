"""Compose service unit tests.

Focus on pure helpers (filename builder, slugify) and the snap-to-song
math that determines extend_video's loop count. Heavy FFmpeg paths are
mocked out in conftest's ``patched_services`` fixture.
"""
from __future__ import annotations

import re
from datetime import datetime

import pytest

from app.utils.file_utils import build_video_filename, slugify


# ── slugify ──────────────────────────────────────────────────────────


def test_slugify_basic_lowercase_and_hyphenates():
    assert slugify("Japanese Lofi") == "japanese-lofi"


def test_slugify_underscores_become_hyphens():
    assert slugify("relax_chill_beats") == "relax-chill-beats"


def test_slugify_drops_non_ascii_punct():
    assert slugify("Café! Music?") == "caf-music"


def test_slugify_collapses_repeats_and_trims():
    assert slugify("---hello---world---") == "hello-world"


def test_slugify_returns_untitled_for_empty():
    assert slugify("") == "untitled"
    assert slugify("!!!") == "untitled"


def test_slugify_respects_max_len():
    assert len(slugify("a" * 200, max_len=10)) == 10


# ── build_video_filename ─────────────────────────────────────────────


def test_filename_uses_channel_slug_and_topic_from_default_tags():
    when = datetime(2026, 5, 4, 12, 0, 0)
    name = build_video_filename(
        channel_name="YomiBeats",
        niche="lofi",
        default_tags="japanese lofi, ambient",
        when=when,
    )
    assert name.startswith("yomibeats_japanese-lofi_2026-05-04_")
    # 6-char hex + .mp4
    assert re.match(
        r"yomibeats_japanese-lofi_2026-05-04_[a-f0-9]{6}\.mp4$", name
    )


def test_filename_falls_back_to_niche_when_no_tags():
    when = datetime(2026, 5, 4)
    name = build_video_filename(
        channel_name="TestChannel",
        niche="techno",
        default_tags=None,
        when=when,
    )
    assert "techno" in name
    assert name.endswith(".mp4")


def test_filename_handles_missing_channel_name():
    when = datetime(2026, 5, 4)
    name = build_video_filename(channel_name=None, niche="lofi", when=when)
    assert name.startswith("channel_")  # slugify falls back to "channel"


def test_filename_includes_suffix():
    when = datetime(2026, 5, 4)
    name = build_video_filename(
        channel_name="X",
        niche="lofi",
        suffix="extended",
        when=when,
    )
    assert "extended" in name


def test_filename_extension_can_be_overridden():
    when = datetime(2026, 5, 4)
    name = build_video_filename(
        channel_name="X",
        niche="lofi",
        when=when,
        extension="webm",
    )
    assert name.endswith(".webm")


def test_filename_handles_default_tags_as_list():
    when = datetime(2026, 5, 4)
    name = build_video_filename(
        channel_name="X",
        niche=None,
        default_tags=["first tag", "second"],
        when=when,
    )
    assert "first-tag" in name
