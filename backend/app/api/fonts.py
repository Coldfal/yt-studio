"""Fonts API: list + serve the font files that ship in
``backend/visualizer_engine/fonts/``.

Why here and not the existing assets path: those fonts have two consumers —
the visualizer engine subprocess (Node + ``@napi-rs/canvas`` via
``GlobalFonts.registerFromPath`` in exporter.ts) and the browser-side
thumbnail editor (via the FontFace API). Both want to scan the same
directory. Exposing them as a small API surface beats hardcoding a font
list in two places and means adding a new font is just "drop the .otf in,
restart backend".
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Optional

from fastapi import APIRouter, HTTPException
from fastapi.responses import FileResponse

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/api/fonts", tags=["fonts"])


def _fonts_dir() -> Path:
    """Resolve the same directory the visualizer engine scans.

    ``backend/visualizer_engine/fonts/`` relative to this file's two
    parents-up (``app/api/fonts.py`` → ``backend/visualizer_engine/fonts``).
    """
    return Path(__file__).resolve().parents[2] / "visualizer_engine" / "fonts"


# Strip common style suffixes when deriving the family name from the
# filename. Order matters — match longer suffixes first so "BoldItalic"
# doesn't get stripped to "Bold" + leftover "Italic".
_STYLE_SUFFIXES = (
    "BoldItalic", "ExtraBoldItalic", "MediumItalic", "SemiBoldItalic",
    "LightItalic", "BlackItalic", "ThinItalic",
    "Italic", "Oblique",
    "ExtraBold", "SemiBold", "Black", "Heavy", "Medium", "Light", "Thin",
    "Bold", "Regular", "Book",
    "Variable", "VF",
)
_VARIABLE_RE = re.compile(r"\[.*?\]")  # e.g. "Cinzel[wght].ttf"


def _family_from_filename(stem: str) -> str:
    """Best-effort family name from a font filename stem.

    Examples:
        ``Cinzel-Bold`` → ``Cinzel``
        ``BebasNeue-Regular`` → ``Bebas Neue``
        ``Inter[wght]`` → ``Inter``
        ``PlayfairDisplay-Italic`` → ``Playfair Display``

    Imperfect when a font ships with an unusual filename, but the dropdown
    label and FontFace registration name only need to agree with each
    other — and the frontend reads BOTH from this endpoint, so they stay
    in sync no matter what we return here.
    """
    # Strip variable-font axis tag like "[wght]"
    stem = _VARIABLE_RE.sub("", stem).strip()
    # Split on common separators; we'll rebuild with spaces
    parts = re.split(r"[-_\s]+", stem)
    # Drop trailing style descriptors (Bold, Italic, etc.)
    while parts and parts[-1] in _STYLE_SUFFIXES:
        parts.pop()
    if not parts:
        parts = re.split(r"[-_\s]+", stem)  # fall back to whatever we had
    # Insert spaces between CamelCase words (BebasNeue → Bebas Neue)
    spaced: list[str] = []
    for part in parts:
        spaced.append(re.sub(r"(?<=[a-z])(?=[A-Z])", " ", part))
    family = " ".join(spaced).strip()
    return family or stem


def _mime_for(suffix: str) -> str:
    s = suffix.lower()
    if s == ".otf":
        return "font/otf"
    if s == ".ttf":
        return "font/ttf"
    if s == ".woff":
        return "font/woff"
    if s == ".woff2":
        return "font/woff2"
    return "application/octet-stream"


@router.get("/")
async def list_fonts() -> list[dict]:
    """Return one entry per font file the engine sees.

    The frontend uses ``url`` with the FontFace API to fetch and register
    the font in the browser. ``family`` is what gets used as
    ``ctx.font = '... "Family Name"'`` at draw time AND as the
    FontFace constructor's first argument — they must match.

    De-duplicates by family so the picker doesn't show "Cinzel" 4 times
    when Regular/Bold/Italic/BoldItalic are all present. The first
    file seen for each family wins (typically -Regular alphabetically).
    """
    d = _fonts_dir()
    if not d.exists():
        return []
    seen: dict[str, dict] = {}
    for path in sorted(d.iterdir()):
        if not path.is_file():
            continue
        if path.suffix.lower() not in {".otf", ".ttf", ".woff", ".woff2"}:
            continue
        family = _family_from_filename(path.stem)
        if family in seen:
            continue
        seen[family] = {
            "family": family,
            "filename": path.name,
            "url": f"/api/fonts/file/{path.name}",
        }
    return list(seen.values())


@router.get("/file/{filename}")
async def get_font_file(filename: str) -> FileResponse:
    """Stream a single font file.

    The browser's FontFace API needs CORS-friendly headers, which FastAPI
    (and the dev proxy in vite.config.ts) handle automatically for same-
    origin requests. No need to set ``Access-Control-Allow-Origin`` here
    explicitly — the frontend hits this through the ``/api`` proxy on the
    same origin.
    """
    # Reject directory traversal — the filename should be flat.
    if "/" in filename or "\\" in filename or ".." in filename:
        raise HTTPException(status_code=400, detail="Invalid filename.")
    path = _fonts_dir() / filename
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="Font not found.")
    return FileResponse(
        path,
        media_type=_mime_for(path.suffix),
        headers={
            # Long cache — these files don't change at runtime, and the
            # filename includes the family/style so a new font won't ever
            # collide with a cached one.
            "Cache-Control": "public, max-age=31536000, immutable",
        },
    )
