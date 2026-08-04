"""Regression coverage for the farm-redesign work.

Each test here is anchored to a specific bug that hit production or
would have hit production without the fix:

- ``test_delete_channel_cascades_legacy_tables``: covers the
  ``NOT NULL constraint failed: automation_presets.channel_id`` bug —
  SQLite can't ALTER FK ondelete after table creation, so the
  delete_channel endpoint has to manually delete from six legacy
  tables before deleting the channel itself.
- ``test_asset_set_cross_channel_rejected``: covers the validation
  path that rejects creating a Set whose background or thumbnail
  belongs to a different channel.
- ``test_recent_titles_injection``: covers the prompt-side memory of
  the channel's last 12 titles, which closed the "drift with me"
  three-runs-in-a-row repetition bug.
- ``test_studio_sync_ingests_ctr``: covers the Phase-6 Studio sync
  path — fills impressions + CTR on today's snapshot and verifies the
  values round-trip.
- ``test_bandit_multi_kind_recompute``: covers the Phase-3 bandit
  refactor where title / description / tag share one scoring loop
  with different token extractors.
"""
from __future__ import annotations

from datetime import date, datetime

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import select

from app.database import async_session
from app.main import app
from app.models import (
    Asset,
    AssetSet,
    AutomationPreset,
    AutomationRun,
    BackgroundTask,
    Channel,
    LiveStream,
    Prompt,
    VideoAnalyticsSnapshot,
    VideoProject,
    VisualizerPreset,
)


@pytest.fixture
async def client():
    """Async HTTP client wired to the in-memory FastAPI app."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        yield c


# ──────────────────────────────────────────────────────────────────────
# 1) Channel delete cascade
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_delete_channel_cascades_legacy_tables(
    db, channel: Channel, preset: AutomationPreset, image_assets, video_project,
):
    """Deleting a channel must remove every dependent row across the
    six legacy NO-ACTION FK tables (assets, prompts, video_projects,
    automation_presets, live_streams, visualizer_presets) without
    NULL-violating any NOT NULL channel_id column. Previously failed
    with: NOT NULL constraint failed: automation_presets.channel_id.
    """
    # Add a few dependents the standard fixtures don't cover.
    db.add(Prompt(
        channel_id=channel.id, name="hook", content="hi", prompt_type="title",
    ))
    db.add(LiveStream(channel_id=channel.id, status="idle", title="test stream"))
    db.add(VisualizerPreset(
        channel_id=channel.id, name="default", preset_id="spectrum",
        config={},
    ))
    db.add(BackgroundTask(
        task_type="automation_run", status="failed", channel_id=channel.id,
    ))
    # automation_runs reference a preset AND a project — the bug
    # scenario where SQLite NO-ACTION FK on project_id wouldn't
    # cascade. The endpoint pre-deletes runs before projects.
    db.add(AutomationRun(
        preset_id=preset.id,
        project_id=video_project.id,
        status="completed",
        started_at=datetime.utcnow(),
    ))
    await db.commit()

    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.delete(f"/api/channels/{channel.id}")
    assert resp.status_code == 204, resp.text

    # Channel + every dependent row gone.
    async with async_session() as s:
        for model in (
            Channel, AutomationPreset, AutomationRun, VideoProject, Asset,
            Prompt, LiveStream, VisualizerPreset, BackgroundTask,
        ):
            n = (await s.execute(
                select(model).where(getattr(model, "channel_id", model.id) == channel.id)
                if hasattr(model, "channel_id")
                else select(model).where(model.id == channel.id)
            )).all()
            assert len(n) == 0, f"{model.__name__} still has rows for channel"


@pytest.mark.asyncio
async def test_delete_channel_404_when_missing(db):
    """Deleting a non-existent channel returns 404, not 500."""
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.delete("/api/channels/99999")
    assert resp.status_code == 404


# ──────────────────────────────────────────────────────────────────────
# 2) Asset Sets validation
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_asset_set_cross_channel_rejected(db, channel, image_assets):
    """Cannot create a Set whose assets belong to a different channel.
    Guards against the operator picking the wrong channel in the UI
    + accidentally cross-wiring assets.
    """
    # Make a second channel + image asset on it.
    other = Channel(name="Other", niche="custom")
    db.add(other)
    await db.flush()
    other_img = Asset(
        channel_id=other.id, asset_type="image", source="imported",
        filename="other.png", filepath=f"{other.id}/image/other.png",
        file_size=1, mime_type="image/png",
    )
    db.add(other_img)
    await db.commit()

    body = {
        "channel_id": channel.id,
        "name": "x",
        "background_asset_id": other_img.id,  # belongs to OTHER channel
        "thumbnail_asset_id": image_assets[0].id,
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post("/api/asset-sets", json=body)
    assert resp.status_code == 400, resp.text
    assert "different channel" in resp.text.lower()


@pytest.mark.asyncio
async def test_asset_set_create_and_toggle(db, channel, image_assets):
    """Happy path: create + toggle-active + list with the channel filter."""
    body = {
        "channel_id": channel.id,
        "name": "test-set",
        "background_asset_id": image_assets[0].id,
        "thumbnail_asset_id": image_assets[1].id,
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post("/api/asset-sets", json=body)
        assert resp.status_code == 201, resp.text
        sid = resp.json()["id"]

        # Toggle to inactive, then back.
        r1 = await c.post(f"/api/asset-sets/{sid}/toggle-active")
        assert r1.status_code == 200
        assert r1.json()["is_active"] is False
        r2 = await c.post(f"/api/asset-sets/{sid}/toggle-active")
        assert r2.json()["is_active"] is True

        # Channel-scoped list returns exactly the one we created.
        r3 = await c.get(f"/api/asset-sets?channel_id={channel.id}")
        assert r3.status_code == 200
        assert len(r3.json()) == 1
        assert r3.json()[0]["name"] == "test-set"


@pytest.mark.asyncio
async def test_asset_set_cascades_when_background_deleted(
    db, channel, image_assets,
):
    """When the bg asset is deleted, the Set should vanish too —
    Quick Generate's next pick must not silently break on a dangling
    pointer. FK declared CASCADE on background_asset_id.
    """
    s = AssetSet(
        channel_id=channel.id, name="dies-with-bg",
        background_asset_id=image_assets[0].id,
        thumbnail_asset_id=image_assets[1].id,
    )
    db.add(s)
    await db.commit()
    set_id = s.id

    # Delete the bg asset.
    await db.delete(image_assets[0])
    await db.commit()

    async with async_session() as s2:
        survived = await s2.get(AssetSet, set_id)
    assert survived is None, "Set should cascade-delete when bg asset is removed"


# ──────────────────────────────────────────────────────────────────────
# 3) Recent-titles avoidance
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_recent_titles_injection(
    db, channel, preset, music_assets, image_assets, monkeypatch,
):
    """generate_metadata must inject the channel's last 12 shipped
    youtube_titles as a 'RECENT TITLES — do NOT repeat' block so
    Claude can't pick the same hook three runs in a row.
    """
    # Seed 5 published projects with distinct titles.
    titles = [
        "[Playlist] drift with me | …",
        "[Playlist] chill with me | …",
        "[Playlist] stay with me | …",
        "Quiet Hours · Tokyo · Lofi",
        "Velvet Window · Late Night",
    ]
    for t in titles:
        db.add(VideoProject(
            channel_id=channel.id, title=t, youtube_title=t,
            status="uploaded",
        ))
    await db.commit()

    # Intercept the Claude call so we can see what's in the user_prompt.
    captured: dict = {}

    async def _fake_run_cli(prompt: str, system_prompt: str) -> str:
        captured["prompt"] = prompt
        captured["system"] = system_prompt
        # Return a minimally-valid metadata JSON.
        return '{"title":"x","description":"y","tags":["t1"],"category_id":"10"}'

    from app.services import claude_cli_service as ccs
    monkeypatch.setattr(ccs.claude_cli_service, "_run_cli", _fake_run_cli)

    from app.services.automation_service._shared import generate_metadata
    selected_files = [
        {"filepath": "/tmp/a.mp3", "filename": "a.mp3", "title": "A", "duration_seconds": 120},
        {"filepath": "/tmp/b.mp3", "filename": "b.mp3", "title": "B", "duration_seconds": 130},
    ]
    config = {
        "channel_id": channel.id,
        "channel_name": channel.name,
        "channel_niche": channel.niche,
        "metadata_mode": "claude",
        "brand_identity": "",
        "target_audience": "",
        "title_template": None,
        "description_template": None,
        "tags_template": None,
        "claude_prompt": None,
        "youtube_privacy": "private",
        "youtube_category_id": "10",
        "made_for_kids": False,
        "auto_upload": False,
        "terse_metadata": False,
    }
    await generate_metadata(config, selected_files, 250.0)

    user_prompt = captured.get("prompt", "")
    assert "RECENT TITLES" in user_prompt, user_prompt[:600]
    # All five seeded titles must appear.
    for t in titles:
        assert t in user_prompt, f"missing recent title: {t!r}"


# ──────────────────────────────────────────────────────────────────────
# 4) Studio sync
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_studio_sync_ingests_ctr(db, channel):
    """Phase 6: POST /studio-sync/{cid} ingests CTR + impressions into
    today's VideoAnalyticsSnapshot rows. Must accept both ctr_pct and
    ctr (fraction), and never clobber pre-existing view_count.
    """
    today = date.today()
    # Pre-existing snapshot with public counts already populated.
    db.add(VideoAnalyticsSnapshot(
        channel_id=channel.id,
        youtube_video_id="vid-existing",
        snapshot_date=today,
        view_count=10_000,
        like_count=50,
        comment_count=5,
        views_per_day=320.0,
    ))
    await db.commit()

    body = {
        "rows": [
            {"video_id": "vid-existing", "impressions": 99_000, "ctr_pct": 4.8},
            {"video_id": "vid-new", "impressions": 1820, "ctr": 0.073},
            {"video_id": "vid-skip"},  # no metrics → skipped
        ],
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.post(f"/api/analytics/studio-sync/{channel.id}", json=body)
    assert resp.status_code == 200, resp.text
    summary = resp.json()
    assert summary["skipped"] == 1, summary
    assert summary["updated"] + summary["created"] == 2

    # Existing row got CTR + impressions, view_count untouched.
    async with async_session() as s:
        existing = (await s.execute(
            select(VideoAnalyticsSnapshot).where(
                VideoAnalyticsSnapshot.youtube_video_id == "vid-existing"
            )
        )).scalar_one()
        assert existing.impressions == 99_000
        assert existing.ctr is not None and abs(existing.ctr - 0.048) < 1e-6
        assert existing.view_count == 10_000, "view_count must not be clobbered"

        new_row = (await s.execute(
            select(VideoAnalyticsSnapshot).where(
                VideoAnalyticsSnapshot.youtube_video_id == "vid-new"
            )
        )).scalar_one()
        assert new_row.impressions == 1820
        assert abs(new_row.ctr - 0.073) < 1e-6


# ──────────────────────────────────────────────────────────────────────
# 5) Bandit multi-kind
# ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_bandit_multi_kind_recompute(db, channel):
    """Phase 3: recompute_token_stats now walks title / description /
    tag in one pass. Seed snapshots with all three fields and confirm
    each kind gets non-empty token rows.
    """
    today = date.today()
    # 9 snapshots so we're over MIN_VIDEOS_FOR_BANDIT (8).
    for i in range(9):
        db.add(VideoAnalyticsSnapshot(
            channel_id=channel.id,
            youtube_video_id=f"v{i}",
            snapshot_date=today,
            view_count=1000 * (i + 1),
            like_count=10 * i,
            comment_count=i,
            views_per_day=50.0 * (i + 1),
            title_at_snapshot=f"chill beats vol {i} · lofi rap study",
            description_at_snapshot=(
                "Late-night focus playlist with mellow beats. "
                "Perfect for studying, working, or just unwinding.\n\n"
                "TRACKLIST\n00:00 …"
            ),
            tags_at_snapshot=[
                "lofi", "chill rap", f"vol{i}", "study music",
            ],
            avg_view_percentage=0.4 + (i * 0.01),
        ))
    await db.commit()

    from app.services.title_bandit_service import recompute_token_stats
    summary = await recompute_token_stats(channel.id)
    assert summary["samples_seen"] == 9

    from app.models import TitleTokenStat
    async with async_session() as s:
        for kind in ("title", "description", "tag"):
            n = (await s.execute(
                select(TitleTokenStat).where(
                    TitleTokenStat.channel_id == channel.id,
                    TitleTokenStat.kind == kind,
                )
            )).all()
            assert len(n) > 0, f"no tokens for kind={kind}"

        # Verify the 'tag' kind preserved the verbatim tag strings.
        tag_rows = (await s.execute(
            select(TitleTokenStat).where(
                TitleTokenStat.channel_id == channel.id,
                TitleTokenStat.kind == "tag",
            )
        )).scalars().all()
        tag_tokens = {r.token for r in tag_rows}
        assert "lofi" in tag_tokens
        assert "chill rap" in tag_tokens
        assert "study music" in tag_tokens


@pytest.mark.asyncio
async def test_thumbnail_template_persists_on_preset(db, channel, preset):
    """Phase 7: AutomationPreset.thumbnail_template stores the
    template JSON. PUT /presets/{id} accepts + round-trips it.
    """
    tpl = {
        "version": 1,
        "bg_source": "picked_background",
        "layers": [
            {"kind": "wordmark", "text": "TOKYO", "x": 0.5, "y": 0.18,
             "font": "Anton", "size": 240, "weight": "bold",
             "align": "center",
             "color_pool": ["#ff3b3b", "#22d3ee"],
             "effect_preset": "long_shadow"},
        ],
        "rotation_seed": "per_video",
    }
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        resp = await c.put(
            f"/api/automation/presets/{preset.id}",
            json={"thumbnail_template": tpl},
        )
        assert resp.status_code == 200, resp.text
        assert resp.json()["thumbnail_template"] == tpl

        # Clear it (null)
        resp2 = await c.put(
            f"/api/automation/presets/{preset.id}",
            json={"thumbnail_template": None},
        )
        assert resp2.status_code == 200
        assert resp2.json()["thumbnail_template"] is None


@pytest.mark.asyncio
async def test_standalone_thumbnail_upload(db, channel):
    """Phase 7: POST /api/projects/upload-thumbnail accepts a JPEG +
    channel_id, creates an Asset with role='thumbnail' + source=
    'generated_template', returns asset_id + file_url. Used by the
    Quick Generate preview drawer before the VideoProject exists.
    """
    # 1×1 black JPEG (smallest valid)
    jpeg_bytes = bytes.fromhex(
        "ffd8ffe000104a46494600010100000100010000ffdb004300080606070605080707"
        "07090908"
        + ("0a" * 60)  # padding to keep it short but well-formed
        + "ffd9"
    )
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as c:
        files = {"file": ("test.jpg", jpeg_bytes, "image/jpeg")}
        data = {"channel_id": str(channel.id)}
        resp = await c.post(
            "/api/projects/upload-thumbnail",
            data=data,
            files=files,
        )
    assert resp.status_code == 200, resp.text
    body = resp.json()
    assert body["asset_id"] > 0
    assert body["file_url"].startswith("/files/")
    # Verify the Asset row landed with the right role + source.
    async with async_session() as s:
        from app.models import Asset as _Asset
        a = await s.get(_Asset, body["asset_id"])
        assert a is not None
        assert a.role == "thumbnail"
        assert a.source == "generated_template"
        assert a.channel_id == channel.id


@pytest.mark.asyncio
async def test_translate_metadata_drops_source_language(monkeypatch):
    """2026-05-16 regression: ``translate_metadata`` must silently drop
    any target code that matches ``source_language`` (translating
    ko→ko is a no-op). The Korean-master yomii studio channel was
    previously offering Korean in its translation picker — a UX bug
    that compounded into wasted Claude calls. Backend now self-defends
    by filtering in the service layer.
    """
    from app.services import claude_cli_service as ccs

    captured: dict = {}

    async def _fake_run(prompt: str, system_prompt: str, **kw) -> str:
        captured["prompt"] = prompt
        return '{"en":{"title":"x","description":"y"},"ja":{"title":"x","description":"y"},"es":{"title":"x","description":"y"}}'

    monkeypatch.setattr(ccs.claude_cli_service, "_run_cli", _fake_run)

    # ko-master, ask for [en, ja, ko, es] — the ko must be dropped.
    out = await ccs.claude_cli_service.translate_metadata(
        title="새벽 감성",
        description_top="조용한 밤이야.",
        target_languages=["en", "ja", "ko", "es"],
        source_language="ko",
    )
    # The prompt's TARGET LANGUAGES block must NOT include "ko" — that
    # block is the part following "TARGET LANGUAGES (use these exact
    # codes as JSON keys):", everything before that is fine to mention
    # Korean (the source description IS in Korean).
    p = captured.get("prompt", "")
    target_block_start = p.find("TARGET LANGUAGES (use these exact codes")
    assert target_block_start != -1, "target languages section missing"
    target_block = p[target_block_start:]
    assert '"ko"' not in target_block, (
        f"'ko' leaked into target languages — should have been filtered.\n"
        f"target block:\n{target_block[:400]}"
    )
    assert '"en"' in target_block, "expected 'en' in target list"
    assert '"ja"' in target_block, "expected 'ja' in target list"
    # When EVERY target equals source, function returns empty without
    # ever calling Claude.
    out2 = await ccs.claude_cli_service.translate_metadata(
        title="t", description_top="d",
        target_languages=["ko"], source_language="ko",
    )
    assert out2 == {}, (
        f"asking for ko→ko alone should return empty (no-op), got {out2}"
    )


@pytest.mark.asyncio
async def test_bandit_feedback_weighting(db, channel):
    """Phase 3: MetadataFeedback rows contribute a synthetic 'fb_lift'
    term so cold-start channels can rank purely on operator gut signal.
    Token that appears in 3 thumbs-up rows should outscore one that
    appears in 3 thumbs-down rows.
    """
    from app.models import MetadataFeedback

    today = date.today()
    # Two real snapshots so the bandit doesn't bail out for being empty.
    for i in range(2):
        db.add(VideoAnalyticsSnapshot(
            channel_id=channel.id,
            youtube_video_id=f"r{i}",
            snapshot_date=today,
            view_count=100, like_count=5, comment_count=0,
            views_per_day=10.0,
            title_at_snapshot="neutral baseline title",
        ))
    # Up-votes for "golden", down-votes for "stale".
    for _ in range(3):
        db.add(MetadataFeedback(
            channel_id=channel.id,
            generated_title="golden vibe playlist",
            operator_rating=1,
        ))
    for _ in range(3):
        db.add(MetadataFeedback(
            channel_id=channel.id,
            generated_title="stale boring tracks",
            operator_rating=-1,
        ))
    await db.commit()

    from app.services.title_bandit_service import recompute_token_stats
    await recompute_token_stats(channel.id, kinds=("title",))

    from app.models import TitleTokenStat
    async with async_session() as s:
        golden_row = (await s.execute(
            select(TitleTokenStat).where(
                TitleTokenStat.channel_id == channel.id,
                TitleTokenStat.kind == "title",
                TitleTokenStat.token == "golden",
            )
        )).scalar_one_or_none()
        stale_row = (await s.execute(
            select(TitleTokenStat).where(
                TitleTokenStat.channel_id == channel.id,
                TitleTokenStat.kind == "title",
                TitleTokenStat.token == "stale",
            )
        )).scalar_one_or_none()
    assert golden_row is not None and stale_row is not None
    assert golden_row.score > stale_row.score, (
        f"thumbs-up token should outscore thumbs-down "
        f"(golden={golden_row.score:.3f} vs stale={stale_row.score:.3f})"
    )
