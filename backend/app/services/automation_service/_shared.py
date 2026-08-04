"""Helpers shared between ``execute_run`` (folder mode) and
``quick_generate`` (library mode).

Kept at module level (no class) so they can be imported by either
flow without a circular dep, and so they're trivial to unit-test.
"""
from __future__ import annotations

import json
import logging
import random
from datetime import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional

from sqlalchemy import and_, delete, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import async_session
from app.models import Asset, VideoProject

logger = logging.getLogger(__name__)


def format_duration(seconds: float) -> str:
    """Format seconds as M:SS."""
    m = int(seconds // 60)
    s = int(seconds % 60)
    return f"{m}:{s:02d}"


# Internal alias — code inside this package keeps calling _format_duration
# so the diff against the pre-split file is small.
_format_duration = format_duration


def select_tracks(
    files: List[dict],
    target_seconds: int,
    tolerance: float = 300.0,
    num_tracks: Optional[int] = None,
    prefer_group: Optional[str] = None,  # deprecated — folder pairing removed
) -> List[dict]:
    """Randomly select tracks for a video.

    When ``num_tracks`` is set, picks exactly that many random tracks
    regardless of duration — the compose+extend pipeline loops the result
    to reach ``target_seconds``.

    Otherwise shuffles and accumulates until total duration is within
    ``tolerance`` seconds of ``target_seconds``.

    ``prefer_group`` is kept as a parameter for backwards compatibility
    but is now a no-op — folder pairing was ripped out in Phase 0 of
    the farm-redesign roadmap. Track selection no longer constrains
    by folder group.
    """
    _ = prefer_group  # silence unused-arg warnings
    if not files:
        raise ValueError("No audio files found in the music folder")

    # Filter out files with unknown duration
    usable = [f for f in files if f["duration_seconds"] > 0]
    if not usable:
        raise ValueError("No audio files with valid duration in the music folder")

    random.shuffle(usable)

    if num_tracks and num_tracks > 0:
        selected = usable[: min(num_tracks, len(usable))]
        return selected

    selected: List[dict] = []
    total = 0.0

    for f in usable:
        selected.append(f)
        total += f["duration_seconds"]
        if total >= target_seconds - tolerance:
            break

    if total < 60:
        raise ValueError(
            f"Not enough audio to build a video. "
            f"Total available: {format_duration(total)}"
        )
    return selected


# Test-friendly alias.
_select_tracks = select_tracks


async def set_project_tracks(
    session: AsyncSession,
    project_id: int,
    asset_ids: list[int],
) -> None:
    """Write ordered track rows into ``video_project_tracks``.

    Clears any existing rows for the project then inserts one row per
    ``asset_id`` at zero-based positions.  Also keeps the legacy
    ``music_asset_ids`` JSON column in sync so readers that haven't been
    migrated yet continue to work.

    Must be called **inside an open session** after the VideoProject row
    has been flushed (so its PK is assigned).  The caller is responsible
    for committing the session.
    """
    from app.models.video_project import VideoProjectTrack

    # Clear stale rows — handles the "re-generate" case where a project's
    # track list is replaced after initial creation.
    await session.execute(
        delete(VideoProjectTrack).where(VideoProjectTrack.project_id == project_id)
    )
    for position, asset_id in enumerate(asset_ids):
        session.add(
            VideoProjectTrack(
                project_id=project_id,
                asset_id=asset_id,
                position=position,
            )
        )
    # Mirror into the JSON column (backward compat for reads that still
    # use music_asset_ids — will be removed once all reads are migrated).
    proj = await session.get(VideoProject, project_id)
    if proj:
        proj.music_asset_ids = list(asset_ids)


async def get_project_track_ids(
    session: AsyncSession,
    project: VideoProject,
) -> list[int]:
    """Return ordered track asset IDs for a project.

    Prefers the ``video_project_tracks`` table (CASCADE-safe; deleted
    assets are automatically pruned).  Falls back to the ``music_asset_ids``
    JSON column for projects created before the m2m migration, then to the
    legacy single-track ``music_asset_id`` FK.
    """
    from app.models.video_project import VideoProjectTrack

    rows = await session.execute(
        select(VideoProjectTrack.asset_id)
        .where(VideoProjectTrack.project_id == project.id)
        .order_by(VideoProjectTrack.position)
    )
    ids = [row[0] for row in rows]
    if ids:
        return ids

    # Fallback for pre-migration rows.
    if project.music_asset_ids:
        return [int(x) for x in project.music_asset_ids]
    if project.music_asset_id:
        return [project.music_asset_id]
    return []


async def select_image_from_library(
    channel_id: int,
    pinned_id: Optional[int] = None,
    *,
    include_used: bool = False,
    require_grouped: bool = False,  # deprecated — folder pairing was ripped out
) -> Optional[Asset]:
    """Pick a background asset (image OR looping video) from the channel
    library.

    When ``pinned_id`` is set and points at a real Asset for this
    channel, returns it directly — used for the dashboard preview that
    rotates daily and lets the user lock a specific background.

    Otherwise picks at random from EVERY background candidate the
    channel has — images with ``role='background'`` (or NULL for
    pre-migration rows) plus all ``asset_type='video'`` looping bgs.
    No "avoid recently-used" filter: the operator asked for
    background reuse to be normal and supported. The compose pipeline
    detects the file extension downstream and branches to the
    chromakey-overlay path for video backgrounds, so either kind can
    drive a render.

    ``include_used`` and ``require_grouped`` are kept for backwards
    compatibility with existing callers but are now no-ops — there's
    no rotation logic to bypass and folder pairing is gone (Phase 0
    of the farm-redesign roadmap).
    """
    _ = (include_used, require_grouped)  # silence unused-arg warnings
    async with async_session() as session:
        if pinned_id:
            pinned = await session.get(Asset, pinned_id)
            if (
                pinned
                and pinned.channel_id == channel_id
                and pinned.asset_type in ("image", "video")
                # If role is set on an image, only "background" is a
                # valid pin. Allow None (unclassified, pre-migration).
                and (
                    pinned.asset_type == "video"
                    or pinned.role in (None, "background")
                )
            ):
                return pinned

        # Two queries OR-ed: images that are roled as backgrounds
        # (including legacy NULL) + all videos (videos don't use role).
        result = await session.execute(
            select(Asset).where(
                Asset.channel_id == channel_id,
                or_(
                    and_(
                        Asset.asset_type == "image",
                        or_(Asset.role == "background", Asset.role.is_(None)),
                    ),
                    Asset.asset_type == "video",
                ),
            )
        )
        candidates: List[Asset] = list(result.scalars().all())

        if not candidates:
            return None

    chosen = random.choice(candidates)
    logger.info(
        "Quick generate: selected background '%s' (id=%d, role=%s, type=%s)",
        chosen.filename, chosen.id, chosen.role, chosen.asset_type,
    )
    return chosen


async def generate_metadata(
    config: dict,
    tracks: List[dict],
    total_duration: float,
) -> dict:
    """Generate title, description, and tags from templates or Claude.

    Picks the path based on ``config['metadata_mode']`` — ``"claude"``
    routes through the house-style Claude prompt, anything else
    (default) uses the template strings on the channel/preset.
    """
    now = datetime.now()
    date_str = now.strftime("%B %d, %Y")
    short_date = now.strftime("%Y-%m-%d")
    channel_name = config["channel_name"]
    track_count = len(tracks)

    # Build tracklist with timestamps. Prefer the readable Asset.title
    # ("First Drops on Bamboo Leaves") over the storage filename
    # ("yt_y5_PjS9X4FQ_01_First Drops on Bamboo Leaves.mp3") so the
    # description doesn't expose YouTube IDs and underscores.
    tracklist_lines: List[str] = []
    running_time = 0.0
    for t in tracks:
        ts = format_duration(running_time)
        name = (t.get("title") or "").strip() or Path(t["filename"]).stem
        tracklist_lines.append(f"{ts} - {name}")
        running_time += t["duration_seconds"]
    tracklist = "\n".join(tracklist_lines)

    template_vars = {
        "date": date_str,
        "short_date": short_date,
        "channel_name": channel_name,
        "track_count": str(track_count),
        "total_duration": format_duration(total_duration),
        "tracklist": tracklist,
        "niche": config.get("channel_niche", ""),
    }

    if config["metadata_mode"] == "claude":
        return await _generate_metadata_claude(config, template_vars, tracks)

    # Template mode
    title = (config.get("title_template") or "{channel_name} Mix - {date}").format(
        **template_vars
    )
    desc = (
        config.get("description_template")
        or "{channel_name} - {track_count} tracks\n\nTracklist:\n{tracklist}"
    ).format(**template_vars)

    tags_raw = config.get("tags_template") or ""
    try:
        tags = (
            json.loads(tags_raw)
            if tags_raw.startswith("[")
            else [t.strip() for t in tags_raw.split(",") if t.strip()]
        )
    except json.JSONDecodeError:
        tags = [t.strip() for t in tags_raw.split(",") if t.strip()]

    return {"title": title[:100], "description": desc, "tags": tags}


async def _generate_metadata_claude(
    config: dict, template_vars: dict, tracks: List[dict]
) -> dict:
    """Generate metadata via the house-style Claude prompt.

    Routes through ``claude_cli_service.generate_metadata`` which
    injects the channel's house style block (the
    ``『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』☯ ... | ...`` title format, the structured
    description with hook → playlist pitch → 'Perfect for:' →
    TRACKLIST → CTA → hashtags, and the multilingual tag mix). Falls
    back to template substitution only if Claude is unreachable.

    Also pulls live keyword-research signals (autocomplete + trending
    tags) so the output rides current YouTube searches.
    """
    try:
        from app.services.claude_cli_service import (
            claude_cli_service as claude_service,
        )
        from app.services.keyword_research_service import keyword_research_service

        channel_id = config.get("channel_id")
        niche = config.get("channel_niche") or ""
        track_names = [
            (t.get("title") or "").strip() or Path(t["filename"]).stem
            for t in tracks
        ]

        # Pull the channel row so claude_cli_service can read its
        # ai_voice + ai_example_* fields when building the system prompt.
        # ``style_block(channel)`` falls back to a generic brief when
        # those fields are empty, so a missing channel here is recoverable.
        channel_obj = None
        if channel_id:
            from app.database import async_session
            from app.models import Channel as _Channel
            async with async_session() as _s:
                channel_obj = await _s.get(_Channel, int(channel_id))

        # Pull live research signals (cached per channel/day)
        research_block: Optional[str] = None
        try:
            seeds: List[str] = []
            if niche:
                seeds.append(niche.replace("_", " "))
            for n in track_names[:2]:
                seeds.append(n.split(" - ")[-1][:40])
            research = await keyword_research_service.research(
                channel_id=channel_id or 0,
                niche=niche,
                seed_keywords=seeds,
            )
            research_block = keyword_research_service.format_for_prompt(research)
        except Exception:
            logger.warning("keyword research failed in automation; continuing")

        additional_context = (
            f"Track count: {template_vars['track_count']}; "
            f"total duration: {template_vars['total_duration']}.\n"
            f"Tracklist (with timestamps):\n{template_vars['tracklist']}"
        )
        if config.get("claude_prompt"):
            additional_context += f"\n\nExtra instructions:\n{config['claude_prompt']}"

        # ── Recent titles avoidance ──────────────────────────────────────
        # Inject the channel's last 12 titles so Claude knows what it
        # already shipped and doesn't pick the same hook/scene/phrase
        # again. The previous design relied on a voice rule that said
        # 'vary the verb so a 12-upload window doesn't repeat' — but
        # Claude is stateless per request, so without seeing the actual
        # recent titles it has no way to enforce that. Operator-reported
        # bug: YomiBeats produced 'drift with me' three runs in a row.
        try:
            from app.models import VideoProject
            async with async_session() as _recent_session:
                recent_rows = await _recent_session.execute(
                    select(VideoProject.youtube_title)
                    .where(
                        VideoProject.channel_id == channel_id,
                        VideoProject.youtube_title.isnot(None),
                    )
                    .order_by(VideoProject.id.desc())
                    .limit(12)
                )
                recent_titles = [
                    t for (t,) in recent_rows.all()
                    if t and t.strip()
                ]
            if recent_titles:
                additional_context += (
                    "\n\nRECENT TITLES (last 12 — do NOT repeat any "
                    "hook, phrase, scene, or verb pattern from these; "
                    "pick something the audience hasn't seen recently):\n"
                    + "\n".join(f"- {t}" for t in recent_titles)
                )
                logger.info(
                    "Recent-titles avoidance: %d titles fed to prompt",
                    len(recent_titles),
                )
        except Exception:
            logger.exception(
                "Recent-titles avoidance: failed to load (non-fatal)",
            )

        # Phase 3 — title-token bandit. The bandit recompute is run by
        # the scheduler after every snapshot refresh; here we just
        # READ its current recommendations and append them to the
        # additional_context as a HARD CONSTRAINT block. The
        # generator (Claude) sees the must-include and banned lists
        # and is instructed to honour them. Cold-start (channel with
        # < 8 videos in snapshots) returns empty lists so this
        # appends nothing — the channel's voice example remains the
        # only style anchor.
        try:
            from app.services.title_bandit_service import get_pool

            # Phase 3: pull title + description + tag pools and write
            # a single combined "performance data" block. Each pool is
            # independent — a channel may have learned which TAGS
            # convert without yet having enough TITLE data, or vice
            # versa.
            title_pool = await get_pool(channel_id or 0, kind="title")
            desc_pool = await get_pool(channel_id or 0, kind="description")
            tag_pool = await get_pool(channel_id or 0, kind="tag")

            block_lines: List[str] = []
            if title_pool["must_include"]:
                block_lines.append(
                    "Title MUST include AT LEAST ONE of these proven "
                    "high-performing words: "
                    + ", ".join(title_pool["must_include"])
                )
            if title_pool["banned"]:
                block_lines.append(
                    "Title MUST NOT use any of these (they correlate "
                    "with poor performance on this channel): "
                    + ", ".join(title_pool["banned"])
                )
            if title_pool["explore_pool"]:
                block_lines.append(
                    "Optional title exploration words (pick ONE if it "
                    "fits naturally): "
                    + ", ".join(title_pool["explore_pool"])
                )
            if desc_pool["must_include"]:
                block_lines.append(
                    "Description top section MUST contain at least one "
                    "of these phrases that correlate with retention: "
                    + ", ".join(desc_pool["must_include"])
                )
            if desc_pool["banned"]:
                block_lines.append(
                    "Description SHOULD AVOID these words (they "
                    "correlate with poor retention): "
                    + ", ".join(desc_pool["banned"])
                )
            if tag_pool["must_include"]:
                block_lines.append(
                    "Tags MUST include 3-5 from these winners: "
                    + ", ".join(tag_pool["must_include"])
                )
            if tag_pool["banned"]:
                block_lines.append(
                    "Tags MUST NOT include any of these (poor "
                    "performance on this channel): "
                    + ", ".join(tag_pool["banned"])
                )
            if tag_pool["explore_pool"]:
                block_lines.append(
                    "Tags may include 1-2 from this exploration pool "
                    "to keep learning: "
                    + ", ".join(tag_pool["explore_pool"])
                )
            if block_lines:
                additional_context += (
                    "\n\nPerformance-derived constraints (bandit):\n- "
                    + "\n- ".join(block_lines)
                )
                logger.info(
                    "Bandit pools channel=%d title.must=%d desc.must=%d tag.must=%d",
                    channel_id,
                    len(title_pool["must_include"]),
                    len(desc_pool["must_include"]),
                    len(tag_pool["must_include"]),
                )
        except Exception:
            # Bandit is best-effort. A failure here should never break
            # metadata generation — channel voice remains the fallback.
            logger.exception(
                "Bandit pool fetch failed (non-fatal); falling back to "
                "channel voice only",
            )

        metadata = await claude_service.generate_metadata(
            channel_name=config["channel_name"],
            niche=niche,
            additional_context=additional_context,
            research_block=research_block,
            track_names=track_names,
            brand_identity=config.get("brand_identity"),
            target_audience=config.get("target_audience"),
            channel=channel_obj,
            terse=bool(config.get("terse_metadata", False)),
        )

        # Inject the actual tracklist into the description so YouTube
        # gets timestamped chapter rows. Claude is told to leave the
        # section blank — but even when Claude varies the spacing
        # (e.g. `TRACKLIST` immediately followed by the closing
        # divider, or extra blank lines, or trailing whitespace), the
        # tracklist must still land. Approach: find the line containing
        # the literal token "TRACKLIST" and insert our text directly
        # after that line. Idempotent — if the first track-line is
        # already present we skip.
        desc = metadata.get("description") or ""
        tracklist_text = (template_vars.get("tracklist") or "").strip()
        if desc and tracklist_text:
            from app.utils.description_parts import is_tracklist_anchor

            first_track_line = tracklist_text.splitlines()[0]
            if first_track_line not in desc:
                desc_lines = desc.splitlines()
                anchor_idx: Optional[int] = None
                for i, line in enumerate(desc_lines):
                    if is_tracklist_anchor(line):
                        anchor_idx = i
                        break
                if anchor_idx is not None:
                    insert_at = anchor_idx + 1
                    while (
                        insert_at < len(desc_lines)
                        and not desc_lines[insert_at].strip()
                    ):
                        insert_at += 1
                    new_lines = (
                        desc_lines[:anchor_idx + 1]
                        + [""]
                        + tracklist_text.splitlines()
                        + [""]
                        + desc_lines[insert_at:]
                    )
                    desc = "\n".join(new_lines)
                else:
                    # No anchor in the description → the channel
                    # voice deliberately omits a tracklist section
                    # (Isekai Radio, etc.). Don't force-append — leave
                    # the description as Claude wrote it.
                    logger.info(
                        "No tracklist anchor in styled description — "
                        "skipping tracklist injection (channel omits "
                        "chapters by design).",
                    )
            metadata["description"] = desc
        return metadata
    except Exception:
        logger.exception(
            "Styled Claude metadata generation failed, falling back to template"
        )

    # Fallback to template (Claude unreachable / timed out). Operator
    # bug 2026-05-19: the previous fallback called ``.format(**vars)``
    # on operator-defined ``title_template`` / ``description_template``.
    # For channels like YomiBeats, those fields are HUMAN-FACING
    # REFERENCES that contain placeholders like ``{2-4 word conversational
    # hook}`` and ``{KW1}`` that don't exist in template_vars — so
    # .format() raised KeyError, the preview endpoint (which only
    # catches ValueError) 500'd, and the operator saw "timeout" with no
    # fallback rendered. Use a safe formatter that leaves unknown
    # placeholders as literal text, and on any other crash fall back to
    # a hardcoded minimal shape so the preview always renders something.
    def _safe_format(tpl: str, vars: dict) -> str:
        """``str.format`` but unknown ``{placeholders}`` are kept as-is
        instead of raising KeyError. Also tolerates literal ``{`` / ``}``
        in the template that aren't intended as placeholders."""
        import string
        class _Default(dict):
            def __missing__(self, key: str) -> str:
                return "{" + key + "}"
        try:
            return string.Formatter().vformat(tpl, (), _Default(vars))
        except Exception:
            # Any remaining parse error (e.g. unmatched braces) — bail
            # out to a tiny safe template that uses only known keys.
            return f"{vars.get('channel_name', '')} - {vars.get('short_date', '')}"

    try:
        title = _safe_format(
            config.get("title_template") or "{channel_name} Mix - {short_date}",
            template_vars,
        )
        desc = _safe_format(
            config.get("description_template")
            or "{channel_name} - {track_count} tracks ({total_duration})\n\nTracklist:\n{tracklist}",
            template_vars,
        )
        tags_raw = config.get("tags_template") or ""
        try:
            tags = (
                json.loads(tags_raw)
                if tags_raw.startswith("[")
                else [t.strip() for t in tags_raw.split(",") if t.strip()]
            )
        except json.JSONDecodeError:
            tags = [t.strip() for t in tags_raw.split(",") if t.strip()]
        return {"title": title[:100], "description": desc, "tags": tags}
    except Exception:
        # Last-ditch: minimal hardcoded shape so the preview endpoint
        # NEVER 500s on metadata generation. Operator sees placeholder
        # metadata + can regenerate after compose.
        logger.exception("Template fallback also failed — using minimal metadata")
        return {
            "title": f"{template_vars.get('channel_name', '')} - {template_vars.get('short_date', '')}",
            "description": (
                f"{template_vars.get('channel_name', '')}\n\n"
                f"Tracklist:\n{template_vars.get('tracklist', '')}"
            ),
            "tags": [],
        }
