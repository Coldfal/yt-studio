# YT Studio

YT Studio is a local-first production workspace for people running music, ambience, and visualizer-based YouTube channels. It keeps your media library, channel configuration, generated videos, and encrypted credentials on your own machine.

> **Local machine only.** The API deliberately has no user authentication. Keep the backend bound to `127.0.0.1`; do not expose port 8000 to your LAN or the internet.

## What it does

- Manage multiple channel workspaces, their assets, visualizer presets, metadata templates, and schedules.
- Import music and images, or connect optional providers for AI-generated music, images, and metadata.
- Preview and render audio-reactive visualizers using a Node renderer and FFmpeg.
- Create videos manually or through a one-click/cron-driven workflow.
- Upload through YouTube OAuth and run a long-lived RTMP stream when configured.
- Track background work in a local SQLite database with live progress updates.

## What it is not

- A hosted service, multi-user product, or secure network API.
- A guarantee of views, monetisation, or platform-policy compliance.
- A source of media rights. You are responsible for the rights to every asset you use and for complying with YouTube and provider terms.

## Requirements

- Python 3.11+
- Node.js 20+
- FFmpeg and ffprobe on `PATH` (or paths configured in `.env`)
- Optional: Claude CLI/API, YouTube Data API key, Suno session, and OpenAI key, depending on features you enable
- A Google OAuth web client for YouTube uploads

## Quick start

```powershell
# Backend
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt -r requirements-dev.txt

# Frontend
cd ..\frontend
npm ci

# Visualizer renderer
cd ..\backend\visualizer_engine
npm ci
npm run build

# Local configuration: copy the example, never commit the real file.
cd ..\..
Copy-Item .env.example .env
```

Start the backend and frontend in separate terminals:

```powershell
cd backend
.\venv\Scripts\python.exe run.py
```

```powershell
cd frontend
npm run dev
```

Open `http://127.0.0.1:5173`. A first run creates `data/studio.db` and `data/studio.key`; both are private local state and are ignored by Git.

For a guided setup, see [docs/ONBOARDING.md](docs/ONBOARDING.md). The backend API reference is available at `http://127.0.0.1:8000/docs` while it is running.

## Configuration and data

`.env` only configures local runtime details such as ports and FFmpeg paths. Enter provider credentials in **Settings**; they are encrypted in the local SQLite database using the key in `data/studio.key`.

Back up the entire `data/` directory privately. Never commit, upload, or attach it to an issue. See [docs/SECURITY.md](docs/SECURITY.md) and [docs/OPERATIONS.md](docs/OPERATIONS.md).

## Development and checks

```powershell
cd backend
.\venv\Scripts\python.exe -m pytest

cd ..\backend\visualizer_engine
npm run build

cd ..\..\frontend
npm run lint
npm run build
```

CI runs these checks on pull requests. See [CONTRIBUTING.md](CONTRIBUTING.md) for the contribution workflow and [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) for project architecture and debugging.

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Onboarding](docs/ONBOARDING.md)
- [Development](docs/DEVELOPMENT.md)
- [Operations](docs/OPERATIONS.md)
- [Security](docs/SECURITY.md)
- [Troubleshooting](docs/TROUBLESHOOTING.md)
- [API reference](docs/API.md)

## Licence

YT Studio source code is licensed under [Apache-2.0](LICENSE). Dependencies, FFmpeg binaries, fonts, and user-supplied media have their own terms; see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
