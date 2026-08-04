from __future__ import annotations

import json
import logging
import re
from typing import Any, List, Optional

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Asset, Channel, BackgroundTask, VideoProject
from app.schemas.task import TaskResponse
from app.workers.task_runner import task_runner

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/metadata", tags=["metadata"])


class MetadataGenerateRequest(BaseModel):
    project_id: int
    additional_context: Optional[str] = None


@router.post("/generate", response_model=TaskResponse, status_code=201)
async def generate_metadata(
    body: MetadataGenerateRequest,
    db: AsyncSession = Depends(get_db),
) -> TaskResponse:
    project = await db.get(VideoProject, body.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    task = BackgroundTask(
        task_type="metadata_generation",
        status="pending",
        project_id=project.id,
        channel_id=project.channel_id,
        result={
            "additional_context": body.additional_context,
        },
    )
    db.add(task)
    await db.commit()
    await db.refresh(task)

    await task_runner.enqueue(task.id)

    return TaskResponse.model_validate(task)


# ── AI template fill ──────────────────────────────────────────────────────


class FillTemplateRequest(BaseModel):
    project_id: int
    title_template: str
    description_template: str
    tag_count: int = 28
    """How many tags Claude should produce (defaults match the house-style
    multilingual tag mix — caller can override to ask for fewer/more)."""


class FillTemplateResponse(BaseModel):
    title: str
    description: str
    tags: List[str]


_PLACEHOLDER_RE = re.compile(r"\{[^{}\n]+\}")


def _extract_json(text: str) -> dict:
    """Tolerant JSON extractor — strips fenced code blocks if present."""
    s = (text or "").strip()
    if not s:
        raise ValueError("empty response")
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        pass
    m = re.search(r"```(?:json)?\s*\n?(.*?)\n?\s*```", s, re.DOTALL)
    if m:
        try:
            return json.loads(m.group(1).strip())
        except json.JSONDecodeError:
            pass
    a = s.find("{")
    b = s.rfind("}")
    if a != -1 and b > a:
        try:
            return json.loads(s[a : b + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError(f"could not parse JSON from response: {s[:300]}")


@router.post("/fill-template", response_model=FillTemplateResponse)
async def fill_template(
    body: FillTemplateRequest,
    db: AsyncSession = Depends(get_db),
) -> FillTemplateResponse:
    """Send templates to Claude, ask it to fill any ``{placeholder}`` blocks.

    The frontend pre-resolves the standard placeholders (``{channel_name}``,
    ``{tracklist}``, etc.) before sending. Anything that's still in
    ``{...}`` form is treated as a creative directive (e.g. "{POETIC
    PARAGRAPH MIXING ENGLISH AND JAPANESE}") and filled by Claude.

    Also generates tags so the caller can populate the Tags field.
    """
    project = await db.get(VideoProject, body.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    channel = await db.get(Channel, project.channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    # Build a track-name list (no durations — those are already in the
    # rendered tracklist if the template referenced {tracklist}).
    track_ids: list[int] = []
    if project.music_asset_ids:
        track_ids = list(project.music_asset_ids)
    elif project.music_asset_id:
        track_ids = [project.music_asset_id]
    track_names: list[str] = []
    track_assets: list[Asset] = []
    for tid in track_ids[:50]:  # cap so the prompt doesn't balloon
        a = await db.get(Asset, int(tid))
        if a:
            track_names.append(a.title or a.filename)
            track_assets.append(a)

    # Pre-build the timestamped tracklist now so we can inject it after
    # Claude returns. Same shape automation_service uses:
    #   "0:00 - First Drops on Bamboo Leaves"
    #   "3:42 - Rooftop, Slow Sunday"
    # If a track is missing duration_seconds we skip the timestamp for
    # that line — better than 0:00 stamps lying about the position.
    from app.services.automation_service._shared import format_duration

    tracklist_lines: list[str] = []
    running = 0.0
    for a in track_assets:
        ts = format_duration(running)
        name = (a.title or a.filename or "").strip()
        if not name:
            continue
        from pathlib import Path as _P
        if name == (a.filename or "") and "." in name:
            name = _P(name).stem
        tracklist_lines.append(f"{ts} - {name}")
        running += float(a.duration_seconds or 0.0)
    tracklist_text = "\n".join(tracklist_lines)

    # Channel context for the prompt
    brand = (channel.brand_identity or "").strip()
    audience = (channel.target_audience or "").strip()
    niche = channel.niche or ""

    has_title_placeholder = bool(_PLACEHOLDER_RE.search(body.title_template))
    has_desc_placeholder = bool(_PLACEHOLDER_RE.search(body.description_template))

    # If neither template has any creative placeholders left, we still need
    # to generate tags. Fall back to a tiny prompt.
    needs_creative = has_title_placeholder or has_desc_placeholder

    # ── Pull keyword research (cached per channel/day) ──────────────
    # This injects YouTube autocomplete + trending-tags signal into the
    # prompt so Claude anchors on real search terms. Falls back gracefully
    # if neither autocomplete nor the YouTube API is available.
    from app.services.keyword_research_service import keyword_research_service

    seed_keywords: list[str] = []
    if niche:
        seed_keywords.append(niche.replace("_", " "))
    if brand:
        seed_keywords.append(brand[:60])
    # First couple of track names also make decent seeds — they often
    # contain the artist/style language the audience already searches for.
    for n in track_names[:2]:
        seed_keywords.append(n.split(" - ")[-1][:40])

    try:
        research = await keyword_research_service.research(
            channel_id=channel.id,
            niche=niche,
            seed_keywords=seed_keywords,
        )
        research_block = keyword_research_service.format_for_prompt(research)
    except Exception as e:
        logger.warning("keyword research failed (non-fatal): %s", e)
        research_block = ""

    # Channel-aware style block. Reads the channel's ai_voice +
    # ai_example_* fields; falls back to a generic SEO brief when empty.
    from app.services.claude_cli_service import style_block

    # Framing prompt is intentionally terse and em-dash-free. The
    # channel's ``style_block`` carries the actual rules; surrounding
    # framing here used to use em dashes which Claude mirrored back into
    # outputs (defeating channel-level "no em dash" rules).
    system_prompt = (
        f"You are a senior YouTube SEO copywriter for the '{niche}' niche. "
        "You will be given research signals harvested from YouTube right "
        "now (autocomplete + top trending videos). Use those concrete "
        "keywords to anchor your output. Do not invent keywords from "
        "scratch.\n\n"
        f"{style_block(channel)}\n"
        "If the user provides title/description templates with {curly-brace} "
        "directives, fill each directive with original copy and keep the "
        "final output consistent with the house style above. If a template "
        "is empty or missing, generate the title and description from "
        "scratch using the house style.\n\n"
        "Preserve text outside curly braces verbatim. Replace each "
        "{placeholder} with its filled-in text. Do not keep the braces.\n\n"
        "Respond with VALID JSON ONLY. No markdown, no prose, no fences."
    )

    user_parts: list[str] = [
        f"Channel: {channel.name}",
        f"Niche: {niche}",
    ]
    if brand:
        user_parts.append(f"Brand identity: {brand}")
    if audience:
        user_parts.append(f"Target audience: {audience}")
    if track_names:
        sample = "\n".join(f"- {n}" for n in track_names[:20])
        user_parts.append(f"Track names (first {len(track_names[:20])}):\n{sample}")
    if research_block:
        user_parts.append("\n" + research_block)
    if body.title_template.strip():
        user_parts.append("\nTitle template:\n" + body.title_template)
    else:
        user_parts.append(
            "\nTitle template: (empty. Generate from scratch using the house style.)"
        )
    if body.description_template.strip():
        user_parts.append("\nDescription template:\n" + body.description_template)
    else:
        user_parts.append(
            "\nDescription template: (empty. Generate from scratch using the house style.)"
        )
    # NOTE: deliberately no per-channel typographic instructions here.
    # Earlier this section hardcoded YomiBeats' old format (`open with
    # 『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』☯`, "channel pitch paragraph", etc.) which
    # contradicted any updated channel voice rule. The single source of
    # truth is now ``style_block(channel)`` in the system prompt above.
    user_parts.append(
        f"\nReturn ONE JSON object with these keys:\n"
        f'- "title": follows the house style above. 100 UTF-16 code units max.\n'
        f"  If the house style above defines a fixed title template, follow it\n"
        f"  literally. Replace anything in {{curly braces}} with original\n"
        f"  copy anchored on real search terms from the research block.\n"
        f'- "description": follows the house style above. The "Channel voice\n'
        f"  instructions" + " block in the house style takes precedence over any\n"
        f"  generic structural advice if they ever conflict.\n"
        f'- "tags": array of at least {max(int(body.tag_count or 25), 25)} tag\n'
        f"  strings. Multilingual mix matching the house tags reference.\n"
        f"  No #, no quotes, no duplicates."
    )

    prompt = "\n".join(user_parts)

    # Lazy import so the rest of the app doesn't hard-depend on the CLI.
    from app.services.claude_cli_service import claude_cli_service, ClaudeCliError

    try:
        raw = await claude_cli_service.generate_raw(
            prompt=prompt,
            system_prompt=system_prompt,
        )
    except ClaudeCliError as exc:
        raise HTTPException(status_code=502, detail=f"Claude CLI error: {exc}") from exc

    try:
        data = _extract_json(raw)
    except ValueError as exc:
        raise HTTPException(
            status_code=502,
            detail=f"Could not parse Claude response: {exc}",
        ) from exc

    title = str(data.get("title") or body.title_template).strip()
    description = str(data.get("description") or body.description_template)
    raw_tags = data.get("tags") or []
    if isinstance(raw_tags, str):
        raw_tags = [t.strip() for t in raw_tags.split(",")]
    tags = [str(t).strip().lstrip("#").strip() for t in raw_tags if str(t).strip()]

    # Defensive: if Claude didn't fully fill placeholders, leave them in
    # place so the user notices rather than silently shipping {...}.
    if needs_creative:
        if _PLACEHOLDER_RE.search(title):
            logger.warning("title still has placeholders: %s", title)
        if _PLACEHOLDER_RE.search(description):
            logger.warning("description still has placeholders")

    # Cap title length per YouTube's 100-char rule
    if len(title) > 100:
        title = title[:97].rstrip() + "…"

    # ── Inject the tracklist into the description ──────────────────────
    # The system prompt tells Claude to leave a blank gap under the
    # "TRACKLIST" header — the wizard fills in the timestamps later
    # (here). Mirrors the automation_service flow so the dashboard
    # "Generate now" path and the wizard's "Generate with AI" produce
    # identical descriptions. Idempotent: if the first track-line is
    # already present we don't double-insert.
    if description and tracklist_text:
        from app.utils.description_parts import is_tracklist_anchor

        first_track_line = tracklist_text.splitlines()[0]
        if first_track_line not in description:
            desc_lines = description.splitlines()
            anchor_idx: int | None = None
            for i, line in enumerate(desc_lines):
                if is_tracklist_anchor(line):
                    anchor_idx = i
                    break
            if anchor_idx is not None:
                # Skip past blank lines after the header so we don't end
                # up with "TRACKLIST\n\n\n0:00 - ..." which renders weird.
                insert_at = anchor_idx + 1
                while (
                    insert_at < len(desc_lines)
                    and not desc_lines[insert_at].strip()
                ):
                    insert_at += 1
                new_lines = (
                    desc_lines[: anchor_idx + 1]
                    + [""]
                    + tracklist_text.splitlines()
                    + [""]
                    + desc_lines[insert_at:]
                )
                description = "\n".join(new_lines)
            else:
                # No TRACKLIST/CHAPTERS anchor in the description means
                # the channel's ai_voice deliberately omits a tracklist
                # section (e.g. Isekai Radio: "no chapters, just mood").
                # Don't force-append a tracklist the operator didn't ask
                # for — that produces uploads with stray "TRACKLIST"
                # blocks below the hashtags. Log it so the operator can
                # tell whether their voice rules and intent match.
                logger.info(
                    "No tracklist anchor in description for project %s — "
                    "skipping injection (channel intentionally omits tracklists).",
                    body.project_id,
                )

    return FillTemplateResponse(title=title, description=description, tags=tags)


# ---------------------------------------------------------------------------
# Keyword research preview — lets the UI show what's being fed to Claude.
# ---------------------------------------------------------------------------


class ResearchResponse(BaseModel):
    niche: str
    autocomplete: List[str]
    trending_titles: List[str]
    trending_tags: List[str]
    sources: List[str]
    fetched_at: float
    youtube_api_available: bool


@router.get("/research/{channel_id}", response_model=ResearchResponse)
async def get_keyword_research(
    channel_id: int,
    refresh: bool = False,
    db: AsyncSession = Depends(get_db),
) -> ResearchResponse:
    """Return cached (or freshly-fetched) keyword research for a channel.

    Useful for the UI to show "what Claude will see" before metadata is
    generated, and to let the user trigger a manual refresh.
    """
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    from app.services.keyword_research_service import (
        keyword_research_service,
        _resolve_api_key,
    )

    seed_keywords: list[str] = []
    if channel.niche:
        seed_keywords.append(channel.niche.replace("_", " "))
    if channel.brand_identity:
        seed_keywords.append(str(channel.brand_identity)[:60])
    if not seed_keywords:
        seed_keywords = [channel.name]

    research = await keyword_research_service.research(
        channel_id=channel.id,
        niche=channel.niche or "",
        seed_keywords=seed_keywords,
        force_refresh=refresh,
    )

    api_key_present = bool(await _resolve_api_key())
    return ResearchResponse(
        niche=research.get("niche", ""),
        autocomplete=research.get("autocomplete", []),
        trending_titles=research.get("trending_titles", []),
        trending_tags=research.get("trending_tags", []),
        sources=research.get("sources", []),
        fetched_at=research.get("fetched_at", 0.0),
        youtube_api_available=api_key_present,
    )
