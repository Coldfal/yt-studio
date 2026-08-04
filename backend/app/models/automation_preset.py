from __future__ import annotations

from datetime import datetime
from typing import Optional, Dict, Any, List, TYPE_CHECKING

from sqlalchemy import Integer, String, Text, DateTime, Boolean, Float, ForeignKey, JSON, func, text as sa_text
from sqlalchemy.orm import Mapped, backref, mapped_column, relationship

from app.database import Base

if TYPE_CHECKING:
    from app.models.channel import Channel
    from app.models.automation_run import AutomationRun


class AutomationPreset(Base):
    __tablename__ = "automation_presets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(
        Integer, ForeignKey("channels.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    is_active: Mapped[bool] = mapped_column(Boolean, default=False)
    # The channel's "primary" preset — surfaced on the Dashboard's one-click
    # "Generate now" button. Only one preset per channel should be primary;
    # setting a new primary unsets others (handled in the API layer).
    is_primary: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)

    # Source folders (absolute local filesystem paths)
    music_folder_path: Mapped[str] = mapped_column(Text, nullable=False)
    image_folder_path: Mapped[str] = mapped_column(Text, nullable=False)

    # Image source: "folder" (default) or "generate" (AI-generated via DALL-E)
    image_source: Mapped[str] = mapped_column(String(20), default="folder")
    image_generation_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # Audio selection
    target_duration_seconds: Mapped[int] = mapped_column(Integer, default=3600)
    # When set, picks exactly N random tracks instead of "as many as fit
    # the target duration". The compose+extend pipeline will loop the
    # resulting video to reach target_duration_seconds.
    num_tracks: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    audio_extensions: Mapped[str] = mapped_column(
        String(200), default='["mp3","wav","flac","ogg","m4a"]'
    )

    # Composition
    video_style: Mapped[str] = mapped_column(String(50), default="spectrum")
    composition_config: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)
    # Optional FK to a saved VisualizerPreset. When set, Quick Generate uses
    # that preset's full config (visualizer style, colors, particles, logo,
    # subscribe overlay, etc.). Lets the user pick a specific saved look
    # for the dashboard one-click flow without having to mark it as the
    # channel default.
    visualizer_preset_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("visualizer_presets.id", ondelete="SET NULL"), nullable=True
    )
    # When true, the audio-reactive visualizer is skipped — just renders the
    # background image with audio. Faster + smaller files for long ambient
    # uploads where you don't want spectrum bars. PARTICLES STILL RENDER —
    # they're a separate animation layer, controlled by the fields below.
    visualizer_disabled: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Dashboard-level particle controls. When the user disables the
    # spectrum visualizer, particles are the only thing animating — these
    # fields let the user pick the style + density from Quick Generate
    # without needing a full VisualizerPreset. NULL = let the loaded
    # VisualizerPreset (or engine defaults) decide.
    # Style values: "floating" (default — subtle dots), "snow", "stars",
    # "fireflies", "rain", "smoke". Density 0-100; engine default is 50.
    particle_style: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    particle_density: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Output frame rate. 15 fps halves render time vs 30 — fine for ambient
    # / lofi backgrounds with subtle motion. 30 default keeps spectrum smooth.
    output_fps: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # Sticky default thumbnail. When set, Quick Generate copies this asset
    # onto each new project's thumbnail_asset_id BEFORE upload so every
    # quick-generated video ships with a consistent thumbnail without the
    # user having to edit it per-video. Pointing the FK at an image asset
    # in the channel's library is enough — the YouTube upload pipeline
    # already resolves thumbnail_asset_id and pushes it via
    # youtube.thumbnails().set(). The operator can override by editing
    # the per-project thumbnail in the wizard's Thumbnail step.
    default_thumbnail_asset_id: Mapped[Optional[int]] = mapped_column(
        Integer, ForeignKey("assets.id", ondelete="SET NULL"), nullable=True,
    )
    # Editor state for the sticky default thumbnail. Mirrors the
    # ``thumbnail_editor_state`` column on VideoProject — same JSON shape
    # (bg + layers + effect_preset per layer). Lets the operator re-open
    # the dashboard's thumbnail designer and keep tweaking. The rendered
    # JPEG lives on ``default_thumbnail_asset_id``; this column is purely
    # for re-edit.
    default_thumbnail_editor_state: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSON, nullable=True,
    )

    # Phase 7 of farm redesign — thumbnail template auto-generator.
    # When set, Quick Generate's preview drawer renders a fresh
    # thumbnail JPEG per video using this template (wordmark + bg slot
    # + stamp + corner tags), seeded from the picked background's
    # asset id so re-renders are deterministic. Shape is documented in
    # ``frontend/src/components/thumbnail/renderTemplate.ts`` —
    # roughly ``{version, bg_source, layers: [...], rotation_seed}``.
    # NULL = use sticky thumbnail / asset-set path as before.
    thumbnail_template: Mapped[Optional[Dict[str, Any]]] = mapped_column(
        JSON, nullable=True,
    )

    # Metadata generation
    metadata_mode: Mapped[str] = mapped_column(String(20), default="template")
    title_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    description_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    tags_template: Mapped[Optional[str]] = mapped_column(Text, nullable=True)
    claude_prompt: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    # YouTube settings
    youtube_privacy: Mapped[str] = mapped_column(String(20), default="private")
    youtube_category_id: Mapped[str] = mapped_column(String(10), default="10")
    made_for_kids: Mapped[bool] = mapped_column(Boolean, default=False)
    auto_upload: Mapped[bool] = mapped_column(Boolean, default=True)
    # When set, the upload is scheduled rather than immediate-public. The
    # YouTube API publishes the video at this UTC timestamp.
    scheduled_publish_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # Auto-translate languages for Quick Generate / cron uploads. When set
    # to a non-empty list (e.g. ["ja", "zh-Hans", "ko", "es"]) the
    # automation pipeline calls Claude to translate the title +
    # description-top into each language and ships them to YouTube via
    # the `localizations` API field. Null/empty = no auto-translation.
    auto_translate_languages: Mapped[Optional[List[Any]]] = mapped_column(
        JSON, nullable=True
    )

    # ── Quick Generate dashboard preview state ──────────────────────────
    # The image asset id selected for the next run (rotated daily / on
    # explicit reroll). When null, _select_image picks fresh on demand.
    next_image_asset_id: Mapped[Optional[int]] = mapped_column(Integer, nullable=True)
    # When the next-image selection was last refreshed. Used to auto-rotate
    # to a new random image once a day on dashboard load.
    next_image_picked_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    # When True, the user has explicitly LOCKED the current image and we
    # never auto-rotate it (no daily refresh, no random picks). Stays in
    # effect until the user toggles the lock off or clicks reroll.
    # Useful for series-style channels where every video uses the same
    # backdrop.
    next_image_pinned: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=sa_text("0")
    )
    # Per-Quick-Generate visualizer color tweaks. Merged on top of the
    # composition_config at run time. Lets the user tweak colors without
    # opening the full visualizer editor.
    visualizer_color_override: Mapped[Optional[Dict[str, Any]]] = mapped_column(JSON, nullable=True)

    # Optional: when True, Quick Generate constrains music selection to
    # folders whose ``group`` matches the picked image's folder.group.
    # Lets channels with curated subfolders (e.g. "lofi-day" image folder
    # paired with "lofi-day" music folder) keep visual + audio coherent.
    # When the picked image has no group OR no matching music folder is
    # found, the run logs a warning and falls back to channel-wide
    # selection so an in-progress folder rename never fails a render.
    use_folder_pairing: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=sa_text("0")
    )

    # Phase 5 of farm redesign: when True, Quick Generate picks a
    # random active AssetSet (a curated bg+thumbnail tuple) instead of
    # independently picking a background image + sticky thumbnail. The
    # operator pairs assets once in the Library 'Sets' tab and the
    # generator reuses them forever. Sticky thumbnail still applies as
    # a fallback when no set is active.
    use_asset_sets: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=sa_text("0")
    )

    # Operator UX toggles (added 2026-05-15 per operator request).
    #
    # When True, clicking "Generate now" on the dashboard skips the
    # preview-before-generate drawer and fires compose directly with a
    # fresh random pick. Useful when the operator trusts the channel's
    # voice + bandit and doesn't want to confirm every run.
    skip_preview_drawer: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=sa_text("0")
    )
    # When False, Quick Generate skips the Phase 7b
    # thumbnail-template-on-the-fly renderer and uses the sticky
    # thumbnail (or no thumbnail) instead. Defaults to True so existing
    # channels with a template configured keep their current behavior.
    auto_generate_thumbnail: Mapped[bool] = mapped_column(
        Boolean, default=True, nullable=False, server_default=sa_text("1")
    )

    # Phase 3: when True, the Claude metadata prompt is nudged to
    # produce shorter copy (title under 40 chars, description under
    # 200 words, tags max 8). The channel voice still wins on STYLE;
    # this just adds a length cap. Useful for channels where the user
    # prefers terse, easier-to-manage output.
    terse_metadata: Mapped[bool] = mapped_column(
        Boolean, default=False, nullable=False, server_default=sa_text("0")
    )

    # Scheduling
    schedule_cron: Mapped[Optional[str]] = mapped_column(String(100), nullable=True)
    schedule_timezone: Mapped[str] = mapped_column(String(50), default="UTC")
    next_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_run_at: Mapped[Optional[datetime]] = mapped_column(DateTime, nullable=True)
    last_run_status: Mapped[Optional[str]] = mapped_column(String(20), nullable=True)
    last_run_error: Mapped[Optional[str]] = mapped_column(Text, nullable=True)

    created_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now())
    updated_at: Mapped[datetime] = mapped_column(DateTime, server_default=func.now(), onupdate=func.now())

    # Relationships. ``passive_deletes=True`` on the back-reference is
    # essential: without it, deleting a Channel makes SQLAlchemy try to
    # UPDATE every preset's channel_id to NULL — which fails because the
    # column is NOT NULL. Letting the DB's ON DELETE CASCADE do the work
    # is correct here (the FK on ``channel_id`` declares CASCADE).
    channel: Mapped["Channel"] = relationship(
        "Channel",
        backref=backref("automation_presets", passive_deletes=True),
        passive_deletes=True,
    )
    runs: Mapped[List["AutomationRun"]] = relationship(
        "AutomationRun", back_populates="preset", cascade="all, delete-orphan",
        order_by="AutomationRun.created_at.desc()",
    )
