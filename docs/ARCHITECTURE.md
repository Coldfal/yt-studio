# Architecture

A walkthrough of YT Studio's moving parts — what runs where, how data
flows from "click Quick Generate" to "video on YouTube", and where to
look when something doesn't behave as expected.

This is the ground-truth doc; other docs (`OPERATIONS.md`, `API.md`,
`TROUBLESHOOTING.md`) cross-reference it.

---

## Three runtimes

YT Studio is one app spread across three processes that talk to each
other over `localhost`:

```
              ┌────────────────────────────────────┐
              │  Vite frontend (5173)              │
              │  React 19 + TanStack Query +       │
              │  shadcn/ui + Zustand               │
              └──────────────┬─────────────────────┘
                             │  HTTP + Server-Sent Events
                             ▼
              ┌────────────────────────────────────┐
              │  FastAPI backend (8000)            │
              │  ─────────────────────────         │
              │  • SQLAlchemy / SQLite             │
              │  • task_runner (asyncio worker     │
              │    pools per task type)            │
              │  • automation_scheduler (cron)     │
              │  • retention_worker (daily)        │
              │  • streaming_service (live RTMP)   │
              │  • rate_limiter (per provider/ch.) │
              └────┬─────────────────────────┬─────┘
                   │ spawn                    │ spawn
                   ▼                          ▼
       ┌──────────────────┐   ┌─────────────────────────┐
       │  FFmpeg / probe  │   │  visualizer_engine      │
       │  subprocesses    │   │  (Node + napi-canvas)   │
       └──────────────────┘   └─────────────────────────┘
```

| Process              | Code                              | Port  | What it does                                     |
|----------------------|-----------------------------------|-------|--------------------------------------------------|
| FastAPI backend      | `backend/app/`                    | 8000  | System of record. Owns DB, queue, scheduler.     |
| Vite frontend        | `frontend/`                       | 5173  | UI. No business logic; every action is an API call. |
| Visualizer engine    | `backend/visualizer_engine/`      | n/a   | Per-render Node sidecar. Audio-reactive frames.  |

The frontend has zero awareness of the visualizer engine — it talks
only to the FastAPI backend, which spawns Node sub-processes whenever
a render is needed. The same TypeScript module is also imported
directly by the React app for the in-browser preview, so the editor
shows pixel-equivalent frames to what gets baked into the MP4.

---

## Backend module layout

```
backend/app/
├── api/                      # FastAPI routers (one file per resource)
│   ├── router.py             # Mounts every router under /api/*
│   ├── assets.py             # /api/assets/*
│   ├── automation.py         # /api/automation/*  (Quick Generate, presets)
│   ├── channels.py           # /api/channels/*
│   ├── compose.py            # /api/compose/*     (start render, extend)
│   ├── images.py             # /api/images/*      (DALL·E)
│   ├── metadata.py           # /api/metadata/*    (Claude title/desc/tags)
│   ├── music.py              # /api/music/*       (Suno + folder scan)
│   ├── projects.py           # /api/projects/*
│   ├── prompts.py            # /api/prompts/*     (saved Claude prompts)
│   ├── settings.py           # /api/settings/*    (encrypted API keys)
│   ├── stats.py              # /api/stats/*       (dashboard, quota, retention)
│   ├── streaming.py          # /api/streaming/*   (24/7 live)
│   ├── tasks.py              # /api/tasks/*       (queue + SSE stream)
│   ├── visualizer_presets.py # /api/visualizer-presets/*
│   └── youtube.py            # /api/youtube/*     (OAuth + upload)
├── models/                   # SQLAlchemy ORM (one file per table)
├── schemas/                  # Pydantic request/response models
├── services/                 # Business logic, no FastAPI deps
│   ├── automation_service/   # Phase-2 split orchestrator
│   │   ├── execute_run.py    # Folder-mode (cron presets)
│   │   ├── quick_generate.py # Library-mode (dashboard one-click)
│   │   └── _shared.py        # Track / image selection, metadata
│   ├── compose_service.py    # FFmpeg compose + extend
│   ├── credentials_service.py# Single source for decrypted secrets
│   ├── claude_cli_service.py # Claude Code CLI subprocess wrapper
│   ├── keyword_research_service.py
│   ├── openai_service.py     # DALL·E
│   ├── rate_limiter.py       # Token-bucket per (provider, channel)
│   ├── streaming_service.py  # Live RTMP (visualizer + folder modes)
│   ├── suno_service.py       # Suno music generation
│   ├── visualizer_engine_service.py
│   ├── youtube_service.py    # YouTube Data API v3 + upload
│   └── ytdlp_service.py      # YouTube → MP3 download
├── workers/
│   ├── task_runner.py        # asyncio queue + per-type semaphore pools
│   ├── automation_scheduler.py # cron tick (60s)
│   └── retention_worker.py   # daily 3 AM cleanup
├── utils/                    # crypto, file paths, format helpers
├── config.py                 # pydantic-settings (YTS_* env vars)
├── database.py               # async engine + init_db migrations
├── exceptions.py             # AppError hierarchy + FastAPI handler
├── logging_config.py         # structlog JSON to backend.log
└── main.py                   # FastAPI app + lifespan
```

The split between `api/` and `services/` is strict: handlers are thin
(parse → call service → return), services have no FastAPI dependency
and can be called from the task runner the same way.

---

## Data model

```
Channel ─────┬───── AutomationPreset ───── AutomationRun ─── BackgroundTask
             │
             ├───── Asset ──── (folder_id) ── AssetFolder
             │
             ├───── VideoProject ─── VideoProjectTrack ─── Asset (CASCADE m2m)
             │                  │
             │                  └── composed_asset_id → Asset
             │
             ├───── VisualizerPreset
             └───── LiveStream

AppSetting (key/value, encrypted) — global, not channel-scoped
Prompt (saved Claude prompts) — channel-scoped
```

Key invariants:

- **Cascade**: deleting a `Channel` removes all owned children
  (`Asset`, `AutomationPreset`, `VideoProject`, `VisualizerPreset`,
  `LiveStream`). Composed videos cascade with the project.
- **m2m tracks**: `VideoProject.tracks` is the source of truth. The
  legacy `music_asset_ids` JSON column is double-written for backward
  compat; `get_project_track_ids()` reads the table first and falls
  back to the JSON, then to the single `music_asset_id` FK.
- **Encrypted columns**: `Channel.youtube_credentials_json` (OAuth
  refresh token + access token), `AppSetting.value` for keys flagged
  encrypted, all via `app.utils.crypto` (Fernet).
- **`updated_at` on every row**: standardised in Phase 0.

---

## Task lifecycle

Every long-running operation goes through `BackgroundTask`. The 9 task
types are:

| Type                       | Concurrency | Timeout | Retries |
|----------------------------|-------------|---------|---------|
| `video_composition`        | 2           | 60 min  | 0       |
| `video_extend`             | 2           | 30 min  | 0       |
| `youtube_upload`           | 2           | 30 min  | 2       |
| `metadata_generation`      | 3           | 5 min   | 1       |
| `music_generation`         | 1           | 20 min  | 1       |
| `image_generation`         | 1           | 5 min   | 1       |
| `youtube_audio_download`   | 1           | 20 min  | 2       |
| `youtube_chapters_download`| 1           | 30 min  | 1       |
| `automation_run`           | 4           | 90 min  | 0       |

Concurrency is enforced by `asyncio.Semaphore` per type — one global
queue, type-aware admission. `automation_run` orchestrates child tasks
(it doesn't itself call FFmpeg), so it gets a higher budget.

State machine: `pending → running → (completed | failed | cancelled)`.
Progress writes go to `BackgroundTask.progress` (0.0–1.0) and stream
out via SSE on `/api/tasks/stream`. The frontend `useTaskSSE` hook
multiplexes one connection across all task subscribers, with
exponential-backoff reconnection.

Retries fire only on `RETRYABLE_EXCEPTIONS` (network timeout, HTTP
5xx, ffmpeg killed). Credential errors (`CredentialError`) are
non-retryable — the user has to re-auth.

---

## Quick Generate flow (single video, end-to-end)

The most common path. User clicks **Generate Video Now** on a channel
card on the dashboard.

```
1. POST /api/automation/channels/{id}/quick-generate
     → BackgroundTask(task_type=automation_run, channel_id=…)
     → task_runner.enqueue()

2. _handle_automation_run picks it up (semaphore: 4 in flight max).
     → automation_service.quick_generate(channel_id, preset_id)

3. quick_generate.run_quick_generate:
     a. Load channel + preset, resolve youtube_creds.
     b. Pick tracks from library (random N or fit-duration).
     c. Pick image (random; deduped against published projects today).
     d. Run Claude metadata generation (title/desc/tags).
     e. (Optional) Auto-translate via Claude.
     f. Create VideoProject + write VideoProjectTrack rows.
     g. compose_service.compose_video(...) → spawns Node sidecar.
        Visualizer engine emits raw RGBA frames; ffmpeg ingests via
        rawvideo pipe + audio file → MP4.
     h. (Optional) compose_service.extend_video(...) — concat-loop
        the MP4 to a target duration via FFmpeg `-c copy` (no re-encode).
     i. (Optional) youtube_service.upload_video(...) — resumable
        videos.insert; follow-up videos.update applies localizations.

4. Each step writes progress to the BackgroundTask + broadcasts SSE.
   Frontend re-renders the dashboard card and project history live.
```

The whole flow is one BackgroundTask row from the user's perspective,
even though it spawns ffmpeg, Node, and Claude CLI subprocesses
internally. If any step fails, the project is marked `failed` with
the error captured on `task.error` and (for upload failures) on
`project.upload_error` so the UI can surface a retry button.

---

## Cron scheduler

`automation_scheduler.py` runs as a coroutine inside the backend
process. Every 60 seconds:

1. Query `automation_presets WHERE is_active=TRUE AND next_run_at <= now()`.
2. For each match: enqueue `BackgroundTask(task_type=automation_run, preset_id=…)`.
3. Compute the next fire time via `croniter` and persist
   `next_run_at` so the schedule advances even if the worker is busy.

On startup, any `next_run_at` that's already overdue gets a single
catch-up run scheduled (not a backfill of every missed slot).

The scheduler also kicks a monthly `VACUUM` on the SQLite DB to keep
it compact.

---

## Live streaming

`streaming_service.py` runs RTMP loops. Two source modes:

- **Visualizer mode**: same engine as compose, but instead of writing
  to disk it pipes raw frames into a long-running `ffmpeg` that
  encodes + pushes to `rtmp://a.rtmp.youtube.com/live2/{key}`.
- **Folder mode**: shuffled MP3/FLAC playlist piped through ffmpeg
  with a static image background — no visualizer, way lower CPU.

Each running stream is one `LiveStream` row + a managed asyncio task
+ a long-lived `ffmpeg` subprocess. On startup the `stream_manager`
scans for orphaned rows (`status=running` but no live process) and
marks them `failed`.

Stream health is checked via the asyncio task — when ffmpeg exits or
the visualizer engine errors out, the stream flips to `failed` and
the operator sees it on the Live page.

---

## Storage

Everything stateful lives in `data/`:

| Path                                | Contents                                        |
|-------------------------------------|-------------------------------------------------|
| `data/studio.db`                    | SQLite — all relational state                   |
| `data/studio.key`                   | Fernet key — encrypts stored credentials        |
| `data/assets/{channel_id}/music/`   | Uploaded + Suno-generated audio                 |
| `data/assets/{channel_id}/image/`   | Uploaded + DALL·E-generated images              |
| `data/assets/{channel_id}/composed/`| Rendered MP4 outputs                            |
| `data/assets/{channel_id}/thumbnail/`| Custom thumbnails                              |

The DB is the single source of truth — `Asset.filepath` references
files under `data/assets/`. Files without a row are considered orphans
and swept by the retention worker. The reverse (rows pointing at
missing files) is handled by the `/api/assets/reconcile` endpoint
(triggered manually from the Library UI's "Clean up missing files"
button).

The retention worker (`workers/retention_worker.py`) runs daily at 3 AM:

- Deletes `BackgroundTask` rows older than 90 days that are
  `completed` or `failed` (keeps `running` / `pending` regardless of age).
- Removes orphan composed-video files (no Asset row).
- Warns when a channel exceeds its disk cap (default 50 GB) — never
  auto-deletes user content.

Per-channel disk usage is exposed at `/api/stats/storage`.

---

## Encryption

`app.utils.crypto` wraps `cryptography.Fernet`. The 32-byte key lives
in `data/studio.key`. On startup, `ensure_key_available()` is called
in the FastAPI lifespan — a missing or corrupt key surfaces as a
clear log message rather than a stack trace mid-request.

What's encrypted:

- `Channel.youtube_credentials_json` — full OAuth refresh blob.
- `AppSetting` rows whose key matches the encrypted-keys list (Claude
  API key, Suno cookie, OpenAI key, etc.).

What's plaintext:

- Asset metadata (filenames, durations, etc.).
- Project metadata (titles, descriptions, tags).
- Composition configs (visualizer params).

Decryption is centralised in `services/credentials_service.py` —
service-layer code calls `get_channel_youtube_credentials()` rather
than instantiating `Fernet` itself. Decrypt failures return `None`
plus a structured warning log so the caller can surface a "reconnect"
prompt.

---

## Logging

`structlog` writes JSON to `backend.log` (one line per event) and
human-readable lines to stdout. Every record carries:

- `task_id` (when in a task handler)
- `channel_id` (when the channel is known)
- `phase` (e.g. `compose`, `metadata_gen`, `upload`)
- `error_type` (when raising)

Use `jq` / `Select-String` to grep by channel:

```bash
# all errors today for channel 2
grep '"channel_id":2' backend.log | grep '"level":"error"'
```

---

## What's NOT here

Intentionally out of scope:

- **Multi-tenant / external users** — single-operator assumption.
- **Cloud deployment** (Docker, Kubernetes) — local-host only. The
  app could run on a VPS via systemd; see `OPERATIONS.md`.
- **CDN / S3 migration** — local disk is fine at the current scale.
  Revisit at 1,000+ videos per channel.
- **Browser-side state syncing across machines** — one box, one
  operator.
- **Video thumbnail generation pipeline** — manual upload supported.

---

## See also

- `README.md` — install / first-run.
- `docs/DEVELOPMENT.md` — local dev workflow, hot-reload caveats.
- `docs/OPERATIONS.md` — deploy, backup, monitoring.
- `docs/API.md` — full endpoint reference.
- `docs/MULTI_CHANNEL.md` — running 5–10 channels.
- `docs/SECURITY.md` — key rotation, what's encrypted.
- `docs/TROUBLESHOOTING.md` — common errors keyed by message.
