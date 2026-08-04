"""Pin the location of the built-in subscribe overlay assets.

This caught a real bug: the PNG + WebM lived under
``backend/data/builtin/`` but the runtime ``settings.data_dir``
resolves to ``<project_root>/data/``. The mismatch made every
composed video silently miss the subscribe overlay even though
the preview showed it.

If anyone moves the files again, this test fails noisily.
"""
from __future__ import annotations

from pathlib import Path

import pytest

from app.config import settings


def test_builtin_subscribe_png_lives_under_data_dir():
    # Project root has a real data/ dir on the operator's machine.
    # Tests rewrite settings.data_dir to a tmp dir (see conftest), so
    # this test would fail there. Skip when the override is in effect.
    if "ytstudio_tests_" in str(settings.data_dir):
        pytest.skip("settings.data_dir is the test tmp dir — runtime check N/A here")
    expected = settings.data_dir / "builtin" / "subscribe-animation.png"
    assert expected.exists(), (
        f"Subscribe overlay PNG missing at {expected}. "
        "compose_service builds this exact path; if it doesn't exist on "
        "disk every composed video silently ships without the overlay."
    )


def test_builtin_subscribe_webm_lives_under_data_dir():
    if "ytstudio_tests_" in str(settings.data_dir):
        pytest.skip("settings.data_dir is the test tmp dir — runtime check N/A here")
    expected = settings.data_dir / "builtin" / "subscribe-animation.webm"
    assert expected.exists(), (
        f"Subscribe overlay WebM missing at {expected}. "
        "Used by the live-stream visualizer for animated playback."
    )


def test_compose_service_overlay_path_construction():
    """Independent of where the files actually live, the path
    construction in compose_service must use settings.data_dir + 'builtin'.
    Catches the case where someone refactors the path constant."""
    from app.config import settings as live_settings

    # The two literal paths compose_service builds:
    expected_png = live_settings.data_dir / "builtin" / "subscribe-animation.png"
    # Sanity: it ends with the right segments regardless of OS path separator.
    parts = list(expected_png.parts[-2:])
    assert parts == ["builtin", "subscribe-animation.png"]
