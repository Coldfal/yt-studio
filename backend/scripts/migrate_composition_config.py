"""One-off migration for video_projects with video_style='spectrum'.

The old pipeline stored Python/Pillow-shaped configs (trap_preset, bg_blur,
bg_darken, glow, gradient, etc.). The new Node-based engine expects a
`ProjectConfig` shape ported from the Music Visualiser — different field
names and a bunch of new knobs.

This script walks every spectrum project and rewrites composition_config
to the new shape, preserving user intent where possible:
  trap_preset     -> waveColor1/waveColor2   (via lookup table)
  bg_blur         -> backgroundBlur
  bg_darken       -> backgroundDarken
  rotation_speed  -> (dropped — per-frame rotation not in MV)
  smoothing       -> waveformSmoothing
  text_top        -> artistName
  text_bottom     -> trackName
  everything else -> dropped (new defaults applied)

Run with:
  cd backend
  ./venv/Scripts/python.exe scripts/migrate_composition_config.py [--dry-run]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import sys
from pathlib import Path

# Allow running as a script from the repo root or from backend/
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from sqlalchemy import select

from app.database import async_session
from app.models import VideoProject


logging.basicConfig(level=logging.INFO, format="%(levelname)s: %(message)s")
logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Trap preset → (waveColor1, waveColor2) mapping
# ---------------------------------------------------------------------------
# The MV editor only exposes two main wave colours. We map each old multi-layer
# preset to its most-representative hue pair.

TRAP_PRESET_COLOURS: dict[str, tuple[str, str]] = {
    "classic":      ("#ffffff", "#ff5a32"),   # white → red-orange
    "neon_purple":  ("#8c9cff", "#b414b4"),
    "cyber_pink":   ("#ff96dc", "#b40a64"),
    "arctic":       ("#e6f5ff", "#1e78c8"),
    "inferno":      ("#fff064", "#96100f"),
    "mint":         ("#b4ffd2", "#148c64"),
    "monochrome":   ("#ffffff", "#a0a0a0"),
    "sunset_glow":  ("#ffd2aa", "#82288c"),
}


def migrate_config(old: dict) -> dict:
    """Return a new MV-shaped composition_config for an old spectrum config."""
    new: dict = {
        # Mirrors DEFAULT_PROJECT_CONFIG — kept in sync with MV types.ts
        "presetId": "trap-nation",
        "waveformScale": 1.0,
        "waveformSmoothing": 0.7,
        "reactivity": 1.0,
        "spectrumFill": "filled",
        "linearPosition": "center",
        "linearRepeat": 1,
        "linearBarColor": "#ff4444",
        "linearYOffset": 0,
        "linearWidth": 0.98,
        "linearCenterTextSource": "none",
        "linearCenterText": "",
        "linearCenterTextSize": 140,
        "linearCenterTextOffsetY": 0,
        "customTexts": [],
        "waveColor1": "#ffffff",
        "waveColor2": "#a855f7",
        "backgroundColor": "#0f0f1a",
        "accentColor": "#ec4899",
        "artistName": "",
        "trackName": "",
        "fontFamily": "Geist",
        "fontSize": 32,
        "textPosition": "bottom",
        "textColor": "#ffffff",
        "backgroundFit": "cover",
        "reflection": "none",
        "backgroundRotate": 0,
        "backgroundFilter": False,
        "backgroundDrift": False,
        "backgroundRumble": False,
        "backgroundBlur": 20,
        "backgroundDarken": 0.7,
        "particles": True,
        "particleStyle": "floating",
        "particleDensity": 50,
        "particleColor": "#ffffff",
        "logoEnabled": True,
        "logoScale": 1.0,
        "logoBorderRadius": 50,
        "overlayEnabled": False,
        "overlayPosition": "bottom-right",
        "overlayScale": 0.5,
        "overlayOpacity": 0.8,
        "overlayOffsetX": 0,
        "overlayOffsetY": 0,
        "backgroundType": "image",
        "beatShake": True,
        "beatZoom": True,
        "beatShakeIntensity": 0.6,
        "beatZoomIntensity": 0.5,
        # Output settings
        "output_width": 1920,
        "output_height": 1080,
        "output_fps": 30,
        "crf": 23,
    }

    if not isinstance(old, dict):
        return new

    # Colour preset → wave colours
    trap_preset = old.get("trap_preset")
    if isinstance(trap_preset, str) and trap_preset in TRAP_PRESET_COLOURS:
        c1, c2 = TRAP_PRESET_COLOURS[trap_preset]
        new["waveColor1"] = c1
        new["waveColor2"] = c2

    # Direct numeric mappings (new key -> old key)
    direct_maps: list[tuple[str, str, float]] = [
        ("backgroundBlur", "bg_blur", None),
        ("backgroundDarken", "bg_darken", None),
        ("waveformSmoothing", "smoothing", None),
    ]
    for new_key, old_key, _ in direct_maps:
        if old_key in old:
            try:
                new[new_key] = float(old[old_key])
            except (TypeError, ValueError):
                pass

    # Text overlays
    if isinstance(old.get("text_top"), str):
        new["artistName"] = old["text_top"]
    if isinstance(old.get("text_bottom"), str):
        new["trackName"] = old["text_bottom"]

    # Boolean toggles
    if "particles" in old:
        new["particles"] = bool(old["particles"])
    if "glow" in old:
        # The new engine doesn't have a single "glow" switch — it's encoded
        # into each preset's draw code. Leaving default (particles on) is
        # the closest approximation.
        pass

    # Output width/height/fps if explicitly set
    for k in ("output_width", "output_height", "output_fps"):
        if k in old:
            try:
                new[k] = int(old[k])
            except (TypeError, ValueError):
                pass

    return new


async def main(dry_run: bool = False) -> None:
    async with async_session() as db:
        result = await db.execute(
            select(VideoProject).where(VideoProject.video_style == "spectrum")
        )
        projects = list(result.scalars().all())
        logger.info("Found %d spectrum project(s) to evaluate", len(projects))

        changed = 0
        for p in projects:
            old_cfg = p.composition_config or {}

            # Already migrated?
            if isinstance(old_cfg, dict) and "presetId" in old_cfg and "waveColor1" in old_cfg:
                logger.info("  project %d already migrated — skipping", p.id)
                continue

            new_cfg = migrate_config(old_cfg)

            logger.info(
                "  project %d: migrating (%d → %d fields)",
                p.id,
                len(old_cfg) if isinstance(old_cfg, dict) else 0,
                len(new_cfg),
            )
            logger.debug("    old=%s", json.dumps(old_cfg)[:200])
            logger.debug("    new=%s", json.dumps(new_cfg)[:200])

            if not dry_run:
                p.composition_config = new_cfg
                changed += 1

        if dry_run:
            logger.info("[dry-run] would have migrated %d project(s)", len(projects))
        else:
            await db.commit()
            logger.info("Migrated %d project(s)", changed)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dry-run", action="store_true",
        help="Print what would change without writing to the DB.",
    )
    args = parser.parse_args()
    asyncio.run(main(dry_run=args.dry_run))
