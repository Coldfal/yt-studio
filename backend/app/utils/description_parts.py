"""Tiny pure helpers for slicing YouTube descriptions.

Used by both the translation generator (only the "top" gets sent to
Claude) and the upload step (where the tracklist + hashtags from the
English version get re-attached to each localised description).

These are intentionally heuristic — Claude's house-style output is
consistent enough that simple anchor matching works without parsing
the whole structure.
"""
from __future__ import annotations

import re
from typing import Tuple

# Anchors that mark the boundary between the "translatable top" and
# the rest. Case-insensitive, whole-line match. The first one that
# fires wins.
_BOUNDARY_PATTERNS = (
    r"^\s*TRACKLIST\b",
    r"^\s*Tracklist\b",
    r"^\s*TRACKS?\s*[:\-]",
    r"^\s*\d+:\d{2}\s+\S",  # first timestamp line is also a fine boundary
)


# Anchor names that count as "this is where the tracklist goes". Used
# by the injection paths in api/metadata.py and workers/task_runner.py
# when filling in the timestamps + track names. Each channel can wrap
# the anchor with decorations and the regex still matches:
#   - YomiBeats:    ``TRACKLIST`` (plain)
#   - Yomi Radio:   ``---TRACKLIST---``
#   - Isekai Radio: ``CHAPTER NOTES`` (different word entirely)
#   - Operator may also wrap with em-dashes / heavy box-drawing chars
# Examples that match: ``TRACKLIST``, ``---TRACKLIST---``,
#                      ``━━ TRACKLIST ━━``, ``Chapters``, ``CHAPTER NOTES``
_TRACKLIST_ANCHOR_RE = re.compile(
    r"^\s*[\-=━─_\s]*\s*"
    r"(TRACKLIST|TRACK\s+LIST|CHAPTERS?|CHAPTER\s+NOTES?)"
    r"\s*[\-=━─_\s]*\s*$",
    re.IGNORECASE,
)


def is_tracklist_anchor(line: str) -> bool:
    """True when ``line`` looks like a tracklist-section header.

    Used to find the insertion point for the auto-generated timestamps
    inside the description. Matching is generous so different channels
    can decorate the header without breaking the injection.
    """
    return bool(_TRACKLIST_ANCHOR_RE.match(line))


def split_top_and_rest(description: str) -> Tuple[str, str]:
    """Split a description into ``(top, rest)``.

    ``top`` is everything before the first tracklist/timestamp anchor —
    that's the "human" copy that gets translated.
    ``rest`` is the tracklist + everything that follows (CTA + hashtags
    + dividers). It's appended **unchanged** to localised descriptions
    so timestamps and hashtag exposure stay consistent across locales.

    If no anchor is found, returns ``(description, "")`` — callers
    can decide whether to translate the whole thing or skip.
    """
    if not description:
        return ("", "")

    for pat in _BOUNDARY_PATTERNS:
        match = re.search(pat, description, flags=re.MULTILINE)
        if match:
            split_at = match.start()
            top = description[:split_at].rstrip()
            rest = description[split_at:].lstrip("\n")
            return (top, rest)

    # No anchor found. Try one fallback: strip a trailing block of
    # lines that begin with "#" (hashtag tail) and call the head the top.
    lines = description.splitlines()
    tail_start = len(lines)
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i].strip()
        if not line:
            continue
        if line.startswith("#"):
            tail_start = i
            continue
        break
    if tail_start < len(lines):
        top = "\n".join(lines[:tail_start]).rstrip()
        rest = "\n".join(lines[tail_start:]).lstrip("\n")
        return (top, rest)

    return (description, "")


def build_localized_description(
    translated_top: str,
    english_description: str,
) -> str:
    """Glue a translated top onto the English tracklist/CTA/hashtag tail.

    The "rest" (timestamps + final CTA + hashtags) is intentionally
    kept untranslated so the tracklist remains a verbatim list of song
    names and the hashtag SEO budget isn't burned on translated tags.
    """
    _top, rest = split_top_and_rest(english_description or "")
    translated_top = (translated_top or "").rstrip()
    if not rest:
        return translated_top
    if not translated_top:
        return rest
    return f"{translated_top}\n\n{rest}"
