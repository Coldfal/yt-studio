from __future__ import annotations

import json
import logging
from typing import Optional

from fastapi import APIRouter, Depends, File, Form, HTTPException, Response, UploadFile
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.models import Asset, VideoProject
from app.schemas.video_project import ProjectCreate, ProjectUpdate, ProjectResponse
from app.utils.file_utils import save_upload_file

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/projects", tags=["projects"])

# YouTube's docs say custom thumbnails up to 2 MiB. We allow a hair more
# than the JPEG quality 0.92 typically produces (~250-400 KB) so the
# server doesn't reject something the canvas just emitted, but cap before
# we hit the 2 MiB hard limit.
_MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024  # 2 MiB
_ALLOWED_THUMBNAIL_MIME = {"image/jpeg", "image/png"}


@router.get("/", response_model=list[ProjectResponse])
async def list_projects(
    channel_id: Optional[int] = None,
    status: Optional[str] = None,
    db: AsyncSession = Depends(get_db),
) -> list[ProjectResponse]:
    stmt = select(VideoProject)
    if channel_id is not None:
        stmt = stmt.where(VideoProject.channel_id == channel_id)
    if status is not None:
        stmt = stmt.where(VideoProject.status == status)

    result = await db.execute(stmt)
    projects = result.scalars().all()
    return [ProjectResponse.model_validate(p) for p in projects]


@router.post("/", response_model=ProjectResponse, status_code=201)
async def create_project(
    body: ProjectCreate,
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    project = VideoProject(**body.model_dump())
    db.add(project)
    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.get("/{project_id}", response_model=ProjectResponse)
async def get_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    project = await db.get(VideoProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return ProjectResponse.model_validate(project)


@router.put("/{project_id}", response_model=ProjectResponse)
async def update_project(
    project_id: int,
    body: ProjectUpdate,
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    from app.models.channel import Channel as ChannelModel

    project = await db.get(VideoProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    update_data = body.model_dump(exclude_unset=True)
    for field, value in update_data.items():
        setattr(project, field, value)

    # Project memory: when the user selects a folder for this project,
    # remember it on the channel so the next New Video wizard pre-fills it.
    if "music_folder_path" in update_data and update_data["music_folder_path"]:
        channel = await db.get(ChannelModel, project.channel_id)
        if channel:
            channel.last_music_folder_path = update_data["music_folder_path"]
            channel.last_music_source = "folder"

    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.delete("/{project_id}", status_code=204, response_class=Response)
async def delete_project(
    project_id: int,
    db: AsyncSession = Depends(get_db),
):
    project = await db.get(VideoProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    await db.delete(project)
    await db.commit()


@router.post("/{project_id}/thumbnail")
async def save_thumbnail(
    project_id: int,
    file: UploadFile = File(...),
    editor_state: Optional[str] = Form(None),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Persist a rendered thumbnail JPEG + editor state for a project.

    The frontend's ThumbnailStep renders its canvas to a JPEG blob and POSTs
    here. We save the JPEG as a new ``asset_type='image'`` asset (so it shows
    up in the channel image library too — handy for reuse) and link it to
    the project via ``thumbnail_asset_id``. The existing YouTube upload path
    in ``task_runner._handle_youtube_upload`` already resolves
    ``thumbnail_asset_id`` → filepath and passes it to
    ``youtube.thumbnails().set()``; no other change needed.

    The ``editor_state`` JSON is stored on the project so re-entering the
    wizard's Thumbnail step restores the user's layers, fonts, and effect
    presets. Source of truth for what YouTube shows is the JPEG itself.
    """
    project = await db.get(VideoProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    if file.content_type not in _ALLOWED_THUMBNAIL_MIME:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Thumbnail must be JPEG or PNG; got {file.content_type!r}."
            ),
        )

    content = await file.read()
    if len(content) > _MAX_THUMBNAIL_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Thumbnail is {len(content)} bytes — YouTube caps custom "
                f"thumbnails at {_MAX_THUMBNAIL_BYTES} (2 MiB). Re-encode at "
                "a lower quality or smaller dimensions."
            ),
        )

    # Pick the extension off the mime type so re-encode-by-mistake doesn't
    # land a .png inside a .jpg wrapper.
    ext = "jpg" if file.content_type == "image/jpeg" else "png"
    filename = f"thumb_p{project_id}.{ext}"
    filepath, file_size = save_upload_file(
        project.channel_id, "image", filename, content
    )

    asset = Asset(
        channel_id=project.channel_id,
        asset_type="image",
        role="thumbnail",
        source="generated",
        filename=filename,
        filepath=filepath,
        file_size=file_size,
        mime_type=file.content_type,
        title=f"Thumbnail for project {project_id}",
    )
    db.add(asset)
    await db.flush()

    project.thumbnail_asset_id = asset.id
    if editor_state is not None:
        try:
            project.thumbnail_editor_state = json.loads(editor_state)
        except json.JSONDecodeError as exc:
            raise HTTPException(
                status_code=400,
                detail=f"editor_state is not valid JSON: {exc}",
            ) from exc

    await db.commit()
    await db.refresh(asset)

    logger.info(
        "Saved thumbnail for project %d: asset=%d filepath=%s (%d bytes)",
        project_id, asset.id, filepath, file_size,
    )
    return {
        "asset_id": asset.id,
        "filepath": filepath,
        "file_url": f"/files/{filepath}",
        "file_size": file_size,
    }


# ── Translations ────────────────────────────────────────────────────
# Default set we ship — kept narrow on purpose so a single Claude call
# stays cheap. Caller can override via the request body.
DEFAULT_TRANSLATION_LANGS = ["en", "ja", "zh-Hans", "ko", "es"]


@router.post("/{project_id}/generate-translations", response_model=ProjectResponse)
async def generate_translations(
    project_id: int,
    body: Optional[dict] = None,
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    """Generate localised title + description for the project.

    Body (all optional)::

        {
          "languages": ["ja", "zh-Hans", "ko", "es"],   // override defaults
          "merge": true                                  // keep existing langs
                                                         // not in this request
        }

    Reads the project's English ``youtube_title`` + the "top" of
    ``youtube_description`` (everything before the TRACKLIST), sends
    them to Claude with a localisation-focused prompt, and saves the
    result as ``youtube_translations``.
    """
    from app.models.channel import Channel as ChannelModel
    from app.services.claude_cli_service import (
        ClaudeCliError,
        claude_cli_service,
    )
    from app.utils.description_parts import split_top_and_rest

    project = await db.get(VideoProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")

    title = (project.youtube_title or project.title or "").strip()
    if not title:
        raise HTTPException(
            status_code=400,
            detail="Project has no YouTube title to translate yet. "
            "Generate metadata first.",
        )

    description_top, _rest = split_top_and_rest(project.youtube_description or "")
    if not description_top.strip():
        # Fall back to the whole description if no anchor matched.
        description_top = (project.youtube_description or "").strip()

    body = body or {}
    languages = body.get("languages") or DEFAULT_TRANSLATION_LANGS
    if not isinstance(languages, list) or not all(isinstance(c, str) for c in languages):
        raise HTTPException(status_code=400, detail="`languages` must be a list of strings")
    merge = bool(body.get("merge", False))

    channel = await db.get(ChannelModel, project.channel_id)
    niche = (channel.niche if channel else None) or None
    # Use the channel's master_language as the SOURCE language so the
    # translator prompt correctly describes the input. Also strip any
    # target that matches the source — translating ko→ko is a no-op
    # and the operator probably picked it from a stale UI list.
    source_language = (
        getattr(channel, "master_language", None) or "en"
    )
    requested = list(languages)
    languages = [c for c in languages if c and c != source_language]
    skipped = sorted(set(requested) - set(languages))
    if skipped:
        # Surface the dropped codes in the response so the UI can show
        # "skipped: ko (channel's master language)".
        pass  # logged below after we know if anything translated

    try:
        translations = await claude_cli_service.translate_metadata(
            title=title,
            description_top=description_top,
            target_languages=languages,
            niche=niche,
            source_language=source_language,
        )
    except ClaudeCliError as exc:
        raise HTTPException(status_code=502, detail=f"Translation failed: {exc}") from exc

    if not translations and not skipped:
        raise HTTPException(status_code=502, detail="Translator returned no usable output")
    if skipped:
        import logging
        logging.getLogger(__name__).info(
            "generate_translations: skipped same-as-master codes %s "
            "(channel master_language=%s)",
            skipped, source_language,
        )

    if merge and project.youtube_translations:
        merged = dict(project.youtube_translations)
        merged.update(translations)
        project.youtube_translations = merged
    else:
        project.youtube_translations = translations

    await db.commit()
    await db.refresh(project)
    return ProjectResponse.model_validate(project)


@router.post(
    "/{project_id}/push-translations-to-youtube",
    response_model=ProjectResponse,
)
async def push_translations_to_youtube(
    project_id: int,
    db: AsyncSession = Depends(get_db),
) -> ProjectResponse:
    """Push the project's saved translations to its already-uploaded
    YouTube video.

    Calls ``videos.update(part="snippet,localizations")`` on the
    existing video. Lets the operator add translations to old videos
    that were uploaded before the translation feature existed (or
    refresh translations on a recently-uploaded video without
    re-uploading the file).

    Returns 400 if the project hasn't been uploaded yet (no
    ``youtube_video_id``) or has no translations to push.
    """
    import asyncio
    import json as _json

    from google.oauth2.credentials import Credentials
    from googleapiclient.discovery import build as _gbuild

    from app.models.channel import Channel as ChannelModel
    from app.services.credentials_service import get_channel_youtube_credentials
    from app.utils.description_parts import build_localized_description

    project = await db.get(VideoProject, project_id)
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    if not project.youtube_video_id:
        raise HTTPException(
            status_code=400,
            detail=(
                "Project hasn't been uploaded yet — nothing on YouTube to update. "
                "Translations will be applied automatically on first upload."
            ),
        )
    if not project.youtube_translations:
        raise HTTPException(
            status_code=400,
            detail="No translations stored on this project. Generate them first.",
        )

    creds_json = await get_channel_youtube_credentials(db, project.channel_id)
    if not creds_json:
        raise HTTPException(
            status_code=400,
            detail=(
                "Channel isn't connected to YouTube. Reconnect on the channel "
                "page, then try again."
            ),
        )

    # Load the channel so we can use its master_language as
    # snippet.defaultLanguage on the videos.update payload. Falls back
    # to 'en' if the channel row is missing or the column is unset.
    project_channel = await db.get(ChannelModel, project.channel_id)
    master_language = (
        getattr(project_channel, "master_language", None) or "en"
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

    # Build the localizations payload — same logic as the upload flow:
    # translated top + English tracklist/hashtags.
    english_desc = project.youtube_description or ""
    english_title = project.youtube_title or project.title or ""
    raw_localizations: dict[str, dict[str, str]] = {}
    for code, entry in (project.youtube_translations or {}).items():
        if not isinstance(entry, dict):
            continue
        t = (entry.get("title") or "").strip()
        top = (entry.get("description") or "").strip()
        if not t and not top:
            continue
        raw_localizations[str(code)] = {
            "title": t or english_title,
            "description": (
                build_localized_description(top, english_desc) or top
            ),
        }

    # Run the same sanitiser the upload path uses — caps title at 100
    # UTF-16 units, description at 5000 chars, strips `<>`. YouTube's
    # `invalidVideoMetadata` error fires on any of these per-locale,
    # and the error message doesn't tell you which one.
    from app.services.youtube_service import youtube_service

    localizations = youtube_service._clean_localizations(raw_localizations)
    if not localizations:
        raise HTTPException(
            status_code=400,
            detail="All translation entries are empty after sanitisation.",
        )

    video_id = project.youtube_video_id

    # YouTube's snippet has plenty of READ-ONLY fields (publishedAt,
    # channelId, thumbnails, liveBroadcastContent, localized, etc.).
    # `videos.update` rejects the whole call with `invalidVideoMetadata`
    # if any of them ride along. Whitelist only the documented writable
    # subset: see https://developers.google.com/youtube/v3/docs/videos/update
    _WRITABLE_SNIPPET_FIELDS = (
        "title",
        "description",
        "tags",
        "categoryId",
        "defaultLanguage",
        "defaultAudioLanguage",
    )

    def _do_update() -> None:
        yt = _gbuild("youtube", "v3", credentials=credentials, cache_discovery=False)
        # Read the existing snippet → mutate → write back. We need
        # title/description/categoryId on the body even when only
        # localizations changed, because YouTube treats `snippet` as
        # an atomic unit on update.
        current = yt.videos().list(part="snippet", id=video_id).execute()
        items = current.get("items") or []
        if not items:
            raise RuntimeError(
                f"YouTube video {video_id} not found (may have been deleted)."
            )
        full_snippet = items[0]["snippet"]
        snippet = {
            k: full_snippet[k]
            for k in _WRITABLE_SNIPPET_FIELDS
            if k in full_snippet
        }
        # categoryId is required on update — if for some reason the
        # video had none (extremely rare), default to Music (10) since
        # that's our channel niche.
        if "categoryId" not in snippet:
            snippet["categoryId"] = "10"
        # `defaultLanguage` is what tells YouTube the localizations
        # apply to this video. Without it the API silently accepts the
        # localizations but never serves them. Sourced from
        # channel.master_language so Korean / Japanese / etc. channels
        # get the correct primary-language signal.
        snippet["defaultLanguage"] = master_language

        body = {
            "id": video_id,
            "snippet": snippet,
            "localizations": localizations,
        }
        yt.videos().update(part="snippet,localizations", body=body).execute()

    loop = asyncio.get_event_loop()
    try:
        await loop.run_in_executor(None, _do_update)
    except Exception as exc:
        raise HTTPException(
            status_code=502,
            detail=f"YouTube update failed: {exc}",
        ) from exc

    await db.refresh(project)
    return ProjectResponse.model_validate(project)


# ── Phase 7: standalone thumbnail upload ────────────────────────────


@router.post("/upload-thumbnail")
async def upload_thumbnail_standalone(
    channel_id: int = Form(...),
    file: UploadFile = File(...),
    db: AsyncSession = Depends(get_db),
) -> dict:
    """Save a rendered thumbnail JPEG/PNG as a standalone channel asset.

    Phase 7 of farm redesign — the Quick Generate preview drawer
    renders a fresh thumbnail from the channel preset's ``thumbnail_
    template`` and POSTs the resulting blob here BEFORE the
    VideoProject exists. The returned ``asset_id`` is then stitched
    into the approved_package's ``thumbnail.asset_id`` so the
    subsequent ``/quick-generate`` call links it to the new project.

    Differs from ``save_thumbnail`` (which requires a project_id) by
    being preview-time + project-agnostic. The created Asset is a
    role='thumbnail' image on the channel — same shape as everything
    else in the thumbnail library, so the operator can reuse it
    later if they want.
    """
    if file.content_type not in _ALLOWED_THUMBNAIL_MIME:
        raise HTTPException(
            status_code=400,
            detail=f"Thumbnail must be JPEG or PNG; got {file.content_type!r}.",
        )
    content = await file.read()
    if len(content) > _MAX_THUMBNAIL_BYTES:
        raise HTTPException(
            status_code=413,
            detail=(
                f"Thumbnail is {len(content)} bytes — YouTube caps "
                f"custom thumbnails at {_MAX_THUMBNAIL_BYTES} (2 MiB)."
            ),
        )

    from app.models import Channel
    if not await db.get(Channel, channel_id):
        raise HTTPException(status_code=404, detail="Channel not found")

    ext = "jpg" if file.content_type == "image/jpeg" else "png"
    # Suffix with a millisecond timestamp so concurrent renders don't
    # overwrite each other. Re-uploads from the same preview drawer
    # land as new asset rows (cheap; operator can prune later).
    from datetime import datetime as _dt
    stamp = _dt.utcnow().strftime("%Y%m%d_%H%M%S_%f")
    filename = f"thumb_tpl_{stamp}.{ext}"
    filepath, file_size = save_upload_file(
        channel_id, "image", filename, content,
    )
    asset = Asset(
        channel_id=channel_id,
        asset_type="image",
        role="thumbnail",
        source="generated_template",
        filename=filename,
        filepath=filepath,
        file_size=file_size,
        mime_type=file.content_type,
        title="Template-rendered thumbnail",
    )
    db.add(asset)
    await db.commit()
    await db.refresh(asset)
    logger.info(
        "Standalone thumbnail upload: asset=%d filepath=%s (%d bytes)",
        asset.id, filepath, file_size,
    )
    return {
        "asset_id": asset.id,
        "filepath": filepath,
        "file_url": f"/files/{filepath}",
        "file_size": file_size,
    }
