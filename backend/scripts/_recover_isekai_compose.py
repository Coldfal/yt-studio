"""Recover the orphaned ffmpeg output for project 109 (Isekai Radio).

The compose task (272) was watchdog-killed at frame 103351/109559 (90.2%),
but ffmpeg orphaned and kept running. It finished cleanly, writing the moov
atom. This script registers the resulting file as an Asset and links it to
the project so the wizard picks it up.

Safe to re-run: it skips if an Asset row already exists for the filepath.
"""
import asyncio
import sys
from pathlib import Path

# Make `app` importable when run from the scripts/ dir
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.config import settings
from app.database import async_session
from app.models import Asset, VideoProject


PROJECT_ID = 109
CHANNEL_ID = 4
FILENAME = "isekai-radio_fantasy-music_2026-05-11_spectrum_e2e0c1.mp4"
RELATIVE_FILEPATH = f"{CHANNEL_ID}/composed/{FILENAME}"
DURATION_SECONDS = 3651.97  # ffprobe confirmed
ABS_PATH = settings.assets_dir / str(CHANNEL_ID) / "composed" / FILENAME


async def main() -> None:
    if not ABS_PATH.exists():
        print(f"FAIL: file not found at {ABS_PATH}")
        return

    file_size = ABS_PATH.stat().st_size
    print(f"file: {ABS_PATH}")
    print(f"size: {file_size:,} bytes  duration: {DURATION_SECONDS:.2f}s")

    async with async_session() as session:
        # Idempotency: don't double-register if a row already exists.
        existing = (await session.execute(
            select(Asset).where(Asset.filepath == RELATIVE_FILEPATH)
        )).scalar_one_or_none()
        if existing:
            asset_id = existing.id
            print(f"asset already registered: id={asset_id}")
        else:
            asset = Asset(
                channel_id=CHANNEL_ID,
                asset_type="composed",
                source="composed",
                filename=FILENAME,
                filepath=RELATIVE_FILEPATH,
                file_size=file_size,
                duration_seconds=DURATION_SECONDS,
                mime_type="video/mp4",
            )
            session.add(asset)
            await session.flush()
            asset_id = asset.id
            print(f"new asset registered: id={asset_id}")

        project = await session.get(VideoProject, PROJECT_ID)
        if project is None:
            print(f"FAIL: project {PROJECT_ID} not found")
            return

        old_status = project.status
        old_asset = project.composed_asset_id
        project.composed_asset_id = asset_id
        project.status = "composed"
        await session.commit()
        print(
            f"project {PROJECT_ID}: status {old_status!r} -> 'composed', "
            f"composed_asset_id {old_asset} -> {asset_id}"
        )

    print("Done. Reload the wizard for project 109; it should now show Step 3 ready.")


if __name__ == "__main__":
    asyncio.run(main())
