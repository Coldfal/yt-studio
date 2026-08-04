"""Claude Code CLI wrapper for YouTube metadata generation.

Replaces the older Anthropic-SDK-based ``claude_service``. This version
spawns the user's installed Claude Code CLI as a subprocess via ``claude
-p`` so calls bill against the user's Claude Code subscription instead of
an API key.

CLI envelope shape (from ``claude -p --output-format json``):

    {
      "type": "result",
      "subtype": "success",
      "is_error": false,
      "result": "<assistant text, possibly markdown-wrapped JSON>",
      ...
    }

We unwrap that envelope, then extract a JSON object from ``result`` —
handling markdown code-fences and free-form prose around the JSON.
"""

from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import subprocess
import sys
from typing import Any, Dict, List, Optional

from app.config import settings

logger = logging.getLogger(__name__)


class ClaudeCliError(Exception):
    """Raised when the Claude CLI fails or returns unparseable output."""


# ---------------------------------------------------------------------------
# House style — channel-driven.
#
# Pre-redesign, this file pasted a hardcoded YomiBeats brand example into
# the system prompt for EVERY channel. ``style_block()`` is now
# channel-aware: it pulls ``ai_voice`` + ``ai_example_*`` fields off the
# channel record. When the channel hasn't been configured yet, it falls
# back to a generic style brief (competent SEO copy without channel-
# specific typographic mannerisms).
#
# The ``STYLE_EXAMPLE_*`` constants below are kept ONLY as the seed
# values that the migration in ``database.py::init_db`` copies into the
# YomiBeats channel record once. After the seed runs, edits in the
# Channel AI Voice tab are the source of truth.
#
# See ``docs/ai-voice-redesign.md`` for the full rationale.
# ---------------------------------------------------------------------------

STYLE_EXAMPLE_TITLE = (
    "『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』 Rainy Tokyo Night ⋆｡°✩ | "
    "Japanese Chill Rap・Pop R&B Mix"
)

STYLE_EXAMPLE_DESCRIPTION = """\
Slow down. The city's still running but you don't have to.

The ultimate Japanese Chill Rap and Pop R&B playlist for your main character moments. A curated experience with zero skip-worthy tracks for late-night drives and urban solitude.

Soft beats, faded vocals, and the sound of Tokyo rain, perfect for unwinding after a long day, late-night reading, or drifting off.

Perfect for:
→ Studying and deep work
→ Late-night reading or journaling
→ Background music while you unwind
→ Chill lofi beats playlist on repeat

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TRACKLIST



━━━━━━━━━━━━━━━━━━━━━━━━━━━━

YomiBeats curates Japanese lofi hip hop and chill trap beats for listeners who live between the rain and the rhythm. No ads, no interruptions — just lofi study music that holds the mood.

Subscribe to YomiBeats for weekly drops of japanese chill trap lofi, jazzy hip hop sessions, and late-night lo-fi mixes.

#japaneserap  #chillplaylist  #aesthetic  #music  #vibe
"""

STYLE_EXAMPLE_TAGS = (
    "Japanese Chill Rap Playlist,日本語ラップ,Chill Rap J-Pop,감성 힙합,"
    "Pop R&B Playlist,버릴 곡이 없는 플리,aesthetic music playlist,"
    "night drive music,study BGM,TOKYO CHILL LAB vibe,slow reverb rap,"
    "urban solitude music,作業用BGM,Japanese Hip Hop 2026,japanese chill rap,"
    "japanese lofi,lofi hip hop,chillhop,rainy lofi,sleep music,tokyo lofi,"
    "作業用 bgm,aesthetic music,lo-fi,spring playlist,cozy playlist,"
    "breeze mood,urlist,mellow songs,quiet music,slow songs,rainy playlist"
)


# Anything with ``.ai_voice``, ``.ai_example_title`` etc. — typed loosely
# so this module doesn't import the SQLAlchemy model and create a cycle.
class _ChannelLike:
    ai_voice: Optional[str]
    ai_example_title: Optional[str]
    ai_example_description: Optional[str]
    ai_example_tags: Optional[str]
    niche: Optional[str]


def style_block(channel: Optional[Any] = None) -> str:
    """Pre-formatted style reference appended to every metadata prompt.

    Channel-aware: when ``channel.ai_example_title`` etc. are set, those
    are the brand reference Claude follows. When empty, the function
    falls back to a generic SEO style brief that doesn't impose any
    channel-specific typographic mannerisms.

    Claude sees a "do this" example. The instruction explicitly says:
    keep the structure, swap the topic-specific copy. So a fully-
    configured channel ships consistent copy across uploads — same vibe,
    fresh wording.
    """
    title_example = (
        getattr(channel, "ai_example_title", None) if channel else None
    )
    desc_example = (
        getattr(channel, "ai_example_description", None) if channel else None
    )
    tags_example = (
        getattr(channel, "ai_example_tags", None) if channel else None
    )
    voice = getattr(channel, "ai_voice", None) if channel else None
    notes = getattr(channel, "notes", None) if channel else None

    # If the user hasn't configured concrete examples yet, ship a
    # generic style brief. Claude can still produce competent SEO copy;
    # it just won't have a brand-specific reference to mimic.
    if not title_example and not desc_example and not tags_example:
        return _generic_style_brief(voice, notes)

    # The channel voice section IS the contract. Channel-level HARD
    # RULES (e.g. "never use em dash", "title template is fixed") must
    # not be diluted by framing text. So we keep the framing as terse
    # as possible and put nothing in it that would model bad punctuation
    # back to Claude. Em dashes are deliberately avoided here.
    parts: list[str] = [
        "## House style. Follow it exactly.\n",
    ]
    if voice:
        parts.append(f"### Channel voice instructions (HIGHEST priority)\n{voice}\n")
    if notes and notes.strip():
        # Operator notes — soft, evolving "what's working / what's not"
        # log. NOT hard rules (those go in ai_voice). Treat as context
        # the operator has learned about this channel's audience over
        # time. Lower priority than ai_voice if they ever conflict.
        parts.append(
            "### Operator notes (context — weigh, don't blindly obey)\n"
            "These are the operator's observations about what's working "
            "on this channel: audience feedback, analytics learnings, "
            "topics that resonate, formats that flop, anything they've "
            "asked you to remember. Use them to inform title/description/"
            "tag choices, but they NEVER override the channel voice "
            "instructions above.\n"
            f"{notes.strip()}\n"
        )
    if title_example:
        parts.append(
            "### TITLE format\n"
            "Use this exact format, varying only the parts that the channel "
            "voice instructions above mark as variable. Do NOT improvise on "
            "the static parts.\n"
            f"  {title_example}\n"
        )
    if desc_example:
        parts.append(
            "### DESCRIPTION reference\n"
            "Mirror this structure: opening, mid-mood paragraph, "
            '"Perfect for:" arrow list, dividers, TRACKLIST header, '
            "closing copy, hashtag line. Generate fresh copy. Keep the "
            "channel-voice rules above (length, punctuation, channel-name "
            "policy) on every line.\n"
            f"```\n{desc_example}\n```\n"
        )
    if tags_example:
        parts.append(
            "### TAGS reference (match the language mix and style; vary the actual terms)\n"
            f"  {tags_example}\n"
        )
    parts.append(
        "## Output rules\n"
        "- Generate fresh copy. Do not verbatim-copy the examples.\n"
        "- Title cap: 100 UTF-16 code units. YouTube truncates anything "
        "longer mid-word.\n"
        "- Description target: 800 to 2500 chars.\n"
        "- Tags target: 25 to 32 entries. Total joined length under 480 "
        "chars. No #, no quotes, no duplicates.\n"
        "- Never include track count or total duration in the description. "
        'Use evergreen phrasing like "a curated playlist" or "a long-form '
        'session" so the same copy works regardless of length.\n'
        "- The channel voice instructions above are HARD RULES. Honour "
        "them on every line, including over anything in this output rules "
        "section.\n"
    )
    return "\n".join(parts)


def _generic_style_brief(voice: Optional[str], notes: Optional[str] = None) -> str:
    """Fallback when the channel has no concrete examples yet.

    Avoids forcing any specific typographic style. Claude is told to
    write competent SEO copy informed by the niche + research signals.
    """
    parts: list[str] = [
        "## House style (channel has no concrete examples yet)\n",
        "Write competent YouTube SEO metadata that ranks. The user has "
        "not configured a brand-specific style reference — produce clean, "
        "professional copy that matches the niche and uses the research "
        "signals to anchor real keywords.\n",
    ]
    if voice:
        parts.append(f"### Channel voice instructions\n{voice}\n")
    if notes and notes.strip():
        parts.append(
            "### Operator notes (context)\n"
            "Observations the operator has learned about this channel's "
            "audience and what works. Weigh them when picking copy, but "
            "they never override the niche-appropriate basics.\n"
            f"{notes.strip()}\n"
        )
    parts.append(
        "### Title rules\n"
        "- ≤100 UTF-16 code units.\n"
        "- Front-load the highest-volume keyword from the research block "
        "in the first 60 chars (mobile truncation point).\n"
        "- One emotional or thematic hook word that's specific to this "
        "video — avoid generic stock phrasing.\n"
        "- No emoji unless the channel explicitly asks for them in the "
        "voice instructions above.\n"
    )
    parts.append(
        "### Description rules\n"
        "- 800–2500 chars.\n"
        "- Open with a 1-line emotional hook (not a topic announcement).\n"
        "- One paragraph that names the playlist + use case. Do NOT "
        "mention track count or total duration — keep the copy evergreen.\n"
        "- Mid-section: 1 short paragraph describing the sonic / visual mood.\n"
        '- "Perfect for:" arrow-bulleted list (3–5 items, "→" bullets).\n'
        "- Divider line (~28 ━ characters).\n"
        '- "TRACKLIST" header on its own line, followed by two blank lines '
        "— the wizard fills in the timestamps later, leave it blank.\n"
        "- Closing divider.\n"
        "- Channel pitch paragraph (uses channel name + niche).\n"
        "- Subscribe CTA.\n"
        "- 5 hashtags on the final line, separated by two spaces.\n"
    )
    parts.append(
        "### Tag rules\n"
        "- 25–32 tags total; joined length ≤480 chars.\n"
        "- Mix of: high-volume genre terms, mid-tail keyword phrases, "
        "and aesthetic descriptors. Use the research block as the source "
        "of truth — no invention.\n"
        "- No #, no quotes, no duplicates. Each tag ≤40 chars.\n"
    )
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Helpers — JSON extraction tolerant to markdown wrapping
# ---------------------------------------------------------------------------


def _parse_json_response(text: str) -> dict:
    """Extract a JSON object from the assistant's ``result`` text.

    Handles raw JSON, ```json``` fenced blocks, and prose-surrounded JSON.
    """
    stripped = (text or "").strip()
    if not stripped:
        raise ClaudeCliError("Empty result from Claude CLI.")

    # 1) raw JSON
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        pass

    # 2) ``` or ```json fenced block
    fence = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", stripped, re.DOTALL)
    if fence:
        try:
            return json.loads(fence.group(1).strip())
        except json.JSONDecodeError:
            pass

    # 3) first {...} block
    start = stripped.find("{")
    end = stripped.rfind("}")
    if start != -1 and end > start:
        try:
            return json.loads(stripped[start : end + 1])
        except json.JSONDecodeError:
            pass

    raise ClaudeCliError(
        f"Could not parse JSON from Claude CLI result. Raw text:\n{stripped[:600]}",
    )


def _validate_metadata(data: dict) -> Dict[str, Any]:
    """Validate + normalise a metadata dict."""
    title = data.get("title")
    if not title or not isinstance(title, str):
        raise ClaudeCliError("Claude response missing a valid 'title' field.")

    description = data.get("description", "")
    tags: List[str] = data.get("tags", [])
    if isinstance(tags, str):
        tags = [t.strip() for t in tags.split(",") if t.strip()]

    category_id = str(data.get("category_id", "10"))

    return {
        "title": _scrub_title(title.strip()),
        "description": description.strip() if isinstance(description, str) else "",
        "tags": [str(t).strip() for t in tags if str(t).strip()],
        "category_id": category_id,
    }


# ---------------------------------------------------------------------------
# Title scrubber — defence in depth for the prompt rules.
# Even when the prompt forbids ☯ + emoji, Claude occasionally slips them
# in. Strip them server-side so they never reach YouTube. Keeps the
# typographic decorations the brand still uses (⋆｡°✩, 『』, ・, |).
# ---------------------------------------------------------------------------

# Codepoints we explicitly drop. ☯ is retired from the brand. The
# common-emoji entries here live inside the Dingbats block (U+2700–
# U+27BF) which we deliberately do NOT include in the broad regex
# below — that block also contains the typographic stars ✩ ☆ used in
# our brand decorations and we don't want to strip those.
_BANNED_TITLE_CHARS = {
    "☯",  # U+262F — yin yang, retired from brand
    "✨",  # U+2728 — sparkles
    "✂",  # U+2702 — scissors
    "✅",  # U+2705 — check mark
    "❌",  # U+274C — cross mark
    "❤",  # U+2764 — heavy heart
    "❣",  # U+2763 — heavy heart exclamation
    "❄",  # U+2744 — snowflake
    "❗",  # U+2757 — exclamation
    "❓",  # U+2753 — question mark
    "❎",  # U+274E — negative squared cross
    "🤍",  # U+1F90D — white heart (already covered below but explicit)
}

# Regex for the broad emoji blocks. Skips Dingbats on purpose — see
# above for why. Covers the ones Claude usually slips in: hearts,
# sparkles, music, weather, faces, transport.
_EMOJI_RE = re.compile(
    "["
    "\U0001F300-\U0001F5FF"  # symbols & pictographs (incl. 🌧 ☔ 🌙)
    "\U0001F600-\U0001F64F"  # emoticons
    "\U0001F680-\U0001F6FF"  # transport & map
    "\U0001F700-\U0001F77F"  # alchemical
    "\U0001F900-\U0001F9FF"  # supplemental symbols (🤍 🤎 etc.)
    "\U0001FA00-\U0001FA6F"  # chess / medical
    "\U0001FA70-\U0001FAFF"  # symbols & pictographs extended-A
    "\U0001F1E6-\U0001F1FF"  # regional indicator (flag halves)
    "]",
    flags=re.UNICODE,
)


def _scrub_title(title: str) -> str:
    """Drop banned codepoints + emoji from a title.

    Replaces them with empty string then squashes any double-spaces /
    leading-trailing whitespace that the removal leaves behind.
    """
    if not title:
        return title
    # Drop explicit banned codepoints
    for ch in _BANNED_TITLE_CHARS:
        if ch in title:
            title = title.replace(ch, "")
    # Drop emoji
    title = _EMOJI_RE.sub("", title)
    # Collapse the double-spaces / dangling separators that removal can
    # produce (e.g. "Title ☯ Subtitle" → "Title  Subtitle" → "Title Subtitle").
    title = re.sub(r"\s{2,}", " ", title).strip()
    # Trim a leading/trailing pipe with surrounding spaces in case the
    # banned thing sat next to the | separator.
    title = re.sub(r"^\s*\|\s*|\s*\|\s*$", "", title).strip()
    return title


# ---------------------------------------------------------------------------
# Service
# ---------------------------------------------------------------------------


class ClaudeCliService:
    """Generate YouTube metadata by invoking the Claude Code CLI."""

    # Bumped to 300s after adding the house style block — the larger
    # system prompt + research data sometimes takes 2 minutes for Claude
    # CLI to return on first cold invocation.
    DEFAULT_TIMEOUT_S = 300

    # ----- Public surface --------------------------------------------------

    async def generate_raw(
        self,
        prompt: str,
        system_prompt: Optional[str] = None,
        timeout_s: int = DEFAULT_TIMEOUT_S,
    ) -> str:
        """Run an arbitrary prompt and return the assistant text verbatim.

        Used by callers that build their own prompt + parse the response
        themselves (e.g. ``automation_service`` which already extracts JSON
        from a free-form response).
        """
        return await self._run_cli(
            prompt=prompt,
            system_prompt=system_prompt or (
                "You are a helpful assistant. Respond concisely with the exact "
                "format the user asks for."
            ),
            timeout_s=timeout_s,
        )

    async def status(self) -> Dict[str, Any]:
        """Return whether the CLI is available + its path.

        Used by the Settings page to show a green/red badge.

        We deliberately avoid running the binary here — on Windows the CLI
        hangs without a proper terminal even for ``--version``. Presence of
        the binary on disk (confirmed via ``_resolve_cli_path`` / ``shutil.which``)
        is sufficient to show a green badge; the real smoke-test happens on
        first metadata generation.
        """
        path = self._resolve_cli_path()
        if not path:
            return {"available": False, "version": None, "path": None}

        import os
        exists = os.path.isfile(path)
        return {
            "available": exists,
            "version": None,
            "path": path,
        }

    async def generate_metadata(
        self,
        channel_name: str,
        niche: str,
        music_prompt: Optional[str] = None,
        additional_context: Optional[str] = None,
        research_block: Optional[str] = None,
        track_names: Optional[List[str]] = None,
        brand_identity: Optional[str] = None,
        target_audience: Optional[str] = None,
        channel: Optional[Any] = None,
        terse: bool = False,
    ) -> dict:
        """Generate full YouTube metadata as a JSON object.

        ``channel`` (a ``Channel`` ORM row) drives ``style_block(channel)``
        — its ``ai_voice`` + ``ai_example_*`` fields shape the system
        prompt. When ``channel`` is None or has no examples set, the
        generic style brief runs (no channel-specific brand voice).

        ``research_block`` is a pre-formatted text block of real-world
        signals (autocomplete queries, trending tags, top-performing titles)
        produced by ``keyword_research_service.format_for_prompt``. When
        provided, Claude must anchor its output on those concrete terms
        instead of hallucinating keywords from the niche string alone.
        """
        terse_block = (
            "\n## Length cap (terse mode)\n"
            "- Title: keep under 40 characters total.\n"
            "- Description: keep under 200 words. The opening hook,\n"
            "  one short atmospheric paragraph, a 3-line 'Perfect for:'\n"
            "  list, the TRACKLIST block (which the wizard will fill in\n"
            "  later), and 4-5 hashtags is enough. Do not pad.\n"
            "- Tags: cap the array at 8 entries.\n"
            "- The channel voice still wins on TONE and STYLE; this\n"
            "  block only constrains length.\n"
            if terse else ""
        )
        system_prompt = (
            f"You are a senior YouTube SEO copywriter for the '{niche}' niche. "
            "You ship metadata that ranks. You will be given research signals "
            "harvested from YouTube right now (autocomplete + top trending "
            "videos for this category). Use those concrete keywords — not "
            "speculation — to anchor the title, description, and tags.\n\n"
            f"{style_block(channel)}\n"
            f"{terse_block}"
            "## Output rules (always)\n"
            "- NEVER stuff irrelevant keywords.\n"
            "- Respond with VALID JSON ONLY — no markdown fences, no prose, "
            "no explanation. The JSON must be the entire response."
        )

        user_parts: list[str] = [
            f"Channel name: {channel_name}",
            f"Niche: {niche}",
        ]
        if brand_identity:
            user_parts.append(f"Brand identity: {brand_identity}")
        if target_audience:
            user_parts.append(f"Target audience: {target_audience}")
        if track_names:
            sample = "\n".join(f"- {t}" for t in track_names[:20])
            user_parts.append(f"Tracklist (first {len(track_names[:20])}):\n{sample}")
        if music_prompt:
            user_parts.append(f"Music/audio description: {music_prompt}")
        if additional_context:
            user_parts.append(f"Additional context: {additional_context}")
        if research_block:
            user_parts.append("\n" + research_block)

        user_parts.append(
            "\nReturn ONE JSON object with exactly these keys:\n"
            '- "title": SEO title following the house style (≤100 chars)\n'
            '- "description": full description following the house structure\n'
            '- "tags": array of 25-32 tag strings matching the multilingual\n'
            '  example mix (no #, no duplicates, total length ≤480 chars)\n'
            '- "category_id": YouTube category ID as a string '
            '(e.g. "10" Music, "22" People & Blogs, "24" Entertainment, '
            '"27" Education, "28" Tech)\n'
            "\nReturn ONLY that JSON object."
        )

        text = await self._run_cli(
            prompt="\n".join(user_parts),
            system_prompt=system_prompt,
        )
        parsed = _parse_json_response(text)
        return _validate_metadata(parsed)

    async def translate_metadata(
        self,
        title: str,
        description_top: str,
        target_languages: List[str],
        niche: Optional[str] = None,
        source_language: str = "en",
    ) -> dict:
        """Translate a title + description "top" into N languages.

        Used by the upload pipeline so the same video shows up with the
        right language for non-English YouTube users via the
        ``localizations`` API field. The "top" is the human-facing copy
        before the TRACKLIST — translating timestamps + hashtags would
        be noise.

        ``source_language`` is the YT code the input is written in
        (defaults to ``"en"`` to preserve legacy behaviour). For
        Korean-master channels (e.g. yomii studio) pass ``"ko"`` so the
        prompt + sanity checks treat the input as Korean. Any code in
        ``target_languages`` that equals ``source_language`` is silently
        dropped (translating ko→ko is a no-op).

        ``target_languages`` is a list of YouTube localization codes
        (e.g. ``["en", "ja", "zh-Hans", "es"]``). Returns a dict shaped
        like::

            {
              "en":      {"title": "...", "description": "..."},
              "ja":      {"title": "...", "description": "..."},
              "zh-Hans": {"title": "...", "description": "..."},
              "es":      {"title": "...", "description": "..."},
            }

        Each translated title respects YouTube's 100-char (UTF-16) cap
        and the description is the standalone translated top — the
        tracklist + hashtags are stitched on at upload time, not here.
        """
        # Drop any target that matches the source (translating to the
        # same language is a no-op + would pollute the output dict).
        target_languages = [
            c for c in target_languages if c and c != source_language
        ]
        if not target_languages:
            return {}

        lang_label = {
            "ja": "Japanese",
            "zh-Hans": "Simplified Chinese",
            "zh-Hant": "Traditional Chinese",
            "zh": "Chinese (Simplified)",
            "ko": "Korean",
            "es": "Spanish",
            "en": "English",
            "fr": "French",
            "de": "German",
            "pt": "Portuguese",
            "it": "Italian",
        }
        lang_lines = "\n".join(
            f'  - "{code}" ({lang_label.get(code, code)})'
            for code in target_languages
        )

        # Use concrete line + paragraph counts in the prompt so Claude
        # has unambiguous targets — the model previously omitted the
        # "Perfect for:" list and added its own "@channel" + tracklist
        # header that weren't in the source. Counting every line
        # forces it to translate ALL of them.
        source_lines = description_top.splitlines()
        source_line_count = len(source_lines)
        source_paragraph_count = len(
            [p for p in description_top.split("\n\n") if p.strip()]
        )

        system_prompt = (
            "You are a senior multilingual YouTube copywriter localising music "
            "playlist metadata. Your ONLY job is faithful translation — never "
            "rewriting, never summarising, never adding flourishes the source "
            "doesn't contain.\n\n"
            "ABSOLUTE RULES (violating any of these means the output is wrong):\n"
            "1. The translated description MUST cover EVERY paragraph in the "
            "source — same paragraph count, same paragraph order, same internal "
            "structure (single line vs. bulleted list).\n"
            "2. If the source has a 'Perfect for:' arrow-bulleted list, the "
            "translation MUST contain the equivalent header AND every bullet, "
            "still as a list — translate the items, do NOT collapse them into "
            "prose.\n"
            "3. Do NOT add anything that isn't in the source. Specifically: "
            "no '@channelname' mentions, no 'TRACKLIST' headers, no chapter "
            "timestamps, no hashtags, no CTAs, no subscribe pleas, no closing "
            "tags. The source description ends EXACTLY where the source you "
            "received ends.\n"
            "4. Do NOT omit anything. If a sentence in the source is hard to "
            "translate, paraphrase rather than skip it.\n"
            "5. Preserve all decorative glyphs (「」『』⋆｡°✩ ━━━ → ✨ etc.) "
            "and emoji at the same positions where they appear in the source.\n"
            "6. Keep proper nouns (channel names, song titles, place names) "
            "in their original script unless the locale has a well-established "
            "equivalent — e.g. 'YomiBeats' stays 'YomiBeats' in every locale.\n"
            "7. Each translated title MUST stay under 100 characters in the "
            "target script. If the literal translation runs long, shorten the "
            "descriptive tail (not the brand/hook).\n"
            "8. Return VALID JSON ONLY — no markdown fences, no prose outside "
            "the JSON, no explanation. The JSON must be the entire response."
        )

        source_label = lang_label.get(source_language, source_language)
        user_parts: list[str] = [
            "Translate the following YouTube metadata into the listed languages.",
            f"\nNiche / genre context: {niche or 'general music playlist'}",
            f"\nSOURCE TITLE ({source_label}):",
            title,
            f"\nSOURCE DESCRIPTION TOP ({source_label}) — translate this exact "
            "block VERBATIM. The block has "
            f"{source_paragraph_count} paragraph(s) "
            f"and {source_line_count} non-empty/empty line(s) total. Your "
            "translation MUST have the same paragraph count and the same "
            "structural elements (any bulleted list stays a bulleted list). "
            "Do NOT add a closing line, channel mention, or tracklist header — "
            "those are added separately at upload time:",
            "─── BEGIN SOURCE ───",
            description_top,
            "─── END SOURCE ───",
            "\nTARGET LANGUAGES (use these exact codes as JSON keys):",
            lang_lines,
            "\nReturn ONE JSON object whose keys are the language codes "
            "above. Each value is an object with two string fields: "
            '"title" and "description". Example shape:',
            '{"ja": {"title": "...", "description": "..."}, ...}',
            "\nFinal check before responding: count the paragraphs in your "
            f"translation — each language should have exactly "
            f"{source_paragraph_count} paragraph(s), matching the source. "
            "Return ONLY the JSON object.",
        ]

        # Translation is format-preservation + tonal-faithfulness, not
        # deep reasoning. Haiku 4.5 reads the same source rules just as
        # well as Sonnet and finishes ~2-3x faster on a 4-language
        # description: observed ~1m 50s on Haiku vs the 3-5min (and
        # frequent 300s timeout) we were seeing on Sonnet. Sonnet stays
        # the default for metadata generation, where the channel
        # ai_voice rules + research grounding genuinely benefit from
        # the stronger model.
        text = await self._run_cli(
            prompt="\n".join(user_parts),
            system_prompt=system_prompt,
            timeout_s=600,
            model="haiku",
        )
        parsed = _parse_json_response(text)
        if not isinstance(parsed, dict):
            raise ClaudeCliError(
                f"Translation response was not a JSON object: {type(parsed).__name__}"
            )

        # Normalise: only keep requested codes, ensure title+description present.
        out: dict[str, dict[str, str]] = {}
        # Use the source description's paragraph count as a sanity floor —
        # the translation should have roughly the same shape. CJK languages
        # come out shorter on character count (they pack more meaning per
        # character) but the paragraph count should still match.
        source_paragraphs = [
            p for p in description_top.split("\n\n") if p.strip()
        ]
        for code in target_languages:
            entry = parsed.get(code) or parsed.get(code.lower()) or parsed.get(code.replace("-Hans", ""))
            if not isinstance(entry, dict):
                continue
            t = str(entry.get("title") or "").strip()
            d = str(entry.get("description") or "").strip()
            if not t and not d:
                continue

            # Sanity check: translated description should have at least
            # as many paragraphs as the source. If Claude collapsed or
            # omitted sections (the "Perfect for:" list disappearing was
            # the original bug), log loudly so the operator can re-run.
            translated_paragraphs = [p for p in d.split("\n\n") if p.strip()]
            if (
                source_paragraphs
                and translated_paragraphs
                and len(translated_paragraphs) < len(source_paragraphs)
            ):
                logger.warning(
                    "Translation for %s came back with %d paragraphs vs %d in "
                    "source — likely missing a section. Source: %r... "
                    "Translation: %r...",
                    code,
                    len(translated_paragraphs),
                    len(source_paragraphs),
                    description_top[:120],
                    d[:120],
                )

            out[code] = {"title": t, "description": d}
        return out

    async def regenerate_field(
        self,
        field: str,
        current_metadata: dict,
        instruction: Optional[str] = None,
    ) -> str:
        """Regenerate a single metadata field. Returns the new value as a
        string (for ``tags`` it's a JSON-encoded list)."""
        valid_fields = {"title", "description", "tags", "category_id"}
        if field not in valid_fields:
            raise ClaudeCliError(
                f"Invalid field '{field}'. Must be one of: {', '.join(sorted(valid_fields))}",
            )

        system_prompt = (
            "You are an expert YouTube SEO specialist. You will be given existing "
            "YouTube metadata and asked to regenerate ONE specific field. "
            "Return ONLY the new value for that field — no JSON wrapping, no "
            "markdown, no explanation. For tags, return a JSON array of strings."
        )

        parts: list[str] = [
            "Current metadata:",
            json.dumps(current_metadata, indent=2),
            f"\nRegenerate the '{field}' field.",
        ]
        if instruction:
            parts.append(f"User instruction: {instruction}")

        if field == "title":
            parts.append("Return only the new title text (max 100 characters).")
        elif field == "description":
            parts.append("Return only the new description text (1000-2000 characters).")
        elif field == "tags":
            parts.append("Return only a JSON array of 10-20 tag strings.")
        elif field == "category_id":
            parts.append("Return only the YouTube category ID as a plain string (e.g. 10).")

        text = await self._run_cli(prompt="\n".join(parts), system_prompt=system_prompt)
        text = text.strip()

        # For tags, normalise back to a JSON array string
        if field == "tags":
            tags: List[str]
            try:
                if text.startswith("["):
                    tags = json.loads(text)
                else:
                    parsed = _parse_json_response(text)
                    if isinstance(parsed, list):
                        tags = parsed
                    elif isinstance(parsed, dict) and "tags" in parsed:
                        tags = parsed["tags"]
                    else:
                        raise ClaudeCliError("Could not extract tags array")
            except (ClaudeCliError, json.JSONDecodeError):
                # Last-resort comma split
                tags = [t.strip().strip('"').strip("'") for t in text.split(",") if t.strip()]
            return json.dumps([str(t) for t in tags])

        return text

    # ----- Internals -------------------------------------------------------

    def _resolve_cli_path(self) -> Optional[str]:
        """Find the ``claude`` binary. Honours ``settings.claude_cli_path``."""
        configured = (getattr(settings, "claude_cli_path", "") or "").strip()
        if configured:
            return configured
        which = shutil.which("claude")
        return which

    async def _run_cli(
        self,
        *,
        prompt: str,
        system_prompt: str,
        timeout_s: int = DEFAULT_TIMEOUT_S,
        model: str = "sonnet",
    ) -> str:
        """Invoke ``claude -p`` and return the assistant text from the JSON envelope.

        ``model`` defaults to ``sonnet`` because that's what every call site
        used before this parameter existed. Translation passes ``"haiku"`` —
        translation work is format-preservation + tonal-faithfulness, not
        deep reasoning, and Haiku 4.5 finishes in seconds instead of minutes
        for that workload. Keep Sonnet for metadata generation, where the
        channel's voice rules genuinely benefit from the stronger model.

        Note: we deliberately do NOT pass ``--bare`` — bare mode forces use of
        ANTHROPIC_API_KEY and bypasses the user's interactive login. Without
        ``--bare`` the CLI uses its OAuth credentials, billing against the
        Claude Code subscription.
        """
        # Rate-limit: claude_cli bucket = 30/min, capacity 5. Stays
        # well inside the subscription tier's community-observed
        # throttle. Single global bucket (channel_id=None) because
        # the Claude CLI is configured at the app level, not per
        # channel — a quota hit would affect all channels equally.
        from app.services.rate_limiter import rate_limiter
        await rate_limiter.acquire(provider="claude_cli")

        path = self._resolve_cli_path()
        if not path:
            raise ClaudeCliError(
                "Claude Code CLI not found on PATH. Install Claude Code from "
                "https://code.claude.com or set YTS_CLAUDE_CLI_PATH to its location.",
            )

        cmd = [
            path,
            "-p",
            "--output-format", "json",
            "--no-session-persistence",
            "--model", model,
            "--append-system-prompt", system_prompt,
            prompt,
        ]
        logger.debug("Running Claude CLI: %s ...prompt=%d chars", path, len(prompt))

        # Run in a thread executor so this works on Windows regardless of the
        # asyncio event-loop policy (SelectorEventLoop can't create subprocesses).
        loop = asyncio.get_running_loop()
        try:
            result = await asyncio.wait_for(
                loop.run_in_executor(
                    None,
                    lambda: subprocess.run(
                        cmd,
                        capture_output=True,
                        timeout=timeout_s,
                        creationflags=(
                            subprocess.CREATE_NO_WINDOW if sys.platform == "win32" else 0
                        ),
                    ),
                ),
                timeout=timeout_s + 5,
            )
        except FileNotFoundError as exc:
            raise ClaudeCliError(f"Failed to spawn Claude CLI ({path}): {exc}") from exc
        except (asyncio.TimeoutError, subprocess.TimeoutExpired) as exc:
            raise ClaudeCliError(f"Claude CLI timed out after {timeout_s}s") from exc

        if result.returncode != 0:
            err_tail = (result.stderr or b"").decode("utf-8", errors="replace")[-800:]
            raise ClaudeCliError(
                f"Claude CLI exited with code {result.returncode}: {err_tail}",
            )

        raw = (result.stdout or b"").decode("utf-8", errors="replace")
        try:
            envelope = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ClaudeCliError(
                f"Could not parse Claude CLI envelope: {exc}\nFirst 500 chars: {raw[:500]}",
            ) from exc

        if envelope.get("is_error"):
            err_msg = envelope.get("result") or "(no error message)"
            raise ClaudeCliError(f"Claude CLI returned error: {err_msg}")

        result = envelope.get("result")
        if not isinstance(result, str):
            raise ClaudeCliError(
                f"Claude CLI envelope had no string 'result' field. Got: {type(result).__name__}",
            )
        logger.debug("Claude CLI raw result (first 200): %s", result[:200])
        return result


# Module-level singleton — drop-in replacement for the old `claude_service`.
claude_cli_service = ClaudeCliService()
