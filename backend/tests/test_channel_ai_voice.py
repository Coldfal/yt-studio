"""Tests for the channel-aware AI voice — replaces the hardcoded
``style_block()`` that forced every channel through YomiBeats's voice.

Covers:
- ``style_block(None)`` returns the generic SEO brief (no channel-specific
  typographic mannerisms).
- ``style_block(channel_with_examples)`` includes the channel's
  ``ai_voice`` + ``ai_example_*`` content.
- ``generate_metadata`` accepts a ``channel`` kwarg and threads it through.
- The ``/api/channels/{id}/ai-prompt-preview`` endpoint returns the
  rendered system + user prompt, with channel-specific content embedded.
"""
from __future__ import annotations

from unittest.mock import AsyncMock, patch

import pytest
from httpx import ASGITransport, AsyncClient

from app.main import app
from app.models import Channel
from app.services.claude_cli_service import (
    style_block,
    STYLE_EXAMPLE_TITLE,
    STYLE_EXAMPLE_DESCRIPTION,
    STYLE_EXAMPLE_TAGS,
)


# ── style_block ──────────────────────────────────────────────────────────────


def test_style_block_none_returns_generic_brief():
    """No channel → generic brief, no typographic mannerisms."""
    out = style_block(None)
    assert "channel has no concrete examples yet" in out
    # Generic brief must NOT push the YomiBeats brand
    assert "𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭" not in out
    assert STYLE_EXAMPLE_TITLE not in out


def test_style_block_empty_channel_returns_generic_brief():
    """Channel exists but ai_* fields are empty → generic brief."""
    ch = Channel(name="x", niche="meditation")  # no ai_* set
    out = style_block(ch)
    assert "channel has no concrete examples yet" in out
    # Niche-specific keywords should NOT leak through (the niche only
    # gets baked into the system prompt's outer wrapper, not the brief)
    assert STYLE_EXAMPLE_TITLE not in out


def test_style_block_with_examples_uses_channel_voice():
    """Channel voice + examples land in the rendered block verbatim."""
    ch = Channel(
        name="ZenTaoSounds",
        niche="ambient",
        ai_voice="Open titles with a single moon emoji. Lowercase mostly.",
        ai_example_title="🌙 deep sleep ambient · 8 hours of dreaming sound",
        ai_example_description="There's no rush. Let the night carry you.",
        ai_example_tags="ambient, sleep music, deep sleep, meditation",
    )
    out = style_block(ch)
    assert "Open titles with a single moon emoji" in out
    assert "🌙 deep sleep ambient" in out
    assert "Let the night carry you" in out
    assert "ambient, sleep music" in out
    # Generic-brief language must NOT appear when examples exist
    assert "channel has no concrete examples yet" not in out
    # And — critically — YomiBeats's example must NOT leak into ZenTao
    assert STYLE_EXAMPLE_TITLE not in out


def test_style_block_with_only_voice_still_uses_examples_path():
    """Voice without examples — still wraps in 'house style' framing."""
    ch = Channel(name="x", niche="lofi", ai_voice="Be calm.")
    out = style_block(ch)
    # No examples set → generic-brief path runs (preserves voice)
    assert "Be calm." in out


# ── generate_metadata accepts channel kwarg ──────────────────────────────────


@pytest.mark.asyncio
async def test_generate_metadata_passes_channel_voice_into_system_prompt(db, channel: Channel):
    """The channel's ai_example_title flows into the system prompt
    that ``generate_metadata`` builds."""
    channel.ai_example_title = "🌙 unique zen example"
    channel.ai_example_description = "unique zen description body"
    channel.ai_example_tags = "ambient, zen, custom"
    await db.commit()
    await db.refresh(channel)

    captured: dict = {}

    async def fake_run_cli(self, *, prompt: str, system_prompt: str, **kw):
        captured["system_prompt"] = system_prompt
        captured["user_prompt"] = prompt
        return '{"title":"t","description":"d","tags":["a","b","c","d","e"],"category_id":"10"}'

    from app.services.claude_cli_service import claude_cli_service
    with patch.object(
        claude_cli_service.__class__, "_run_cli", new=fake_run_cli,
    ):
        await claude_cli_service.generate_metadata(
            channel_name=channel.name,
            niche=channel.niche or "",
            channel=channel,
        )

    sp = captured["system_prompt"]
    assert "🌙 unique zen example" in sp
    assert "unique zen description body" in sp
    assert "ambient, zen, custom" in sp
    # Hardcoded YomiBeats reference must NOT be in this channel's prompt
    assert STYLE_EXAMPLE_TITLE not in sp


# ── /api/channels/{id}/ai-prompt-preview ─────────────────────────────────────


@pytest.mark.asyncio
async def test_ai_prompt_preview_renders_channel_specific_content(db, channel: Channel):
    """Endpoint returns system + user prompt with the channel's own examples."""
    channel.ai_example_title = "preview-example-title"
    channel.ai_example_description = "preview-example-desc"
    channel.ai_voice = "preview-voice-instructions"
    await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(f"/api/channels/{channel.id}/ai-prompt-preview")

    assert resp.status_code == 200
    data = resp.json()
    sp = data["system_prompt"]
    assert "preview-example-title" in sp
    assert "preview-example-desc" in sp
    assert "preview-voice-instructions" in sp
    assert data["channel_has_examples"] is True
    # User prompt must include the channel's name + niche
    assert channel.name in data["user_prompt"]
    # No real project → synthetic placeholder track names
    assert any("Sample track" in t for t in data["track_names_used"])


@pytest.mark.asyncio
async def test_ai_prompt_preview_empty_channel_uses_generic_brief(db, channel: Channel):
    """Channel with no ai_* fields → preview shows the generic brief."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get(f"/api/channels/{channel.id}/ai-prompt-preview")

    assert resp.status_code == 200
    data = resp.json()
    assert data["channel_has_examples"] is False
    assert "channel has no concrete examples yet" in data["system_prompt"]


@pytest.mark.asyncio
async def test_ai_prompt_preview_unknown_channel_404(db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.get("/api/channels/99999/ai-prompt-preview")
    assert resp.status_code == 404


# ── /api/channels/{id}/ai-sample ─────────────────────────────────────────────


@pytest.mark.asyncio
async def test_ai_sample_returns_metadata_shape(db, channel: Channel):
    """Endpoint runs Claude (mocked) and returns the standard shape."""
    fake_metadata = {
        "title": "Sampled title",
        "description": "Sampled description",
        "tags": ["a", "b", "c"],
        "category_id": "10",
    }

    from app.services.claude_cli_service import claude_cli_service
    with patch.object(
        claude_cli_service, "generate_metadata",
        new=AsyncMock(return_value=fake_metadata),
    ):
        transport = ASGITransport(app=app)
        async with AsyncClient(transport=transport, base_url="http://test") as ac:
            resp = await ac.post(f"/api/channels/{channel.id}/ai-sample")

    assert resp.status_code == 200
    data = resp.json()
    assert data["title"] == "Sampled title"
    assert data["description"] == "Sampled description"
    assert data["tags"] == ["a", "b", "c"]
    assert data["category_id"] == "10"


@pytest.mark.asyncio
async def test_ai_sample_unknown_channel_404(db):
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as ac:
        resp = await ac.post("/api/channels/99999/ai-sample")
    assert resp.status_code == 404
