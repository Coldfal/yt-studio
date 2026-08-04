"""Library-mode automation flow.

Powers the dashboard one-click "Quick Generate" button. Differences
from ``execute_run``:

- Music + images come from the channel's already-imported library
  Assets (no folder scanning).
- Smart image dedup: prefers images that haven't been used in any
  published project on the channel yet.
- Visualizer config resolution layers explicit AutomationPreset →
  channel default VisualizerPreset → most-recent → composition_config
  → channel.last_composition_config → engine defaults.
- Always uses Claude for metadata (the styled house format the
  dashboard is built around). Cron runs go through ``execute_run``
  and honour the preset's ``metadata_mode``.
"""
from __future__ import annotations

import logging
from datetime import datetime
from typing import Any, Callable, Dict, List, Optional

from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.models import Asset, AutomationPreset, Channel, VideoProject
from app.services.credentials_service import get_channel_youtube_credentials

from ._shared import generate_metadata, select_image_from_library, select_tracks, set_project_tracks

logger = logging.getLogger(__name__)


async def build_quick_generate_package(
    channel_id: int,
    preset_id: Optional[int] = None,
    *,
    on_progress: Optional[Callable[[float, str], None]] = None,
) -> Dict[str, Any]:
    """Dry-run of Quick Generate: pick image + tracks + run metadata gen,
    return the full package — but DO NOT create a VideoProject, fire
    compose, or write anything except read-only DB queries.

    Used by the dashboard's "Preview before generate" drawer (Phase 1 of
    the farm-redesign roadmap). The package shape is also what the real
    ``run_quick_generate`` consumes when the operator clicks Generate
    after approving a preview — so we never re-pick between preview
    and fire, which would defeat the purpose.

    Returns a dict with:
      - image: {id, filename, file_url, role, asset_type}
      - music: {asset_ids, count, total_duration_seconds, sample_names}
      - thumbnail: {asset_id, file_url}  (from preset.default_thumbnail_asset_id)
      - metadata: {title, description, tags, category_id}
      - target_duration_seconds
      - auto_upload
      - auto_translate_languages
      - composition_config (the full dict that would be sent to the engine)
      - meta_config (the full dict that ``generate_metadata`` received)
      - diagnostics: {voice_rules_used: [...], bandit_winners_used: [...]}
    """
    def _progress(pct: float, msg: str) -> None:
        if on_progress:
            on_progress(pct, msg)

    # ── Pre-flight ────────────────────────────────────────────────
    from sqlalchemy import func as _sa_func
    async with async_session() as _pre:
        ch_check = await _pre.get(Channel, channel_id)
        if not ch_check:
            raise ValueError(f"Channel {channel_id} not found")
        music_count = (await _pre.execute(
            select(_sa_func.count(Asset.id)).where(
                Asset.channel_id == channel_id,
                Asset.asset_type == "music",
            )
        )).scalar_one()
        bg_count = (await _pre.execute(
            select(_sa_func.count(Asset.id)).where(
                Asset.channel_id == channel_id,
                Asset.asset_type.in_(("image", "video")),
            )
        )).scalar_one()
        if not music_count:
            raise ValueError(
                f"Channel '{ch_check.name}' has 0 music assets. "
                f"Upload some music in the Library first."
            )
        if not bg_count:
            raise ValueError(
                f"Channel '{ch_check.name}' has 0 background assets "
                f"(images or videos). Upload some in the Library first."
            )

    # ── Load settings ─────────────────────────────────────────────
    _progress(0.05, "Loading settings…")
    async with async_session() as session:
        channel = await session.get(Channel, channel_id)
        if not channel:
            raise ValueError(f"Channel {channel_id} not found")

        preset: Optional[AutomationPreset] = None
        if preset_id:
            preset = await session.get(AutomationPreset, preset_id)

        target_seconds: int = preset.target_duration_seconds if preset else 3600
        num_tracks: Optional[int] = preset.num_tracks if preset else None
        pinned_image_id: Optional[int] = (
            preset.next_image_asset_id if preset else None
        )
        auto_translate_languages: List[str] = list(
            preset.auto_translate_languages or []
        ) if preset else []
        visualizer_disabled: bool = bool(
            getattr(preset, "visualizer_disabled", False) if preset else False
        )
        video_style: str = preset.video_style if preset else "spectrum"
        override_fps: Optional[int] = preset.output_fps if preset else None

        # Visualizer config resolution (same priority order as real run).
        from app.models.visualizer_preset import VisualizerPreset
        base_composition: Dict[str, Any] = {}
        viz_preset = None

        if preset and preset.visualizer_preset_id:
            vp = await session.get(VisualizerPreset, preset.visualizer_preset_id)
            if vp and vp.channel_id == channel_id:
                viz_preset = vp
        if viz_preset is None:
            viz_result = await session.execute(
                select(VisualizerPreset).where(
                    VisualizerPreset.channel_id == channel_id,
                    VisualizerPreset.is_default == True,  # noqa: E712
                ).limit(1)
            )
            viz_preset = viz_result.scalar_one_or_none()
        if viz_preset is None:
            viz_result = await session.execute(
                select(VisualizerPreset)
                .where(VisualizerPreset.channel_id == channel_id)
                .order_by(VisualizerPreset.updated_at.desc())
                .limit(1)
            )
            viz_preset = viz_result.scalar_one_or_none()

        if viz_preset and isinstance(viz_preset.config, dict):
            base_composition = {
                **viz_preset.config,
                "presetId": viz_preset.preset_id,
            }
        elif preset and preset.composition_config:
            base_composition = dict(preset.composition_config)
        elif channel.last_composition_config:
            base_composition = dict(channel.last_composition_config)

        color_override: Dict[str, Any] = (
            preset.visualizer_color_override or {} if preset else {}
        )
        composition_config: Dict[str, Any] = {**base_composition, **color_override}
        if override_fps:
            composition_config["output_fps"] = int(override_fps)
        composition_config["visualizer_disabled"] = visualizer_disabled
        if preset:
            preset_particle_style = getattr(preset, "particle_style", None)
            preset_particle_density = getattr(preset, "particle_density", None)
            if preset_particle_style:
                composition_config["particles"] = True
                composition_config["particleStyle"] = preset_particle_style
            if preset_particle_density is not None:
                composition_config["particles"] = True
                composition_config["particleDensity"] = int(preset_particle_density)

        metadata_mode: str = (preset.metadata_mode or "claude") if preset else "claude"
        youtube_privacy: str = preset.youtube_privacy if preset else "private"
        youtube_category_id: str = (
            preset.youtube_category_id if preset else "10"
        )
        made_for_kids: bool = preset.made_for_kids if preset else False
        auto_upload: bool = preset.auto_upload if preset else False

        meta_config: Dict[str, Any] = dict(
            channel_id=channel_id,
            channel_name=channel.name,
            channel_niche=channel.niche or "",
            brand_identity=channel.brand_identity,
            target_audience=channel.target_audience,
            metadata_mode=metadata_mode,
            terse_metadata=bool(getattr(preset, "terse_metadata", False)) if preset else False,
            title_template=(preset.title_template if preset else None)
                or channel.title_template,
            description_template=(
                preset.description_template if preset else None
            ) or channel.description_template,
            tags_template=(
                preset.tags_template if preset else None
            ) or (
                (
                    ",".join(channel.default_tags)
                    if isinstance(channel.default_tags, list)
                    else str(channel.default_tags)
                )
                if channel.default_tags
                else None
            ),
            claude_prompt=(preset.claude_prompt if preset else None),
            youtube_privacy=youtube_privacy,
            youtube_category_id=youtube_category_id,
            made_for_kids=made_for_kids,
            auto_upload=auto_upload,
            # NOTE: youtube_creds omitted in preview — we never upload.
        )

    # ── Pick image (Phase 5: AssetSet-aware) ──────────────────────
    use_asset_sets: bool = bool(
        getattr(preset, "use_asset_sets", False) if preset else False
    )
    preview_set_thumb_id: Optional[int] = None
    if use_asset_sets:
        _progress(0.10, "Picking from Asset Sets…")
        from app.api.asset_sets import pick_random_active_set
        async with async_session() as _set_session:
            picked_set = await pick_random_active_set(_set_session, channel_id)
        if picked_set:
            async with async_session() as _img_session:
                image_asset = await _img_session.get(
                    Asset, picked_set.background_asset_id,
                )
            preview_set_thumb_id = picked_set.thumbnail_asset_id
        else:
            image_asset = None
    else:
        _progress(0.10, "Selecting image…")
        image_asset = await select_image_from_library(
            channel_id,
            pinned_id=pinned_image_id,
        )
    if not image_asset:
        raise ValueError(
            "No background images in the library. Upload at least one "
            "image tagged 'background' in the Library section first."
        )

    # ── Pick tracks ───────────────────────────────────────────────
    _progress(0.20, "Selecting tracks from library…")
    async with async_session() as session:
        music_result = await session.execute(
            select(Asset).where(
                Asset.channel_id == channel_id,
                Asset.asset_type == "music",
            )
        )
        music_assets: List[Asset] = list(music_result.scalars().all())
    if not music_assets:
        raise ValueError(
            "No music assets in the library. "
            "Upload some music tracks in the Library section first."
        )
    files = [
        {
            "filepath": str(settings.assets_dir / a.filepath),
            "filename": a.filename or a.title or f"track_{a.id}",
            "title": a.title or "",
            "duration_seconds": a.duration_seconds or 0,
        }
        for a in music_assets
    ]
    selected_files = select_tracks(
        files,
        target_seconds,
        num_tracks=num_tracks,
    )
    total_duration = sum(f["duration_seconds"] for f in selected_files)
    fp_to_id = {
        str(settings.assets_dir / a.filepath): a.id for a in music_assets
    }
    music_asset_ids = [
        fp_to_id[f["filepath"]]
        for f in selected_files
        if f["filepath"] in fp_to_id
    ]

    # ── Resolve sticky thumbnail (AssetSet wins, sticky as fallback) ──
    sticky_thumb_id: Optional[int] = None
    sticky_thumb_url: Optional[str] = None
    if preview_set_thumb_id is not None:
        async with async_session() as _verify:
            ta = await _verify.get(Asset, int(preview_set_thumb_id))
            if ta and ta.channel_id == channel_id and ta.asset_type == "image":
                sticky_thumb_id = ta.id
                sticky_thumb_url = f"/files/{ta.filepath}"
    if sticky_thumb_id is None and preset and getattr(
        preset, "default_thumbnail_asset_id", None,
    ):
        async with async_session() as _verify:
            ta = await _verify.get(Asset, int(preset.default_thumbnail_asset_id))
            if ta and ta.channel_id == channel_id and ta.asset_type == "image":
                sticky_thumb_id = ta.id
                sticky_thumb_url = f"/files/{ta.filepath}"

    # ── Generate metadata (real Claude call) ──────────────────────
    _progress(0.40, "Generating metadata…")
    metadata = await generate_metadata(meta_config, selected_files, total_duration)
    _progress(1.0, "Preview ready.")

    return {
        "channel_id": channel_id,
        "preset_id": preset_id,
        "image": {
            "id": image_asset.id,
            "filename": image_asset.filename,
            "filepath": image_asset.filepath,
            "file_url": f"/files/{image_asset.filepath}",
            "role": getattr(image_asset, "role", None),
            "asset_type": image_asset.asset_type,
        },
        "music": {
            "asset_ids": music_asset_ids,
            "count": len(music_asset_ids),
            "total_duration_seconds": total_duration,
            "sample_names": [
                (f.get("title") or f.get("filename") or "").strip()
                for f in selected_files[:8]
            ],
        },
        "thumbnail": {
            "asset_id": sticky_thumb_id,
            "file_url": sticky_thumb_url,
        },
        "metadata": {
            "title": metadata.get("title") or "",
            "description": metadata.get("description") or "",
            "tags": list(metadata.get("tags") or []),
            "category_id": metadata.get("category_id") or "10",
        },
        "target_duration_seconds": target_seconds,
        "auto_upload": auto_upload,
        "auto_translate_languages": auto_translate_languages,
        "video_style": video_style,
        "composition_config": composition_config,
        "diagnostics": {
            # Surface a compact "what the generator was told" so the
            # frontend can render a transparency line. We don't have a
            # structured channel-voice-rules object, but the metadata
            # response already came back through style_block() which
            # consumes channel.ai_voice + ai_example_* + notes — the
            # operator can audit those by clicking through.
            "voice_signal": (
                "ai_voice + examples"
                if metadata.get("title") and len(metadata.get("title") or "") > 0
                else "fallback template"
            ),
            "metadata_mode": metadata_mode,
            "track_count": len(music_asset_ids),
            "bg_role": getattr(image_asset, "role", None),
        },
    }


async def run_quick_generate(
    channel_id: int,
    preset_id: Optional[int] = None,
    on_progress: Optional[Callable[[float, str], None]] = None,
    approved_package: Optional[Dict[str, Any]] = None,
) -> dict:
    """One-click video generation using the channel's **library** assets.

    When ``approved_package`` is supplied (operator clicked Approve on a
    Phase-1 preview drawer), the function skips the random image pick,
    track selection, and metadata generation — those decisions are baked
    into the approved package. Everything downstream (project create,
    compose, extend, upload) reuses the approved values verbatim so the
    operator gets exactly what they previewed. When ``approved_package``
    is None (legacy / scheduled / direct API call), the original
    random-pick path runs.
    """

    def _progress(pct: float, msg: str) -> None:
        if on_progress:
            on_progress(pct, msg)

    # ── 0. Pre-flight: fail fast with a friendly message ──────────────
    # The channel must have at least one music asset and at least one
    # background asset (image OR video). Without this guard the user
    # hits opaque KeyError / ValueError deep in the compose stack 30
    # seconds in, which is especially painful for scheduled runs that
    # fire while the user isn't watching.
    from sqlalchemy import func as _sa_func
    async with async_session() as _pre_session:
        ch_check = await _pre_session.get(Channel, channel_id)
        if not ch_check:
            raise ValueError(f"Channel {channel_id} not found")
        music_count = (await _pre_session.execute(
            select(_sa_func.count(Asset.id)).where(
                Asset.channel_id == channel_id,
                Asset.asset_type == "music",
            )
        )).scalar_one()
        bg_count = (await _pre_session.execute(
            select(_sa_func.count(Asset.id)).where(
                Asset.channel_id == channel_id,
                Asset.asset_type.in_(("image", "video")),
            )
        )).scalar_one()
        if not music_count:
            raise ValueError(
                f"Channel '{ch_check.name}' has 0 music assets. "
                f"Upload some music in the Library first."
            )
        if not bg_count:
            raise ValueError(
                f"Channel '{ch_check.name}' has 0 background assets "
                f"(images or videos). Upload some in the Library first."
            )

    # ── 1. Load settings ──────────────────────────────────────────────
    _progress(0.01, "Loading settings…")
    async with async_session() as session:
        channel = await session.get(Channel, channel_id)
        if not channel:
            raise ValueError(f"Channel {channel_id} not found")

        preset: Optional[AutomationPreset] = None
        if preset_id:
            preset = await session.get(AutomationPreset, preset_id)

        target_seconds: int = preset.target_duration_seconds if preset else 3600
        num_tracks: Optional[int] = preset.num_tracks if preset else None
        pinned_image_id: Optional[int] = (
            preset.next_image_asset_id if preset else None
        )
        scheduled_publish_at: Optional[datetime] = (
            preset.scheduled_publish_at if preset else None
        )
        # Auto-translation: when set on the preset (Dashboard toggle),
        # we'll call Claude after metadata gen to fill in
        # `project.youtube_translations` so the upload step ships them
        # via YouTube's `localizations` API.
        auto_translate_languages: List[str] = list(
            preset.auto_translate_languages or []
        ) if preset else []
        visualizer_disabled: bool = bool(
            getattr(preset, "visualizer_disabled", False) if preset else False
        )
        # Always route through the audio-reactive engine ("spectrum"
        # style) so particles, background image, beat effects, and
        # corner overlay (subscribe animation) render correctly.
        # The ``visualizer_disabled`` flag is forwarded into the config
        # below; the engine respects it and just skips drawing the
        # spectrum bars while everything else animates.
        video_style: str = preset.video_style if preset else "spectrum"
        override_fps: Optional[int] = preset.output_fps if preset else None

        # Resolve the visualizer config to use. Priority order:
        #   1. AutomationPreset.visualizer_preset_id (explicit pick from
        #      the dashboard — the user said "use this saved look")
        #   2. Channel's default VisualizerPreset (is_default=True)
        #   3. Most-recently-updated VisualizerPreset on the channel
        #   4. Legacy AutomationPreset.composition_config
        #   5. Channel.last_composition_config
        #   6. Empty (engine defaults)
        from app.models.visualizer_preset import VisualizerPreset
        base_composition: Dict[str, Any] = {}
        viz_preset = None

        if preset and preset.visualizer_preset_id:
            vp = await session.get(VisualizerPreset, preset.visualizer_preset_id)
            if vp and vp.channel_id == channel_id:
                viz_preset = vp

        if viz_preset is None:
            viz_result = await session.execute(
                select(VisualizerPreset).where(
                    VisualizerPreset.channel_id == channel_id,
                    VisualizerPreset.is_default == True,  # noqa: E712
                ).limit(1)
            )
            viz_preset = viz_result.scalar_one_or_none()

        if viz_preset is None:
            viz_result = await session.execute(
                select(VisualizerPreset)
                .where(VisualizerPreset.channel_id == channel_id)
                .order_by(VisualizerPreset.updated_at.desc())
                .limit(1)
            )
            viz_preset = viz_result.scalar_one_or_none()

        if viz_preset and isinstance(viz_preset.config, dict):
            base_composition = {
                **viz_preset.config,
                "presetId": viz_preset.preset_id,
            }
        elif preset and preset.composition_config:
            base_composition = dict(preset.composition_config)
        elif channel.last_composition_config:
            base_composition = dict(channel.last_composition_config)

        color_override: Dict[str, Any] = (
            preset.visualizer_color_override or {} if preset else {}
        )
        composition_config: Dict[str, Any] = {**base_composition, **color_override}
        if override_fps:
            composition_config["output_fps"] = int(override_fps)
        composition_config["visualizer_disabled"] = visualizer_disabled
        # Dashboard-level particle overrides — when the user picked a
        # style/density on the Quick Generate card, those win over
        # whatever the loaded VisualizerPreset (or engine defaults) said.
        # Set both fields together so a partial override doesn't surprise
        # the user (e.g. picking "snow" without bumping density gets the
        # engine's 50 by default — fine, but explicit).
        if preset:
            preset_particle_style = getattr(preset, "particle_style", None)
            preset_particle_density = getattr(preset, "particle_density", None)
            if preset_particle_style:
                composition_config["particles"] = True
                composition_config["particleStyle"] = preset_particle_style
            if preset_particle_density is not None:
                composition_config["particles"] = True
                composition_config["particleDensity"] = int(preset_particle_density)

        # Now that scheduled cron runs ALSO route through quick_generate
        # (Phase 1 of the streamlined-automation plan), respect the
        # preset's metadata_mode so a preset configured for "template"
        # mode keeps that behaviour after the path unification. Falls
        # back to "claude" when there's no preset (anonymous Generate-
        # now from a channel without a primary preset).
        metadata_mode: str = (preset.metadata_mode or "claude") if preset else "claude"
        youtube_privacy: str = preset.youtube_privacy if preset else "private"
        youtube_category_id: str = (
            preset.youtube_category_id if preset else "10"
        )
        made_for_kids: bool = preset.made_for_kids if preset else False
        auto_upload: bool = preset.auto_upload if preset else False

        meta_config = dict(
            channel_id=channel_id,
            channel_name=channel.name,
            channel_niche=channel.niche or "",
            brand_identity=channel.brand_identity,
            target_audience=channel.target_audience,
            metadata_mode=metadata_mode,
            terse_metadata=bool(getattr(preset, "terse_metadata", False)) if preset else False,
            title_template=(preset.title_template if preset else None)
                or channel.title_template,
            description_template=(
                preset.description_template if preset else None
            ) or channel.description_template,
            tags_template=(
                preset.tags_template if preset else None
            ) or (
                # ``channel.default_tags`` may be a comma-separated
                # string (DB legacy) or a list. join() over a string
                # produces character-spaced tags — be explicit.
                (
                    ",".join(channel.default_tags)
                    if isinstance(channel.default_tags, list)
                    else str(channel.default_tags)
                )
                if channel.default_tags
                else None
            ),
            claude_prompt=(preset.claude_prompt if preset else None),
            youtube_privacy=youtube_privacy,
            youtube_category_id=youtube_category_id,
            made_for_kids=made_for_kids,
            auto_upload=auto_upload,
            youtube_creds=(
                await get_channel_youtube_credentials(session, channel.id)
                if channel.youtube_credentials_json
                else None
            ),
        )

    # ── 2. Pick image (or reuse approved one) ──────────────────────────
    # Three paths, in priority order:
    #   1. Approved preview package → reuse that image verbatim.
    #   2. Phase 5 Asset Sets mode → pick a random active AssetSet
    #      and use its background + thumbnail tuple. Sticky thumbnail
    #      below is overridden by the set's thumbnail.
    #   3. Legacy: random pick from role='background' images.
    picked_set_thumbnail_id: Optional[int] = None
    use_asset_sets: bool = bool(
        getattr(preset, "use_asset_sets", False) if preset else False
    )
    if approved_package and approved_package.get("image", {}).get("id"):
        approved_image_id = int(approved_package["image"]["id"])
        async with async_session() as _img_session:
            image_asset = await _img_session.get(Asset, approved_image_id)
        if not image_asset or image_asset.channel_id != channel_id:
            raise ValueError(
                f"Approved image asset {approved_image_id} not found on "
                f"channel {channel_id} (deleted between preview and approve?)."
            )
        _progress(0.03, "Using approved image…")
    elif use_asset_sets:
        _progress(0.03, "Picking from Asset Sets…")
        from app.api.asset_sets import pick_random_active_set
        async with async_session() as _set_session:
            picked_set = await pick_random_active_set(_set_session, channel_id)
        if picked_set:
            async with async_session() as _img_session:
                image_asset = await _img_session.get(
                    Asset, picked_set.background_asset_id,
                )
            picked_set_thumbnail_id = picked_set.thumbnail_asset_id
            logger.info(
                "Quick generate: using AssetSet id=%d name=%r",
                picked_set.id, picked_set.name,
            )
        else:
            # No active sets — fall back to legacy pick so an empty
            # Sets library doesn't break Quick Generate.
            logger.info(
                "Quick generate: use_asset_sets=True but no active sets — "
                "falling back to channel-wide bg pick",
            )
            image_asset = await select_image_from_library(
                channel_id, pinned_id=pinned_image_id,
            )
            if not image_asset:
                raise ValueError(
                    "No background images in the library. "
                    "Upload at least one image tagged 'background' in the "
                    "Library section first.",
                )
    else:
        _progress(0.03, "Selecting image…")
        image_asset = await select_image_from_library(
            channel_id,
            pinned_id=pinned_image_id,
        )
        if not image_asset:
            raise ValueError(
                "No background images in the library. "
                "Upload at least one image tagged 'background' in the "
                "Library section first."
            )
    image_asset_id = image_asset.id
    img_rel = image_asset.filepath

    # ── 3. Select tracks from library (or reuse approved ones) ────────
    async with async_session() as session:
        music_result = await session.execute(
            select(Asset).where(
                Asset.channel_id == channel_id,
                Asset.asset_type == "music",
            )
        )
        music_assets: List[Asset] = list(music_result.scalars().all())

    if not music_assets:
        raise ValueError(
            "No music assets in the library. "
            "Upload some music tracks in the Library section first."
        )

    files = [
        {
            "filepath": str(settings.assets_dir / a.filepath),
            "filename": a.filename or a.title or f"track_{a.id}",
            "title": a.title or "",
            "duration_seconds": a.duration_seconds or 0,
        }
        for a in music_assets
    ]

    if approved_package and approved_package.get("music", {}).get("asset_ids"):
        # Operator approved a specific set of tracks — honour them verbatim.
        approved_track_ids = [int(x) for x in approved_package["music"]["asset_ids"]]
        id_to_asset = {a.id: a for a in music_assets}
        missing = [aid for aid in approved_track_ids if aid not in id_to_asset]
        if missing:
            raise ValueError(
                f"Approved tracks {missing} missing on channel {channel_id} "
                f"(deleted between preview and approve?)."
            )
        selected_files = [
            {
                "filepath": str(settings.assets_dir / id_to_asset[aid].filepath),
                "filename": id_to_asset[aid].filename or id_to_asset[aid].title or f"track_{aid}",
                "title": id_to_asset[aid].title or "",
                "duration_seconds": id_to_asset[aid].duration_seconds or 0,
            }
            for aid in approved_track_ids
        ]
        _progress(0.06, "Using approved tracks…")
    else:
        _progress(0.06, "Selecting tracks from library…")
        selected_files = select_tracks(
            files,
            target_seconds,
            num_tracks=num_tracks,
        )

    total_duration = sum(f["duration_seconds"] for f in selected_files)

    fp_to_id = {
        str(settings.assets_dir / a.filepath): a.id for a in music_assets
    }
    music_asset_ids = [
        fp_to_id[f["filepath"]]
        for f in selected_files
        if f["filepath"] in fp_to_id
    ]
    music_rel_paths = [
        next(a.filepath for a in music_assets if a.id == aid)
        for aid in music_asset_ids
    ]
    logger.info(
        "Quick generate: %d tracks, %.1f min total",
        len(music_asset_ids),
        total_duration / 60,
    )

    # ── 4. Generate metadata (or reuse approved metadata) ──────────────
    if approved_package and approved_package.get("metadata", {}).get("title"):
        # Skip the Claude call entirely — preview already produced this.
        _progress(0.09, "Using approved metadata…")
        approved_meta = approved_package["metadata"]
        metadata = {
            "title": approved_meta.get("title") or "",
            "description": approved_meta.get("description") or "",
            "tags": list(approved_meta.get("tags") or []),
            "category_id": approved_meta.get("category_id") or youtube_category_id,
        }
    else:
        _progress(0.09, "Generating metadata…")
        metadata = await generate_metadata(meta_config, selected_files, total_duration)

    # Translation used to run here, between metadata gen and project
    # creation. Moved to after compose+extend (see step 7b below) so a
    # failed render doesn't waste the Claude calls and the operator sees
    # the long pole (compose) starting sooner. Initial project is
    # created with no translations; the row is updated in place once
    # translations come back.
    translations: dict[str, dict[str, str]] = {}

    # ── 5. Create VideoProject ─────────────────────────────────────────
    # Sticky thumbnail: when the preset has a default_thumbnail_asset_id
    # set, every quick-generated video ships with that asset as its
    # thumbnail. The user can override per-video by editing the Thumbnail
    # step in the wizard before upload. Asset must exist and belong to
    # the channel — silently skip if it's gone or mis-tagged.
    sticky_thumbnail_asset_id: Optional[int] = None
    # Phase 5: an active AssetSet pick wins over the sticky thumbnail —
    # the whole point of Sets is that bg+thumbnail travel together.
    if picked_set_thumbnail_id is not None:
        async with async_session() as _verify:
            ta = await _verify.get(Asset, int(picked_set_thumbnail_id))
            if ta and ta.channel_id == channel_id and ta.asset_type == "image":
                sticky_thumbnail_asset_id = ta.id
            else:
                logger.warning(
                    "Quick generate: AssetSet thumbnail_asset_id=%s is "
                    "missing or mis-tagged — falling back to sticky.",
                    picked_set_thumbnail_id,
                )
    if sticky_thumbnail_asset_id is None and preset and getattr(
        preset, "default_thumbnail_asset_id", None,
    ):
        async with async_session() as _verify:
            ta = await _verify.get(Asset, int(preset.default_thumbnail_asset_id))
            if ta and ta.channel_id == channel_id and ta.asset_type == "image":
                sticky_thumbnail_asset_id = ta.id
            else:
                logger.warning(
                    "Quick generate: preset's default_thumbnail_asset_id=%s "
                    "is missing, deleted, or not an image on this channel — skipping.",
                    preset.default_thumbnail_asset_id,
                )

    _progress(0.13, "Creating project…")
    async with async_session() as session:
        project = VideoProject(
            channel_id=channel_id,
            status="draft",
            title=metadata["title"],
            music_asset_ids=music_asset_ids,   # JSON column kept in sync
            image_asset_ids=[image_asset_id],
            video_style=video_style,
            composition_config=composition_config,
            youtube_title=metadata["title"],
            youtube_description=metadata["description"],
            youtube_tags=metadata.get("tags", []),
            youtube_category_id=youtube_category_id,
            youtube_privacy=youtube_privacy,
            made_for_kids=made_for_kids,
            youtube_translations=translations or None,
            thumbnail_asset_id=sticky_thumbnail_asset_id,
        )
        session.add(project)
        await session.flush()
        project_id = project.id
        # Write the m2m track table (CASCADE-safe; also keeps JSON in sync).
        await set_project_tracks(session, project_id, music_asset_ids)
        await session.commit()

    # ── 6. Compose video ───────────────────────────────────────────────
    _progress(0.17, "Composing video…")
    from app.services.compose_service import compose_service

    def compose_progress(pct: float, msg: str) -> None:
        mapped = 0.17 + pct * 0.55
        _progress(mapped, msg)

    # Hard cap on the rendered video's audio length. compose_service's
    # cap path will skip the trim if the audio is already shorter than
    # this — so passing target_seconds is safe even when the user picked
    # short tracks that fall under the target (extend_video handles the
    # padding afterwards). Without this hard cap, a 30-minute target with
    # a single 60-minute track would silently render a 60-minute video.
    audio_cap_seconds: float | None = (
        float(target_seconds) if target_seconds > 0 else None
    )

    compose_result = await compose_service.compose_video(
        channel_id=channel_id,
        style=video_style,
        music_filepath=music_rel_paths[0],
        music_filepaths=music_rel_paths,
        image_filepaths=[img_rel],
        config=composition_config,
        on_progress=compose_progress,
        max_duration_seconds=audio_cap_seconds,
    )

    async with async_session() as session:
        composed_asset = Asset(
            channel_id=channel_id,
            asset_type="composed",
            source="composed",
            filename=compose_result["filename"],
            filepath=compose_result["filepath"],
            file_size=compose_result["file_size"],
            duration_seconds=compose_result.get("duration"),
            mime_type="video/mp4",
            title=metadata["title"],
        )
        session.add(composed_asset)
        await session.flush()
        composed_id = composed_asset.id
        proj = await session.get(VideoProject, project_id)
        if proj:
            proj.composed_asset_id = composed_id
            proj.status = "composed"
        await session.commit()

    composed_duration = compose_result.get("duration", 0) or 0
    composed_filepath = compose_result["filepath"]

    # ── 7. Extend to target duration if needed ─────────────────────────
    if target_seconds > 0 and composed_duration < target_seconds - 60:
        _progress(0.74, "Extending to target duration…")

        def extend_progress(pct: float, msg: str) -> None:
            mapped = 0.74 + pct * 0.10
            _progress(mapped, msg)

        extend_result = await compose_service.extend_video(
            channel_id=channel_id,
            source_filepath=composed_filepath,
            target_duration_seconds=target_seconds,
            on_progress=extend_progress,
        )

        async with async_session() as session:
            ext_asset = Asset(
                channel_id=channel_id,
                asset_type="composed",
                source="composed",
                filename=extend_result["filename"],
                filepath=extend_result["filepath"],
                file_size=extend_result["file_size"],
                duration_seconds=extend_result.get("duration"),
                mime_type="video/mp4",
            )
            session.add(ext_asset)
            await session.flush()
            proj = await session.get(VideoProject, project_id)
            if proj:
                proj.composed_asset_id = ext_asset.id
                proj.status = "composed"
            await session.commit()

        composed_id = ext_asset.id
        composed_filepath = extend_result["filepath"]
        logger.info(
            "Quick generate: extended to %ds", extend_result.get("duration", 0)
        )

    # ── 8. Update project memory on channel ────────────────────────────
    async with async_session() as session:
        ch = await session.get(Channel, channel_id)
        if ch:
            ch.last_composition_config = composition_config
            if composition_config.get("visualizer_preset_id"):
                ch.last_visualizer_preset_id = composition_config[
                    "visualizer_preset_id"
                ]
            ch.last_music_source = "library"
        await session.commit()

    # ── 8b. Auto-translate (optional) ──────────────────────────────────
    # Run translation AFTER the video has been composed + extended. This
    # was previously before compose, which burned Claude calls every
    # time a render failed (or the user killed the run mid-compose).
    # Translation only matters at upload time; deferring keeps it tied
    # to a successful render and shows compose progress to the operator
    # earlier. Fail-soft: if translation breaks, log and continue with
    # the English-only upload — losing localisations is way better than
    # losing the whole video.
    if auto_translate_languages:
        _progress(0.84, f"Translating into {len(auto_translate_languages)} languages…")
        try:
            from app.services.claude_cli_service import claude_cli_service
            from app.utils.description_parts import split_top_and_rest

            description_top, _rest = split_top_and_rest(
                metadata.get("description") or ""
            )
            if not description_top.strip():
                description_top = (metadata.get("description") or "").strip()
            translations = await claude_cli_service.translate_metadata(
                title=metadata["title"],
                description_top=description_top,
                target_languages=auto_translate_languages,
                niche=meta_config.get("channel_niche") or None,
            )
            logger.info(
                "Quick generate: translated into %d/%d languages",
                len(translations), len(auto_translate_languages),
            )
            # Persist into the project row so the upload step (and any
            # later re-upload / manual edit) can read them.
            if translations:
                async with async_session() as session:
                    proj = await session.get(VideoProject, project_id)
                    if proj:
                        proj.youtube_translations = translations
                    await session.commit()
        except Exception:
            logger.exception(
                "Quick generate: auto-translate failed, continuing with English-only"
            )
            translations = {}

    # ── 9. Upload to YouTube (optional) ───────────────────────────────
    youtube_result = None
    if auto_upload and not meta_config.get("youtube_creds"):
        # Fail fast with a clear message — was previously silently
        # skipped, which made auto-publish look like it worked.
        err = (
            "Auto-publish is enabled but the channel isn't connected to "
            "YouTube. Open the channel page and click 'Connect YouTube'."
        )
        async with async_session() as session:
            proj = await session.get(VideoProject, project_id)
            if proj:
                proj.upload_error = err
            await session.commit()
        raise RuntimeError(err)

    if auto_upload and meta_config.get("youtube_creds"):
        _progress(0.86, "Uploading to YouTube…")
        from app.services.youtube_service import youtube_service

        video_abs = str(settings.assets_dir / composed_filepath)

        def upload_progress(pct: float) -> None:
            mapped = 0.86 + pct * 0.13
            _progress(mapped, f"Uploading… {int(pct * 100)}%")

        try:
            # Privacy semantics for the dashboard "Auto-publish" toggle:
            #   - Toggle OFF → handler doesn't reach this branch (auto_upload=False)
            #   - Toggle ON, no schedule → publish public immediately
            #   - Toggle ON, scheduled → upload private + publishAt
            #   - When the preset's youtube_privacy was explicitly set
            #     to "unlisted" we honour that (intermediate state).
            if scheduled_publish_at:
                effective_privacy = "private"
            elif youtube_privacy == "unlisted":
                effective_privacy = "unlisted"
            else:
                effective_privacy = "public"

            # Build YouTube `localizations` payload from the translations
            # we generated above. The translated description is just the
            # "top"; re-attach the English tracklist + hashtag tail so
            # timestamps + hashtag SEO carry across locales.
            from app.utils.description_parts import build_localized_description
            localizations_payload: dict[str, dict[str, str]] = {}
            for code, entry in (translations or {}).items():
                if not isinstance(entry, dict):
                    continue
                t = (entry.get("title") or "").strip()
                top = (entry.get("description") or "").strip()
                if not t and not top:
                    continue
                localizations_payload[code] = {
                    "title": t or metadata["title"],
                    "description": (
                        build_localized_description(top, metadata["description"])
                        or top
                    ),
                }

            youtube_result = await youtube_service.upload_video(
                credentials_json=meta_config["youtube_creds"],
                filepath=video_abs,
                title=metadata["title"],
                description=metadata["description"],
                tags=metadata.get("tags"),
                category_id=youtube_category_id,
                privacy=effective_privacy,
                scheduled_at=scheduled_publish_at,
                made_for_kids=made_for_kids,
                on_progress=upload_progress,
                localizations=localizations_payload or None,
            )
            async with async_session() as session:
                proj = await session.get(VideoProject, project_id)
                if proj:
                    proj.youtube_video_id = youtube_result.get("video_id")
                    proj.youtube_url = youtube_result.get("url")
                    proj.uploaded_at = datetime.utcnow()
                    proj.status = "uploaded"
                    proj.upload_error = None  # clear any prior failure
                    if scheduled_publish_at:
                        proj.youtube_scheduled_at = scheduled_publish_at
                await session.commit()
            logger.info(
                "Quick generate: uploaded %s", youtube_result.get("url")
            )
        except Exception as upload_exc:
            logger.exception("Quick generate: YouTube upload failed")
            err_msg = str(upload_exc) or upload_exc.__class__.__name__
            async with async_session() as session:
                proj = await session.get(VideoProject, project_id)
                if proj:
                    proj.upload_error = err_msg[:1000]
                await session.commit()
            raise RuntimeError(
                f"Video composed successfully but YouTube upload failed: {err_msg}"
            ) from upload_exc

    _progress(1.0, "Done!")
    return {
        "project_id": project_id,
        "track_count": len(music_asset_ids),
        "total_duration": total_duration,
        "image_asset_id": image_asset_id,
        "youtube": youtube_result,
    }
