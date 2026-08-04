from __future__ import annotations

import os
from pathlib import Path

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    # NEVER default this to True. Enabling it sets SQLAlchemy ``echo=True``
    # which logs every SQL statement (often 10s of KB per row of column
    # metadata). Under any real load — especially during composes where
    # progress writes fire ~1/sec — the synchronous stderr writes block
    # the aiosqlite worker threads and serialise every other DB request
    # behind them. CPU stays at 20%, GPU at 30%, and the UI feels
    # sluggish because every API call is waiting on log I/O. Operator
    # pain (2026-05-17) — left on from earlier development. Override
    # via ``YTS_DEBUG=true`` env var when actually debugging SQL.
    debug: bool = False
    host: str = "127.0.0.1"
    port: int = 8000
    frontend_url: str = "http://localhost:5173"
    ffmpeg_path: str = "ffmpeg"
    ffprobe_path: str = "ffprobe"
    # Optional override for the Node binary used to run the visualizer engine
    # sidecar. Empty string means "whatever ``node`` resolves to on PATH".
    node_path: str = ""
    # Optional override for the Claude Code CLI binary used by
    # ``claude_cli_service`` to generate metadata against subscription credits.
    # Empty string means "whatever ``claude`` resolves to on PATH".
    claude_cli_path: str = ""

    # Optional YouTube Data API v3 key (server / "API key" type, NOT OAuth).
    # When set, the keyword research service can fetch trending videos and
    # tag frequencies to feed into the Claude metadata prompt. Without it,
    # research falls back to YouTube autocomplete only (still useful but
    # missing trending tag data). Get one at
    # https://console.cloud.google.com → APIs & Services → Credentials.
    youtube_api_key: str = ""

    # Derived paths
    project_root: Path = Path(__file__).resolve().parent.parent.parent
    data_dir: Path = Path(__file__).resolve().parent.parent.parent / "data"
    db_path: Path = Path(__file__).resolve().parent.parent.parent / "data" / "studio.db"
    assets_dir: Path = Path(__file__).resolve().parent.parent.parent / "data" / "assets"
    key_path: Path = Path(__file__).resolve().parent.parent.parent / "data" / "studio.key"

    class Config:
        env_prefix = "YTS_"
        # Resolve from the repository root so `python backend/run.py`,
        # `uvicorn` started from backend/, and the documented quick-start all
        # read the same configuration file.
        env_file = Path(__file__).resolve().parents[2] / ".env"
        env_file_encoding = "utf-8"


settings = Settings()

# Ensure directories exist
settings.data_dir.mkdir(parents=True, exist_ok=True)
settings.assets_dir.mkdir(parents=True, exist_ok=True)
