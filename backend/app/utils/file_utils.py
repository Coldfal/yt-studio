from __future__ import annotations

import logging
import mimetypes
import re
from datetime import datetime
from pathlib import Path
from typing import Optional
from uuid import uuid4

from app.config import settings

logger = logging.getLogger(__name__)


def slugify(value: str, max_len: int = 30) -> str:
    """Lowercase, ASCII-friendly, hyphen-separated filename fragment.

    Keeps Latin/numeric chars, swaps whitespace and other non-word
    characters for hyphens, collapses repeats, trims to ``max_len``.
    Returns "untitled" when the input has no usable characters.
    """
    if not value:
        return "untitled"
    s = str(value).strip().lower()
    # Replace whitespace and underscores first so "japanese lofi" → "japanese-lofi"
    s = re.sub(r"[\s_]+", "-", s)
    # Drop everything that isn't a-z, 0-9, or hyphen
    s = re.sub(r"[^a-z0-9\-]+", "", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return (s or "untitled")[:max_len]


def build_video_filename(
    channel_name: Optional[str],
    niche: Optional[str] = None,
    default_tags: Optional[str] = None,
    suffix: str = "",
    extension: str = "mp4",
    when: Optional[datetime] = None,
) -> str:
    """Build a meaningful filename for a composed/extended video.

    Format: ``<channel-slug>_<topic-slug>_<YYYY-MM-DD>[_suffix]_<hex>.<ext>``

    The topic slug picks the most descriptive label available — the first
    entry in ``default_tags`` when present, otherwise the channel niche.
    Falls back gracefully if both are missing.

    Examples:
      ``yomibeats_japanese-lofi_2026-05-04_a3f.mp4``
      ``techno-house_music_2026-05-04_extended_b81.mp4``
    """
    when = when or datetime.now()
    parts: list[str] = [slugify(channel_name or "channel", max_len=24)]

    topic = ""
    if default_tags:
        # default_tags can be a comma-separated string or a list
        if isinstance(default_tags, list):
            topic = str(default_tags[0]) if default_tags else ""
        else:
            first = str(default_tags).split(",", 1)[0]
            topic = first.strip()
    if not topic and niche:
        topic = str(niche)
    if topic:
        parts.append(slugify(topic, max_len=24))

    parts.append(when.strftime("%Y-%m-%d"))
    if suffix:
        parts.append(slugify(suffix, max_len=20))
    parts.append(uuid4().hex[:6])
    return "_".join(parts) + f".{extension}"

# Ensure the stdlib database is initialised (no-op if already done)
mimetypes.init()

# Fallback map for extensions that the stdlib sometimes misses
_EXTRA_MIME: dict[str, str] = {
    ".mp3": "audio/mpeg",
    ".mp4": "video/mp4",
    ".webm": "video/webm",
    ".ogg": "audio/ogg",
    ".wav": "audio/wav",
    ".flac": "audio/flac",
    ".aac": "audio/aac",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".webp": "image/webp",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".json": "application/json",
    ".txt": "text/plain",
    ".srt": "text/plain",
    ".vtt": "text/vtt",
}


def get_asset_dir(channel_id: int, asset_type: str) -> Path:
    """Return (and create if necessary) the asset directory for a channel/type."""
    directory = settings.assets_dir / str(channel_id) / asset_type
    directory.mkdir(parents=True, exist_ok=True)
    return directory


def save_upload_file(
    channel_id: int,
    asset_type: str,
    filename: str,
    content: bytes,
) -> tuple[str, int]:
    """Persist *content* to disk and return ``(relative_filepath, file_size)``.

    The filename is prefixed with 8 hex characters from a UUID4 to prevent
    collisions when different uploads share the same original name.
    """
    prefix = uuid4().hex[:8]
    safe_name = f"{prefix}_{filename}"
    directory = get_asset_dir(channel_id, asset_type)
    full_path = directory / safe_name

    full_path.write_bytes(content)
    file_size = len(content)

    # Relative path from the assets root (stored in DB)
    relative = full_path.relative_to(settings.assets_dir).as_posix()
    logger.info("Saved upload %s (%d bytes)", relative, file_size)
    return relative, file_size


def get_mime_type(filename: str) -> str:
    """Return a MIME type for *filename* based on its extension."""
    ext = Path(filename).suffix.lower()
    mime = _EXTRA_MIME.get(ext)
    if mime:
        return mime
    guessed, _ = mimetypes.guess_type(filename)
    return guessed or "application/octet-stream"


def delete_asset_file(filepath: str) -> None:
    """Delete the asset at *filepath* (relative to ``settings.assets_dir``).

    Silently ignores missing files.
    """
    full_path = settings.assets_dir / filepath
    try:
        full_path.unlink(missing_ok=True)
        logger.info("Deleted asset file %s", filepath)
    except OSError:
        logger.warning("Could not delete asset file %s", filepath, exc_info=True)
