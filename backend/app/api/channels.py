from __future__ import annotations

from typing import Any, Optional

from fastapi import APIRouter, Depends, HTTPException, Response
from pydantic import BaseModel
from sqlalchemy import select, func as sa_func
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Channel, VideoProject, Asset
from app.schemas.channel import (
    ChannelCreate,
    ChannelUpdate,
    ChannelResponse,
    ChannelStats,
)

router = APIRouter(prefix="/api/channels", tags=["channels"])


def _channel_to_response(channel: Channel) -> ChannelResponse:
    return ChannelResponse(
        id=channel.id,
        name=channel.name,
        niche=channel.niche,
        description=channel.description,
        youtube_channel_id=channel.youtube_channel_id,
        youtube_connected=channel.youtube_credentials_json is not None,
        default_prompt_prefix=channel.default_prompt_prefix,
        default_image_style=channel.default_image_style,
        brand_identity=channel.brand_identity,
        target_audience=channel.target_audience,
        default_tags=channel.default_tags,
        title_template=channel.title_template,
        description_template=channel.description_template,
        ai_voice=channel.ai_voice,
        ai_example_title=channel.ai_example_title,
        ai_example_description=channel.ai_example_description,
        ai_example_tags=channel.ai_example_tags,
        thumbnail_style_notes=channel.thumbnail_style_notes,
        upload_schedule=channel.upload_schedule,
        default_video_width=channel.default_video_width,
        default_video_height=channel.default_video_height,
        default_video_style=channel.default_video_style,
        master_language=channel.master_language,
        country=channel.country,
        channel_localizations=channel.channel_localizations,
        created_at=channel.created_at,
        updated_at=channel.updated_at,
    )


@router.get("/", response_model=list[ChannelResponse])
async def list_channels(
    db: AsyncSession = Depends(get_db),
) -> list[ChannelResponse]:
    result = await db.execute(select(Channel))
    channels = result.scalars().all()
    return [_channel_to_response(c) for c in channels]


@router.post("/", response_model=ChannelResponse, status_code=201)
async def create_channel(
    body: ChannelCreate,
    db: AsyncSession = Depends(get_db),
) -> ChannelResponse:
    channel = Channel(**body.model_dump())
    db.add(channel)
    await db.commit()
    await db.refresh(channel)
    return _channel_to_response(channel)


@router.get("/{channel_id}", response_model=ChannelResponse)
async def get_channel(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> ChannelResponse:
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    return _channel_to_response(channel)


@router.put("/{channel_id}", response_model=ChannelResponse)
async def update_channel(
    channel_id: int,
    body: ChannelUpdate,
    db: AsyncSession = Depends(get_db),
) -> ChannelResponse:
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    update_data = body.model_dump(exclude_unset=True)

    # Phase 2: snapshot pre-update voice fields BEFORE writing the new
    # values, so the operator can see "what did the voice look like
    # before this edit" and roll back. Only writes a row when an AI
    # voice field actually changed — saving the brand identity field
    # shouldn't pollute the voice timeline.
    from app.models.voice_profile import VoiceHistory
    voice_keys = {
        "ai_voice", "ai_example_title",
        "ai_example_description", "ai_example_tags", "notes",
    }
    incoming_voice = {k: update_data.get(k) for k in voice_keys if k in update_data}
    voice_changed = any(
        incoming_voice[k] != getattr(channel, k)
        for k in incoming_voice
    )
    if voice_changed:
        db.add(VoiceHistory(
            channel_id=channel.id,
            label=None,
            ai_voice=channel.ai_voice,
            ai_example_title=channel.ai_example_title,
            ai_example_description=channel.ai_example_description,
            ai_example_tags=channel.ai_example_tags,
            notes=channel.notes,
        ))

    for field, value in update_data.items():
        setattr(channel, field, value)

    await db.commit()
    await db.refresh(channel)
    return _channel_to_response(channel)


@router.post("/{channel_id}/sync-youtube-branding")
async def sync_youtube_branding(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Push the channel's country + localized channel title/description
    to the live YouTube channel via ``channels().update()``.

    Reads ``country``, ``channel_localizations`` and ``master_language``
    off the DB row (set them via the channel PUT endpoint first) and
    applies:

    - ``country``            -> ``brandingSettings.channel.country``
    - ``master_language``    -> ``snippet.defaultLanguage`` +
                                ``brandingSettings.channel.defaultLanguage``
    - ``channel_localizations`` -> ``localizations`` (per-language
                                channel title + description)

    Operator-triggered only — ``channels().update()`` costs 50 quota
    units. Mirrors the creds-load + run_in_executor + 502-wrap pattern
    of ``projects.py::push_translations_to_youtube``.
    """
    import asyncio
    import json as _json

    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build as _gbuild

    from app.services.credentials_service import get_channel_youtube_credentials
    from app.services.youtube_service import youtube_service

    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    if not channel.youtube_channel_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "Channel has no YouTube channel ID. Connect the channel "
                "to YouTube first, then try again."
            ),
        )
    if not channel.country and not channel.channel_localizations:
        raise HTTPException(
            status_code=400,
            detail=(
                "Nothing to sync — set a country or channel localizations "
                "on the channel first, then save."
            ),
        )

    creds_json = await get_channel_youtube_credentials(db, channel_id)
    if not creds_json:
        raise HTTPException(
            status_code=400,
            detail=(
                "Channel isn't connected to YouTube. Reconnect on the "
                "channel page, then try again."
            ),
        )
    try:
        creds_data = _json.loads(creds_json)
    except _json.JSONDecodeError as exc:
        raise HTTPException(
            status_code=400,
            detail=f"Stored YouTube credentials are not valid JSON: {exc}",
        ) from exc

    credentials = Credentials(
        token=creds_data.get("token"),
        refresh_token=creds_data.get("refresh_token"),
        token_uri=creds_data.get("token_uri", "https://oauth2.googleapis.com/token"),
        client_id=creds_data.get("client_id"),
        client_secret=creds_data.get("client_secret"),
        scopes=creds_data.get("scopes"),
    )

    master_language = channel.master_language or "en"
    country = (channel.country or "").strip().upper() or None
    youtube_channel_id = channel.youtube_channel_id

    # Sanitise localizations with the same caps the per-video path uses
    # (title <=100 UTF-16 units, `<>` stripped). Returns None when empty.
    localizations = youtube_service._clean_localizations(
        channel.channel_localizations
    )

    def _do_update() -> None:
        yt = _gbuild("youtube", "v3", credentials=credentials, cache_discovery=False)
        # brandingSettings.channel is treated as an atomic unit on
        # update — read the current object, mutate in place, write the
        # whole thing back. A partial body would clobber `keywords`,
        # `unsubscribedTrailer`, etc.
        current = yt.channels().list(
            part="brandingSettings,snippet", id=youtube_channel_id,
        ).execute()
        items = current.get("items") or []
        if not items:
            raise RuntimeError(
                f"YouTube channel {youtube_channel_id} not found "
                "(check the connected account)."
            )
        branding = items[0].get("brandingSettings", {}) or {}
        branding.setdefault("channel", {})
        if country:
            branding["channel"]["country"] = country
        branding["channel"]["defaultLanguage"] = master_language

        body: dict = {
            "id": youtube_channel_id,
            "brandingSettings": branding,
            "snippet": {"defaultLanguage": master_language},
        }
        parts = ["brandingSettings", "snippet"]
        if localizations:
            # Omitted when empty — sending an empty `localizations` with
            # the part present would CLEAR existing channel localizations.
            body["localizations"] = localizations
            parts.append("localizations")

        yt.channels().update(part=",".join(parts), body=body).execute()

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _do_update)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"YouTube channel update failed: {exc}",
        ) from exc

    return {
        "ok": True,
        "youtube_channel_id": youtube_channel_id,
        "country": country,
        "localizations_pushed": sorted((localizations or {}).keys()),
        "master_language": master_language,
    }


@router.delete("/{channel_id}", status_code=204, response_class=Response)
async def delete_channel(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
):
    """Delete a channel and every dependent row.

    SQLite can't ALTER FK ``ON DELETE`` rules after table creation, so
    several historical tables (assets, prompts, video_projects,
    automation_presets, live_streams, visualizer_presets) still have
    ``ON DELETE NO ACTION`` even though the models declare CASCADE.
    Newer tables (asset_folders, voice_history, asset_sets,
    video_analytics_snapshots, etc.) correctly cascade from the DB
    side. To avoid IntegrityErrors we explicitly delete every dependent
    row in the right order before deleting the channel itself.

    Order matters: rows that reference others (automation_runs,
    video_project_tracks) must go before the rows they reference.
    """
    from sqlalchemy import text as _sa_text
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    cid = {"cid": channel_id}

    # 1) automation_runs — reference automation_presets, video_projects,
    #    background_tasks (all owned by this channel). Delete first so
    #    later DELETEs on those tables don't hit dangling references.
    await db.execute(_sa_text(
        "DELETE FROM automation_runs WHERE preset_id IN "
        "(SELECT id FROM automation_presets WHERE channel_id = :cid)"
    ), cid)

    # 2) video_project_tracks (CASCADE-safe but explicit so the DELETE
    #    on video_projects below doesn't trip on partially-mapped rows).
    await db.execute(_sa_text(
        "DELETE FROM video_project_tracks WHERE project_id IN "
        "(SELECT id FROM video_projects WHERE channel_id = :cid)"
    ), cid)

    # 3) background_tasks owned by this channel. Not a Channel cascade
    #    target — just per-channel by ``channel_id``.
    await db.execute(_sa_text(
        "DELETE FROM background_tasks WHERE channel_id = :cid"
    ), cid)

    # 4) tables with NO ACTION FK back to channels. Order doesn't matter
    #    among these because their inter-table FKs either CASCADE
    #    (cleanly) or have been cleared above.
    for stmt in (
        "DELETE FROM video_projects WHERE channel_id = :cid",
        "DELETE FROM assets WHERE channel_id = :cid",
        "DELETE FROM prompts WHERE channel_id = :cid",
        "DELETE FROM automation_presets WHERE channel_id = :cid",
        "DELETE FROM live_streams WHERE channel_id = :cid",
        "DELETE FROM visualizer_presets WHERE channel_id = :cid",
    ):
        await db.execute(_sa_text(stmt), cid)

    # 5) Finally delete the channel itself. The remaining
    #    CASCADE-configured tables (asset_folders, video_analytics_
    #    snapshots, analytics_run_log, title_token_stats,
    #    video_manual_metrics, track_performance_stats, voice_history,
    #    metadata_feedback, asset_sets) clean up automatically.
    await db.delete(channel)
    await db.commit()


@router.get("/{channel_id}/stats", response_model=ChannelStats)
async def get_channel_stats(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> ChannelStats:
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    # Total projects
    total_projects_result = await db.execute(
        select(sa_func.count())
        .select_from(VideoProject)
        .where(VideoProject.channel_id == channel_id)
    )
    total_projects = total_projects_result.scalar() or 0

    # Projects by status
    status_result = await db.execute(
        select(VideoProject.status, sa_func.count())
        .where(VideoProject.channel_id == channel_id)
        .group_by(VideoProject.status)
    )
    projects_by_status = {row[0]: row[1] for row in status_result.all()}

    # Total assets
    total_assets_result = await db.execute(
        select(sa_func.count())
        .select_from(Asset)
        .where(Asset.channel_id == channel_id)
    )
    total_assets = total_assets_result.scalar() or 0

    return ChannelStats(
        total_projects=total_projects,
        projects_by_status=projects_by_status,
        total_assets=total_assets,
    )


@router.get("/{channel_id}/last-config")
async def get_channel_last_config(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Return the last-used composition config for project memory.

    When the user starts a new project for this channel the frontend can
    offer to pre-fill the Compose step with these settings.
    """
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")
    return {
        "composition_config": channel.last_composition_config,
        "visualizer_preset_id": channel.last_visualizer_preset_id,
        "music_source": channel.last_music_source,
        "image_asset_ids": channel.last_image_asset_ids,
        "music_folder_path": channel.last_music_folder_path,
    }


# ─── AI Voice — preview + sample ──────────────────────────────────────────


@router.get("/{channel_id}/ai-prompt-preview")
async def ai_prompt_preview(
    channel_id: int,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Render the FULL system + user prompt Claude will see for this channel.

    The user clicks this on the AI Voice tab to verify what
    instructions the metadata generation actually uses, with the
    channel's current ``ai_voice``/``ai_example_*`` fields applied.
    Pulls a recent project for realistic track names + research; falls
    back to synthetic placeholders when the channel has no projects yet.

    Read-only — does NOT call Claude.
    """
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    from app.services.claude_cli_service import style_block
    from app.services.keyword_research_service import keyword_research_service
    from app.models.video_project import VideoProject
    from app.models.video_project import VideoProjectTrack

    niche = channel.niche or ""

    # Find the channel's most recent project for realistic context.
    proj_stmt = (
        select(VideoProject)
        .where(VideoProject.channel_id == channel_id)
        .order_by(VideoProject.id.desc())
        .limit(1)
    )
    project = (await db.execute(proj_stmt)).scalar_one_or_none()

    track_names: list[str] = []
    if project:
        tracks_stmt = (
            select(Asset)
            .join(VideoProjectTrack, VideoProjectTrack.asset_id == Asset.id)
            .where(VideoProjectTrack.project_id == project.id)
            .order_by(VideoProjectTrack.position)
            .limit(8)
        )
        for asset in (await db.execute(tracks_stmt)).scalars().all():
            track_names.append(asset.title or asset.filename)

    if not track_names:
        track_names = [
            "Sample track A", "Sample track B", "Sample track C",
        ]

    # Best-effort research block — same path as the real generator.
    research_block = ""
    try:
        seeds: list[str] = []
        if niche:
            seeds.append(niche.replace("_", " "))
        if channel.brand_identity:
            seeds.append(str(channel.brand_identity)[:60])
        for n in track_names[:2]:
            seeds.append(n.split(" - ")[-1][:40])
        research = await keyword_research_service.research(
            channel_id=channel_id, niche=niche, seed_keywords=seeds,
        )
        research_block = keyword_research_service.format_for_prompt(research)
    except Exception:
        # Non-fatal — preview shows what the prompt looks like even
        # without research.
        pass

    # Mirror the system prompt in claude_cli_service.generate_metadata
    system_prompt = (
        f"You are a senior YouTube SEO copywriter for the '{niche}' niche. "
        "You ship metadata that ranks. You will be given research signals "
        "harvested from YouTube right now (autocomplete + top trending "
        "videos for this category). Use those concrete keywords — not "
        "speculation — to anchor the title, description, and tags.\n\n"
        f"{style_block(channel)}\n"
        "## Output rules (always)\n"
        "- NEVER stuff irrelevant keywords.\n"
        "- Respond with VALID JSON ONLY — no markdown fences, no prose, "
        "no explanation. The JSON must be the entire response."
    )

    # Mirror the user prompt
    user_parts: list[str] = [
        f"Channel name: {channel.name}",
        f"Niche: {niche}",
    ]
    if channel.brand_identity:
        user_parts.append(f"Brand identity: {channel.brand_identity}")
    if channel.target_audience:
        user_parts.append(f"Target audience: {channel.target_audience}")
    sample = "\n".join(f"- {t}" for t in track_names[:8])
    user_parts.append(f"Tracklist (first {len(track_names[:8])}):\n{sample}")
    if research_block:
        user_parts.append("\n" + research_block)
    user_parts.append(
        "\nReturn ONE JSON object with exactly these keys:\n"
        '- "title", "description", "tags", "category_id".'
    )
    user_prompt = "\n".join(user_parts)

    return {
        "system_prompt": system_prompt,
        "user_prompt": user_prompt,
        "based_on_project_id": project.id if project else None,
        "based_on_project_title": (project.title if project else None),
        "track_names_used": track_names,
        "research_available": bool(research_block),
        "channel_has_examples": bool(
            channel.ai_example_title
            or channel.ai_example_description
            or channel.ai_example_tags
        ),
    }


class _VoiceSampleRequest(BaseModel):
    """Optional voice override for the live-preview sample endpoint.

    Phase 2 of farm redesign. When supplied, the sample runs Claude
    with the OVERRIDDEN voice fields instead of the saved channel
    record — so the operator can see the effect of unsaved edits
    without having to save first.

    Any field left None falls back to the saved channel value. This
    lets the UI send only what the user touched.
    """

    niche: Optional[str] = None
    brand_identity: Optional[str] = None
    target_audience: Optional[str] = None
    ai_voice: Optional[str] = None
    ai_example_title: Optional[str] = None
    ai_example_description: Optional[str] = None
    ai_example_tags: Optional[str] = None
    notes: Optional[str] = None


class _OverlayChannel:
    """Channel-shaped dict wrapper for style_block(channel).

    ``style_block`` uses ``getattr(channel, "ai_voice", None)`` etc., so
    any object with the right attribute names works. We need this rather
    than mutating the real channel because: (a) we don't want to commit
    the override, and (b) we don't want to even POLLUTE the SQLAlchemy
    session with dirty fields that might later be flushed.
    """

    def __init__(self, real: Channel, override: dict):
        self._real = real
        self._override = override

    def __getattr__(self, name: str):
        if name in self._override and self._override[name] is not None:
            return self._override[name]
        return getattr(self._real, name)


@router.post("/{channel_id}/ai-sample")
async def ai_sample(
    channel_id: int,
    body: Optional[_VoiceSampleRequest] = None,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Run Claude with the channel's current AI voice + sample tracks.

    Lets the user iterate on the voice without composing a full video.
    Returns ``{title, description, tags}`` — same shape as a real
    ``generate_metadata`` call. Pulls real tracks from the most recent
    project; falls back to synthetic placeholders when none exist.

    Phase 2: when ``body`` carries voice overrides, the sample uses
    those instead of the saved record — so operators preview unsaved
    edits in real time.
    """
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    # Build an overlay so style_block sees the overridden values for
    # this one call. The real channel row is never mutated.
    override = body.model_dump(exclude_none=True) if body else {}
    channel_for_voice: Any = (
        _OverlayChannel(channel, override) if override else channel
    )

    from app.services.claude_cli_service import (
        claude_cli_service, ClaudeCliError,
    )
    from app.services.keyword_research_service import keyword_research_service
    from app.models.video_project import VideoProject, VideoProjectTrack

    # Resolve all voice-driving fields off the overlay so an override
    # is honored uniformly — niche, brand_identity, target_audience, AND
    # the ai_* family. Falls back to the saved channel via _OverlayChannel
    # when no override was sent.
    niche = getattr(channel_for_voice, "niche", None) or ""
    brand_identity = getattr(channel_for_voice, "brand_identity", None)
    target_audience = getattr(channel_for_voice, "target_audience", None)

    # Real tracks if available; placeholders otherwise.
    proj_stmt = (
        select(VideoProject)
        .where(VideoProject.channel_id == channel_id)
        .order_by(VideoProject.id.desc())
        .limit(1)
    )
    project = (await db.execute(proj_stmt)).scalar_one_or_none()

    track_names: list[str] = []
    if project:
        tracks_stmt = (
            select(Asset)
            .join(VideoProjectTrack, VideoProjectTrack.asset_id == Asset.id)
            .where(VideoProjectTrack.project_id == project.id)
            .order_by(VideoProjectTrack.position)
            .limit(8)
        )
        for asset in (await db.execute(tracks_stmt)).scalars().all():
            track_names.append(asset.title or asset.filename)
    if not track_names:
        track_names = [
            "Sample track A", "Sample track B", "Sample track C",
        ]

    research_block = None
    try:
        seeds: list[str] = []
        if niche:
            seeds.append(niche.replace("_", " "))
        if brand_identity:
            seeds.append(str(brand_identity)[:60])
        research = await keyword_research_service.research(
            channel_id=channel_id, niche=niche, seed_keywords=seeds,
        )
        research_block = keyword_research_service.format_for_prompt(research)
    except Exception:
        pass

    try:
        metadata = await claude_cli_service.generate_metadata(
            channel_name=channel.name,
            niche=niche,
            track_names=track_names,
            brand_identity=brand_identity,
            target_audience=target_audience,
            research_block=research_block,
            channel=channel_for_voice,
        )
    except ClaudeCliError as exc:
        raise HTTPException(
            status_code=502, detail=f"Claude CLI error: {exc}",
        ) from exc

    return {
        "title": metadata.get("title", ""),
        "description": metadata.get("description", ""),
        "tags": metadata.get("tags", []),
        "category_id": metadata.get("category_id", "10"),
        "based_on_project_id": project.id if project else None,
        "track_names_used": track_names,
    }


# ── Phase 2: Learn voice rules from a competitor URL ─────────────────


class _LearnFromUrlRequest(BaseModel):
    """Scraped competitor content + URL metadata.

    The frontend uses the Claude in Chrome MCP to open the URL, scroll
    the channel's video grid, and harvest titles + descriptions. This
    endpoint then runs Claude on the scraped block to PROPOSE voice
    rule additions. Nothing is auto-applied — the frontend renders the
    proposals with per-rule Apply / Skip controls.
    """

    url: str
    kind: str  # "channel" | "video"
    scraped_titles: list[str]
    scraped_descriptions: list[str] = []


@router.post("/{channel_id}/voice/learn-from-url")
async def learn_voice_from_url(
    channel_id: int,
    body: _LearnFromUrlRequest,
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Propose voice-rule additions based on a competitor's content."""
    channel = await db.get(Channel, channel_id)
    if not channel:
        raise HTTPException(status_code=404, detail="Channel not found")

    from app.services.voice_url_learner_service import propose_voice_rules
    from app.services.claude_cli_service import ClaudeCliError

    try:
        proposals = await propose_voice_rules(
            competitor_url=body.url,
            kind=body.kind,
            scraped_titles=body.scraped_titles or [],
            scraped_descriptions=body.scraped_descriptions or [],
            current_ai_voice=channel.ai_voice,
            current_example_title=channel.ai_example_title,
            channel_niche=channel.niche,
        )
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc))
    except ClaudeCliError as exc:
        raise HTTPException(status_code=502, detail=f"Claude error: {exc}")
    return proposals
