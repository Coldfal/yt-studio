from __future__ import annotations

from sqlalchemy import event
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine, async_sessionmaker
from sqlalchemy.orm import DeclarativeBase

from app.config import settings

engine = create_async_engine(
    f"sqlite+aiosqlite:///{settings.db_path}",
    echo=settings.debug,
)


# SQLite pragmas applied on every new connection.
#
# - ``foreign_keys=ON``: required for ``ondelete=CASCADE`` / ``SET NULL``
#   to do anything; SQLite defaults this OFF for legacy reasons.
# - ``journal_mode=WAL``: write-ahead logging. The default ``delete``
#   (rollback) journal mode makes every writer block ALL readers and
#   vice versa, which on this app caused the operator-reported
#   slowness: during composes (frequent progress writes), opening
#   any other page (project edit, asset list) felt unresponsive
#   because the reads queued behind the in-flight write. WAL lets
#   readers and writers run concurrently — single writer at a time
#   is still enforced, but readers don't block. Mode is persisted at
#   the DB file level so setting it once is enough; running on every
#   connect is idempotent.
# - ``synchronous=NORMAL``: safe with WAL (durable across app crashes,
#   only loses last txn on a power loss) and 2-3× faster than the
#   default ``FULL`` which fsyncs on every commit.
# - ``busy_timeout=10000``: wait up to 10s on lock contention before
#   raising SQLITE_BUSY. Default is 0 (instant fail). Belt-and-braces
#   given the long-running compose progress writes.
@event.listens_for(engine.sync_engine, "connect")
def _apply_sqlite_pragmas(dbapi_connection, _connection_record) -> None:  # pragma: no cover
    cursor = dbapi_connection.cursor()
    try:
        cursor.execute("PRAGMA foreign_keys=ON")
        cursor.execute("PRAGMA journal_mode=WAL")
        cursor.execute("PRAGMA synchronous=NORMAL")
        cursor.execute("PRAGMA busy_timeout=10000")
    finally:
        cursor.close()

async_session = async_sessionmaker(engine, class_=AsyncSession, expire_on_commit=False)


class Base(DeclarativeBase):
    pass


async def get_db() -> AsyncSession:
    async with async_session() as session:
        yield session


async def init_db():
    from sqlalchemy import text as _sa_text

    async with engine.begin() as conn:
        await conn.run_sync(Base.metadata.create_all)

        # Additive migrations for existing DBs (SQLite lacks
        # `ADD COLUMN IF NOT EXISTS`). Each entry: (table, column, SQL type,
        # optional default). Safe to re-run on every startup.
        for table, column, col_sql in [
            ("video_projects", "music_asset_ids", "JSON"),
            ("live_streams", "image_asset_id", "INTEGER"),
            ("live_streams", "use_channel_music_assets", "BOOLEAN DEFAULT 0 NOT NULL"),
            ("live_streams", "use_visualizer", "BOOLEAN DEFAULT 0 NOT NULL"),
            ("live_streams", "visualizer_config", "JSON"),
            ("live_streams", "visualizer_preset_id", "VARCHAR(50)"),
            ("live_streams", "composed_asset_id", "INTEGER"),
            ("automation_presets", "is_primary", "BOOLEAN DEFAULT 0 NOT NULL"),
            # Project memory columns on channels
            ("channels", "last_composition_config", "JSON"),
            ("channels", "last_visualizer_preset_id", "INTEGER"),
            ("channels", "last_music_source", "VARCHAR(20)"),
            ("channels", "last_image_asset_ids", "JSON"),
            ("channels", "last_music_folder_path", "TEXT"),
            # Quick Generate dashboard card additions
            ("automation_presets", "num_tracks", "INTEGER"),
            ("automation_presets", "scheduled_publish_at", "DATETIME"),
            ("automation_presets", "next_image_asset_id", "INTEGER"),
            ("automation_presets", "next_image_picked_at", "DATETIME"),
            # Explicit user-lock on the dashboard's pinned image — when 1,
            # auto-rotation skips and reroll is the only way to change it.
            ("automation_presets", "next_image_pinned", "BOOLEAN DEFAULT 0 NOT NULL"),
            ("automation_presets", "visualizer_color_override", "JSON"),
            ("automation_presets", "visualizer_disabled", "BOOLEAN DEFAULT 0 NOT NULL"),
            ("automation_presets", "output_fps", "INTEGER"),
            ("automation_presets", "visualizer_preset_id", "INTEGER"),
            ("automation_presets", "auto_translate_languages", "JSON"),
            ("video_projects", "upload_error", "TEXT"),
            # Phase 0 — add updated_at to models that lacked it.
            ("assets", "updated_at", "DATETIME"),
            ("asset_folders", "updated_at", "DATETIME"),
            ("automation_runs", "updated_at", "DATETIME"),
            ("background_tasks", "updated_at", "DATETIME"),
            ("live_streams", "updated_at", "DATETIME"),
            ("visualizer_presets", "thumbnail_url", "VARCHAR(500)"),
            ("video_projects", "music_folder_path", "TEXT"),
            ("video_projects", "music_folder_files", "JSON"),
            ("video_projects", "youtube_translations", "JSON"),
            # OAuth-state TTL support — created_at lets us expire stale rows.
            ("app_settings", "created_at", "DATETIME"),
            ("app_settings", "updated_at", "DATETIME"),
            # AI metadata voice — replaces hardcoded style_block() with
            # per-channel system-prompt content. See docs/ai-voice-redesign.md.
            ("channels", "ai_voice", "TEXT"),
            ("channels", "ai_example_title", "TEXT"),
            ("channels", "ai_example_description", "TEXT"),
            ("channels", "ai_example_tags", "TEXT"),
            # Phase 2 of streamlined-automation revamp: optional folder
            # pairing. ``asset_folders.pair_group`` is a free-text label
            # that ties folders across asset types (image/music) into a
            # pool the user opts a channel into via
            # ``automation_presets.use_folder_pairing``. NULL pair_group
            # = "ungrouped"; FALSE on the preset = ignore groups
            # (current behaviour). Named ``pair_group`` (not ``group``)
            # to dodge the SQL reserved word.
            ("asset_folders", "pair_group", "VARCHAR(100)"),
            ("automation_presets", "use_folder_pairing", "BOOLEAN DEFAULT 0 NOT NULL"),
            # Phase 3: terse metadata mode. Caps title / description /
            # tags lengths so output is easier to scan and manage.
            ("automation_presets", "terse_metadata", "BOOLEAN DEFAULT 0 NOT NULL"),
            # Thumbnail editor: persists the layer/font/effect state so
            # re-entering the wizard's Thumbnail step restores everything.
            # JSON stored as TEXT (SQLite convention; SQLAlchemy JSON type
            # round-trips dict ↔ string transparently).
            ("video_projects", "thumbnail_editor_state", "JSON"),
            # Operator notes — free-form per-channel context fed into the
            # metadata-generation system prompt. Distinct from ai_voice
            # (hard rules) — this is the soft, evolving "what's working"
            # log that grows over time as the operator learns the channel.
            ("channels", "notes", "TEXT"),
            # Dashboard-level particle controls on the quick-generate preset.
            # Lets the user pick particle style + density without needing a
            # full VisualizerPreset. Both nullable — NULL = let the loaded
            # VisualizerPreset / engine defaults decide.
            ("automation_presets", "particle_style", "VARCHAR(20)"),
            ("automation_presets", "particle_density", "INTEGER"),
            # Sticky default thumbnail for quick-generate uploads. When set
            # on the preset, every new project gets this asset assigned as
            # its thumbnail_asset_id BEFORE upload, so the same thumbnail
            # ships with every quick-generated video.
            ("automation_presets", "default_thumbnail_asset_id", "INTEGER"),
            # Editor state for the sticky thumbnail — re-opens the designer
            # dialog with the same layers/fonts/effects the operator picked.
            ("automation_presets", "default_thumbnail_editor_state", "JSON"),
            # Phase 0 of farm redesign: per-asset ROLE sub-classification.
            # ``asset_type='image'`` stays as the storage discriminator;
            # ``role`` says HOW that image is meant to be used so Quick
            # Generate's background picker never accidentally grabs a
            # thumbnail / overlay. Values: background | thumbnail |
            # overlay | reference. NULL = unclassified (backfill runs
            # below this list).
            ("assets", "role", "VARCHAR(20)"),
            # Phase 3 of farm redesign: cache description + tags at
            # snapshot time so the description / tag bandits can
            # tokenise them on the next recompute without re-fetching
            # from the public Data API.
            ("video_analytics_snapshots", "description_at_snapshot", "TEXT"),
            ("video_analytics_snapshots", "tags_at_snapshot", "JSON"),
            # Phase 4 of farm redesign: operator "Dismiss" timestamp on
            # failed background tasks. The Fleet triage panel filters on
            # this so dismissed failures stop reappearing without
            # losing the audit row.
            ("background_tasks", "acknowledged_at", "DATETIME"),
            # Phase 5 of farm redesign: when set, Quick Generate picks
            # a random active AssetSet (bg+thumbnail tuple) instead of
            # independently picking a background + sticky thumbnail.
            ("automation_presets", "use_asset_sets", "BOOLEAN DEFAULT 0 NOT NULL"),
            # Phase 7 of farm redesign: per-preset thumbnail template
            # config. JSON shape — see model docstring.
            ("automation_presets", "thumbnail_template", "JSON"),
            # Operator UX toggles (2026-05-15): skip_preview_drawer
            # bypasses the Phase-1 preview drawer; auto_generate_thumbnail
            # gates the Phase-7b template renderer.
            ("automation_presets", "skip_preview_drawer", "BOOLEAN DEFAULT 0 NOT NULL"),
            ("automation_presets", "auto_generate_thumbnail", "BOOLEAN DEFAULT 1 NOT NULL"),
            # Channel master language (2026-05-16). Feeds YouTube's
            # snippet.defaultLanguage on upload + update. 'en' default
            # preserves existing behaviour; channels targeting Korean /
            # Japanese / etc. set it explicitly via the channels API.
            ("channels", "master_language", "VARCHAR(10) NOT NULL DEFAULT 'en'"),
            # Channel-level YouTube branding (2026-05-20). country feeds
            # brandingSettings.channel.country; channel_localizations
            # stores localized channel title/description per language.
            ("channels", "country", "VARCHAR(2)"),
            ("channels", "channel_localizations", "JSON"),
        ]:
            cols = await conn.execute(_sa_text(f"PRAGMA table_info({table})"))
            existing = {row[1] for row in cols.fetchall()}
            if column not in existing:
                await conn.execute(
                    _sa_text(f"ALTER TABLE {table} ADD COLUMN {column} {col_sql}")
                )
                # SQLite refuses CURRENT_TIMESTAMP as a column-add default
                # ("Cannot add a column with non-constant default"), so for
                # *_at columns we backfill existing rows with `now()` after
                # the ADD COLUMN. New inserts get the value from the model's
                # `server_default=func.now()`.
                if column.endswith("_at"):
                    await conn.execute(
                        _sa_text(
                            f"UPDATE {table} SET {column} = CURRENT_TIMESTAMP "
                            f"WHERE {column} IS NULL"
                        )
                    )

        # ── Backfill assets.role for existing rows ───────────────────────────
        # Phase 0 of farm redesign. Idempotent: only writes to rows where
        # role IS NULL. New rows get the right value at write time from
        # the API layer; this fills in the historical assets.
        #   - thumb_* / sticky_preset_* filenames → "thumbnail"
        #   - source='ai_generated' / 'generated' (without thumb_ pattern)
        #     → "reference"  (operator can re-tag if needed)
        #   - everything else under asset_type='image' → "background"
        #     (this is what Quick Generate previously was picking
        #     blindly, so it's correct as the default).
        # We leave non-image assets (music/video/composed) with NULL
        # role — the column is only meaningful for images.
        await conn.execute(
            _sa_text(
                "UPDATE assets SET role='thumbnail' "
                "WHERE role IS NULL AND asset_type='image' AND ("
                "filename LIKE 'thumb_%' "
                "OR filename LIKE '%_thumb_%' "
                "OR filename LIKE 'sticky_preset%' "
                "OR filename LIKE '%_sticky_preset%')"
            )
        )
        await conn.execute(
            _sa_text(
                "UPDATE assets SET role='reference' "
                "WHERE role IS NULL AND asset_type='image' "
                "AND source IN ('ai_generated','generated')"
            )
        )
        await conn.execute(
            _sa_text(
                "UPDATE assets SET role='background' "
                "WHERE role IS NULL AND asset_type='image'"
            )
        )

        # ── Backfill video_project_tracks from music_asset_ids JSON ──────────
        # One-time migration (idempotent — only inserts for projects that have
        # no rows yet).  Skips asset_ids that no longer exist in the assets
        # table so we don't re-introduce dangling FKs via the backfill itself.
        import json as _json

        to_backfill = await conn.execute(
            _sa_text(
                """
                SELECT vp.id, vp.music_asset_id, vp.music_asset_ids
                FROM video_projects vp
                WHERE (vp.music_asset_ids IS NOT NULL OR vp.music_asset_id IS NOT NULL)
                  AND NOT EXISTS (
                      SELECT 1 FROM video_project_tracks t
                      WHERE t.project_id = vp.id
                  )
                """
            )
        )
        for row in to_backfill.fetchall():
            project_id, single_id, ids_json = row[0], row[1], row[2]
            asset_ids: list[int] = []
            if ids_json:
                try:
                    parsed = (
                        _json.loads(ids_json)
                        if isinstance(ids_json, str)
                        else ids_json
                    )
                    asset_ids = [int(x) for x in (parsed or []) if x]
                except (ValueError, TypeError):
                    pass
            if not asset_ids and single_id:
                asset_ids = [int(single_id)]
            for position, asset_id in enumerate(asset_ids):
                exists = await conn.execute(
                    _sa_text("SELECT 1 FROM assets WHERE id = :aid"),
                    {"aid": asset_id},
                )
                if exists.fetchone():
                    await conn.execute(
                        _sa_text(
                            "INSERT OR IGNORE INTO video_project_tracks "
                            "(project_id, asset_id, position) "
                            "VALUES (:pid, :aid, :pos)"
                        ),
                        {"pid": project_id, "aid": asset_id, "pos": position},
                    )

        # ── Migration: AssetFolder gains channel_id (per-channel folders) ────
        # Pre-migration: folders were global per asset_type. The data audit
        # confirmed no folder spans more than one channel — so each folder
        # maps cleanly to its single owning channel. Empty folders (those
        # with zero assets) get dropped — they were never used and the
        # NOT NULL constraint requires every folder to belong to a channel.
        #
        # Idempotent: re-running on a migrated DB is a no-op (column already
        # exists, NULL channel_ids no longer present, no folders to drop).
        # Asset rows are NEVER deleted by this migration. The only data
        # change to asset_folders is dropping empty rows + adding channel_id.
        cols = await conn.execute(_sa_text("PRAGMA table_info(asset_folders)"))
        af_cols = {row[1] for row in cols.fetchall()}
        if "channel_id" not in af_cols:
            # Step 1: add the column nullable so we can backfill.
            await conn.execute(
                _sa_text(
                    "ALTER TABLE asset_folders ADD COLUMN channel_id INTEGER "
                    "REFERENCES channels(id) ON DELETE CASCADE"
                )
            )
            # Step 2: assign each folder to the channel that owns its assets.
            # Multi-channel folders don't exist today, so this is a 1:1 map.
            await conn.execute(
                _sa_text(
                    """
                    UPDATE asset_folders
                    SET channel_id = (
                        SELECT a.channel_id
                        FROM assets a
                        WHERE a.folder_id = asset_folders.id
                        GROUP BY a.channel_id
                        ORDER BY COUNT(*) DESC
                        LIMIT 1
                    )
                    """
                )
            )
            # Step 3: drop empty folders (still NULL after step 2).
            await conn.execute(
                _sa_text(
                    "DELETE FROM asset_folders WHERE channel_id IS NULL"
                )
            )
            # Step 4: enforce the (channel_id, asset_type, name) uniqueness.
            # Best-effort — SQLite doesn't allow ALTER COLUMN to add
            # constraints, so we add an index. SQLAlchemy will also recognise
            # the UniqueConstraint on the model when create_all runs.
            await conn.execute(
                _sa_text(
                    "CREATE UNIQUE INDEX IF NOT EXISTS uq_folder_channel_type_name "
                    "ON asset_folders (channel_id, asset_type, name)"
                )
            )

        # ── Safety net: strip stale folder_id on assets ──────────────────────
        # An asset's folder must belong to its own channel. Today this is
        # always true (every existing folder is single-channel), but if a
        # future bug or manual SQL leaves an inconsistent row, fix it here
        # rather than 500ing on the next render.
        await conn.execute(
            _sa_text(
                """
                UPDATE assets
                SET folder_id = NULL
                WHERE folder_id IS NOT NULL
                  AND channel_id != (
                    SELECT channel_id FROM asset_folders
                    WHERE asset_folders.id = assets.folder_id
                  )
                """
            )
        )

        # ── Backward-compat seed: copy the old hardcoded YomiBeats voice ─────
        # The pre-redesign ``style_block()`` baked in a YomiBeats-flavored
        # title/description/tags example as the brand reference for EVERY
        # channel. The redesign moves that voice onto the channel record so
        # each channel can have its own. To preserve YomiBeats's existing
        # output during the transition, copy the legacy values into the
        # channel's ``ai_*`` fields IFF the channel is named "YomiBeats" AND
        # those fields are still empty. Other channels stay empty and use
        # the generic fallback in ``style_block(channel)``.
        #
        # Idempotent: only overwrites empty fields. Once the user edits the
        # voice in the UI, this never touches it again.
        from app.services.claude_cli_service import (
            STYLE_EXAMPLE_TITLE,
            STYLE_EXAMPLE_DESCRIPTION,
            STYLE_EXAMPLE_TAGS,
        )
        await conn.execute(
            _sa_text(
                """
                UPDATE channels
                SET ai_example_title = :title
                WHERE name = 'YomiBeats' AND (ai_example_title IS NULL OR ai_example_title = '')
                """
            ),
            {"title": STYLE_EXAMPLE_TITLE},
        )
        await conn.execute(
            _sa_text(
                """
                UPDATE channels
                SET ai_example_description = :desc
                WHERE name = 'YomiBeats' AND (ai_example_description IS NULL OR ai_example_description = '')
                """
            ),
            {"desc": STYLE_EXAMPLE_DESCRIPTION},
        )
        await conn.execute(
            _sa_text(
                """
                UPDATE channels
                SET ai_example_tags = :tags
                WHERE name = 'YomiBeats' AND (ai_example_tags IS NULL OR ai_example_tags = '')
                """
            ),
            {"tags": STYLE_EXAMPLE_TAGS},
        )
