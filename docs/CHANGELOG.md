# Changelog

Versioned record of what shipped, organised by the 5-phase revamp
plan. Newest entries first.

The repo doesn't tag versions — this file is the source of truth for
"what does X do that the previous build didn't."

---

## Phase 4 — Documentation (in progress)

**Goal**: an operator can clone, install, link a YouTube channel,
generate a video, and find at least one troubleshooting answer
without reading source code.

### Shipped

- `docs/ARCHITECTURE.md` — full system overview (replaces the
  Phase 0 skeleton). Three-runtime breakdown, backend module map,
  data model, task lifecycle, Quick Generate end-to-end trace,
  cron + live streaming, encryption, logging.
- `docs/DEVELOPMENT.md` — local dev workflow, two-terminal
  pattern, hot-reload caveats (SSE blocking uvicorn restart),
  config layers, debugging cookbook.
- `docs/OPERATIONS.md` — backups (Windows + Linux), running as a
  service (NSSM, systemd), log rotation, monitoring, disaster
  recovery scenarios (`I lost studio.key`, etc.), performance
  tuning knobs.
- `docs/MULTI_CHANNEL.md` — adding a channel, the brand-account
  picker problem, automation patterns, rate-limit tuning, quota
  dashboard, translations.
- `docs/TROUBLESHOOTING.md` — errors keyed to the message you'd
  see (CryptoKeyError, invalid_grant, quotaExceeded,
  invalidVideoMetadata, OperationalError variants, FFmpeg subprocess
  failures, etc.).
- `docs/API.md` — every router prefix + endpoint with examples,
  SSE event reference, error code catalog.
- `docs/SECURITY.md` — what's encrypted, key rotation procedure,
  OAuth revocation, threat scenarios.
- `docs/TESTING.md` — pytest conventions, fixtures, mocking
  patterns, what the 108-test suite catches.
- `docs/CHANGELOG.md` — this file.

### Pending

- Automated encrypted-credential key rotation.
- E2E sweep: walk a fresh DB through Quick Generate + verify
  every task type executes under the new worker pool.
- 7-day soak test (3 channels on cron, 2 manual generates/day) —
  zero unhandled exceptions target.

---

## Phase 3 — Multi-channel scaling (shipped)

**Goal**: 5–10 channels run reliably in parallel; quotas are tracked
per provider/channel; old data is pruned automatically.

### Concurrency

- **Per-task-type worker pools** (`commit abf5558`) — replaces the
  serial `asyncio.Queue` with `asyncio.Semaphore` per task type,
  type-aware admission control over a single queue.
  - `compose`: 2 concurrent
  - `metadata_generation`: 3 concurrent
  - `youtube_upload`: 2 concurrent
  - `automation_run`: 4 concurrent (orchestrator)
  - `music_generation`, `image_generation`, `youtube_audio_download`,
    `youtube_chapters_download`: 1 each (rate-limited APIs)
- **Per-task timeouts**: compose 60min, upload 30min, metadata 5min,
  default 30min.
- **Retry policy**: max 2 for upload, 1 for metadata, 0 for compose;
  exponential backoff with jitter on `RETRYABLE_EXCEPTIONS`.

### Rate limiter

- **Token-bucket per (provider, channel_id)** (`commit d85ced9`).
  Providers: `suno`, `openai_dalle`, `claude_cli`, `youtube_api`,
  `youtube_upload`. Tasks pause + resume when buckets refill.
- **Quota endpoint**: `GET /api/quota/{channel_id}` shows daily
  units used + remaining per provider.
- **Quota dashboard line** (`commit ff422bb`) — channel cards on
  the dashboard show the tightest quota as an amber line at <70%,
  red at <30%.

### Retention + storage

- **Retention worker** (daily 3 AM): delete `BackgroundTask` rows
  >90 days old (completed/failed only, never running/pending);
  remove orphan composed-video files.
- **Per-channel disk cap warning** (default 50 GB) — never auto-
  deletes user content, only warns in dashboard.
- **Storage tab on channel detail page** — disk usage breakdown by
  asset type.

### SSE robustness

- **Frontend exp-backoff reconnect**: 1s → 2s → 4s → 8s, capped at
  30s.
- **Backend heartbeat**: 15s ping on `/api/tasks/stream` so idle
  proxies don't drop the connection.

### Scheduler hardening

- Detect missed cron runs on startup (any `next_run_at < now()`):
  fire one catch-up run, then schedule the next.
- Health-check ping every 5 min; loud log + restart if the loop dies.

---

## Phase 2 — Code restructure (partially shipped)

**Goal**: navigable codebase. Split mega-files, eliminate visualizer
duplication, standardise UX primitives.

### Backend split (shipped)

- `automation_service.py` (1,104 lines) → 3 files (`commit` early
  Phase 2):
  - `automation_service/execute_run.py` (cron preset flow)
  - `automation_service/quick_generate.py` (dashboard one-click)
  - `automation_service/_shared.py` (image/track selection, metadata)
- Replaced lazy in-method imports with module-level imports.

### Frontend split (shipped)

- **NewProjectPage.tsx**: 3,854 lines → 12 files under
  `pages/new-project/` (`commit 6056f25`):
  - Shell: `NewProjectPage.tsx` (~250 lines)
  - Steps: `SetupStep`, `MusicStep`, `ComposeStep`, `MetadataStep`,
    `ReviewUploadStep`
  - Components: `StepIndicator`, `ImportFolderRow`,
    `VisualizerPresetBar`, `ExtendVideoCard`, `KeywordResearchPanel`
  - Pure helpers: `utils.ts`
  - Dropped dead code: `VisualsStep` (~350 lines, never rendered),
    `getStepFromStatus`, two unused MusicStep handlers
- **AssetsPage.tsx**: 1,249 → 715 lines (`commit 0abb2be`).
  Extracted `library/categories.tsx`, `library/components/Sidebar`,
  `ContextMenu`, `AssetCard`, `AssetsToolbar`, `BulkActionBar`,
  `LoadingSkeleton`. Dialogs were already extracted in an earlier
  Phase 2 commit.
- Deleted `UploadsPage.tsx` (332 lines, fully superseded — now a
  tab in AssetsPage).

### UX standardisation (shipped)

- `Spinner` component — single canonical loader; replaced inline
  Loader2 + skeleton variants across DashboardPage, NewProjectPage,
  AssetsPage.
- `EmptyState` — adopted everywhere a list can be empty.
- **react-hook-form + zod** (`commit 45d47b0`) on:
  - `BrandProfileTab` — 10 useState → useForm, Save disabled when
    pristine, proper reset on channel change.
  - `PromptFormDialog` — fixes stale-state bug when switching
    between edit targets, inline validation errors.
- `use-debounced-state` hook — replaces ad-hoc setTimeout patterns.

### Deferred to dedicated session

- **streaming_service.py split** (~899 lines) — heavy shared
  asyncio + ffmpeg state, no test coverage yet. Wait until tests
  catch up.
- **Visualizer engine unification** — backend + frontend each have
  a copy of `frame-renderer.ts` (733 vs 739 lines, drifting).
  Single workspace package needs tsconfig path setup; separate
  session.

---

## Phase 1 — Reliability + observability + tests (shipped)

**Goal**: silent-failure bugs surface immediately. Tests prevent
Phase-2 refactors from regressing behavior.

### Reliability

- Per-task timeouts (compose 60m, upload 30m, default 30m).
- Retry policy with exponential backoff on transient failures.
- `app/exceptions.py` — `AppError` hierarchy (`NotFoundError`,
  `ValidationError`, `ServiceError`, `CredentialError`,
  `TimeoutExceededError`); FastAPI handler maps to consistent JSON
  responses.
- `app/services/credentials_service.py` — single source of truth
  for decrypting OAuth tokens + API keys. Returns `None` on decrypt
  failure with a structured warning, instead of raising mid-handler.

### Observability

- Switched backend logging to `structlog` with JSON output to
  `backend.log` + human-readable stdout.
- Every record carries `task_id`, `channel_id`, `phase`,
  `error_type`.
- New `GET /api/stats/channels` — per-channel counts (drafts,
  composed, uploaded, failed today, last successful upload, last
  failure).
- Frontend Failed-Tasks panel on dashboard (collapsible, last 7
  days, grouped by channel, one-click retry).

### Test coverage

- 49 → 75 → 92 → 103 → 108 passing tests through the phase.
- `pytest.ini` + `requirements-dev.txt` (pytest, pytest-asyncio,
  pytest-mock).
- Coverage:
  - `task_runner` handlers (compose, upload, metadata, music,
    image, automation_run) — happy path + error paths.
  - `automation_service` — quick_generate, image selection, track
    selection.
  - `compose_service` — `_build_filename`, `extend_video` snap-to-
    song math.
  - `credentials_service` — encrypt/decrypt round-trip + failure.
  - `exceptions` — every AppError subclass.

---

## Phase 0 — Stabilization + doc skeleton (shipped)

**Goal**: silent-failure bugs plugged, docs scaffolded for later
phases.

### Bug fixes

- Verified `tryLoadImage` PNG-as-SVG fix held (particles + bg image
  both render in fresh compose).
- Verified decrypted-creds flow (auto-upload no longer silently
  fails).
- `updated_at` columns added to 6 models that lacked them: `Asset`,
  `AssetFolder`, `AutomationRun`, `BackgroundTask`, `LiveStream`,
  `Task`. Idempotent migration in `init_db()`.
- FK cascade audit: `AutomationRun.preset_id`,
  `AutomationRun.task_id` now CASCADE; channel-related FKs use a
  consistent policy (CASCADE for owned children, SET NULL for
  optional refs).
- Auto-expire `youtube_oauth_state__*` `AppSetting` rows older than
  15 minutes (startup + per-auth-url-request sweep).
- Monthly `VACUUM` from `automation_scheduler.py`.
- Startup check in `crypto.py` — surfaces missing `data/studio.key`
  cleanly.

### Doc skeleton

- `README.md` — clone-to-running checklist.
- `.env.example` — every supported `YTS_*` variable, no secrets.
- `docs/ARCHITECTURE.md` (skeleton, replaced in Phase 4).
- `docs/ONBOARDING.md` — adding a YouTube channel.
- `docs/KEYWORD_RESEARCH.md` — keyword research + tag pipeline.

---

## Pre-Phase 0 (initial baseline, `commit 36f4180`)

The state of the app before the revamp started:

- 49 passing pytest tests (initially); structured logging not yet
  in place.
- Single-worker `asyncio.Queue` task runner (no per-type pools).
- No rate limiting; no quota tracking; no retention worker.
- `automation_service.py` (1,104 lines), `NewProjectPage.tsx`
  (3,854 lines), `streaming_service.py` (899 lines),
  `AssetsPage.tsx` (2,088 lines) — all monolithic.
- Two `frame-renderer.ts` copies between backend + frontend
  visualizer code, manually kept in sync.
- No README / docs / `.env.example`.
- Silent failures on encrypted-creds path; PNG-as-SVG bug in
  `tryLoadImage`.

---

## Notable bug fixes (post-Phase 1, threaded through later commits)

- **`commit 028e254` — YouTube translations finally apply** on
  auto-upload. Root cause: `videos.insert` silently ignores the
  `localizations` field; needed a follow-up `videos.update` call.
  First attempt (`commit 0fa1a30`) called `videos.list` first to
  fetch the snippet, but list returns empty `items` for
  freshly-uploaded videos while YouTube is still processing —
  silently skipping the update. Fix builds the update snippet from
  the variables already in scope.
- **`commit 48006be` — `music_asset_ids` JSON → CASCADE m2m
  table**. New `VideoProjectTrack` model with CASCADE on both
  sides (project + asset). Backfill on startup is idempotent.
  `set_project_tracks()` / `get_project_track_ids()` helpers
  preserve backward compat (read m2m first, fall back to JSON, then
  to single FK). 11 new tests, 103 → 103 passing total.
- **`commit 45d47b0` — react-hook-form on `PromptFormDialog`**
  fixes a long-standing stale-state bug where opening the dialog
  for prompt B after editing prompt A showed prompt A's values.

---

## See also

- `docs/ARCHITECTURE.md` — current state of the system.
- `docs/OPERATIONS.md` — running it.
