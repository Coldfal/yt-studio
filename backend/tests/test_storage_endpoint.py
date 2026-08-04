"""Tests for ``GET /api/stats/storage``.

The endpoint is the data source for the dashboard's per-channel
storage line and the Phase 3 retention worker's per-channel disk-cap
enforcement. Pin its shape so neither breaks silently.
"""
from __future__ import annotations

import pytest

from app.api.stats import storage_stats
from app.models import Asset


pytestmark = pytest.mark.asyncio


async def test_storage_returns_one_row_per_channel(db, channel):
    # Drop a couple of assets in different categories.
    db.add_all([
        Asset(
            channel_id=channel.id, asset_type="music", source="upload",
            filename="a.mp3", filepath=f"{channel.id}/music/a.mp3",
            file_size=1_000_000, mime_type="audio/mpeg",
        ),
        Asset(
            channel_id=channel.id, asset_type="image", source="upload",
            filename="b.png", filepath=f"{channel.id}/image/b.png",
            file_size=500_000, mime_type="image/png",
        ),
        Asset(
            channel_id=channel.id, asset_type="composed", source="composed",
            filename="c.mp4", filepath=f"{channel.id}/composed/c.mp4",
            file_size=10_000_000, mime_type="video/mp4",
        ),
    ])
    await db.commit()

    rows = await storage_stats(db=db)
    assert len(rows) == 1
    row = rows[0]
    assert row["channel_id"] == channel.id
    assert row["channel_name"] == channel.name
    assert row["total_bytes"] == 11_500_000
    assert row["asset_count"] == 3
    assert row["by_type"]["music"]["bytes"] == 1_000_000
    assert row["by_type"]["music"]["count"] == 1
    assert row["by_type"]["image"]["bytes"] == 500_000
    assert row["by_type"]["composed"]["bytes"] == 10_000_000


async def test_storage_excludes_channels_with_no_assets(db, channel):
    # No assets attached.
    rows = await storage_stats(db=db)
    assert rows == []


async def test_storage_handles_null_file_size(db, channel):
    # Some asset rows have file_size=None (e.g. when migrated from an
    # older row that never had it set). Should treat as zero, not NPE.
    db.add(Asset(
        channel_id=channel.id, asset_type="music", source="upload",
        filename="missing_size.mp3",
        filepath=f"{channel.id}/music/missing_size.mp3",
        file_size=None, mime_type="audio/mpeg",
    ))
    db.add(Asset(
        channel_id=channel.id, asset_type="music", source="upload",
        filename="real_size.mp3",
        filepath=f"{channel.id}/music/real_size.mp3",
        file_size=2_000_000, mime_type="audio/mpeg",
    ))
    await db.commit()

    rows = await storage_stats(db=db)
    assert rows[0]["total_bytes"] == 2_000_000
    assert rows[0]["asset_count"] == 2
