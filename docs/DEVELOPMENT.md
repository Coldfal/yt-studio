# Development

How to clone the repo, run both servers, and have a productive
edit-compile-test loop. Read after `README.md` (which covers initial
install) and `ARCHITECTURE.md` (which explains what the pieces are).

---

## Prerequisites

| Tool        | Version | Why                                          |
|-------------|---------|----------------------------------------------|
| Python      | 3.11+   | FastAPI + asyncio. 3.13 works.              |
| Node.js     | 20+     | Visualizer engine + frontend                 |
| FFmpeg      | 6+      | Compose, extend, live stream                 |
| Claude CLI  | latest  | Optional — AI metadata against subscription  |

Everything else (`uvicorn`, `vite`, `ffmpeg-python`, etc.) installs
into the local venv / `node_modules`.

---

## First run

Already in `README.md`. Quick recap:

```powershell
# Backend
cd backend
python -m venv venv
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt
pip install -r requirements-dev.txt    # pytest + mocks (optional)

# Frontend
cd ..\frontend
npm install

# Visualizer engine (Node sidecar)
cd ..\backend\visualizer_engine
npm install
npm run build

# Env
cd ..\..
copy .env.example .env
```

The first time you start the backend, `data/studio.db` and
`data/studio.key` are created automatically. Don't commit either —
both are in `.gitignore`.

---

## Day-to-day workflow

You need **two** terminals open:

### Terminal 1 — backend

```powershell
cd backend
.\venv\Scripts\Activate.ps1
uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
```

The `--reload` flag triggers a process restart on every Python file
change. **Caveat**: Server-Sent Events (SSE) connections can hang the
reload because uvicorn waits for in-flight responses to finish. If
that happens, kill the process (`Ctrl+C`, then `Ctrl+C` again if
needed) and restart on a different port:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

Then update `frontend/.env` (or just hardcode in `frontend/src/lib/api.ts`)
to point at 8001. Easier: avoid keeping the dashboard open while you
hot-reload — close any tab that has the SSE-driven progress bars
running before saving a Python change.

When in doubt, hard-restart:

```powershell
# Find Python processes
Get-Process python | Where-Object { $_.MainWindowTitle -match 'uvicorn' }
# or just kill all
Stop-Process -Name python -Force
```

### Terminal 2 — frontend

```powershell
cd frontend
npm run dev
```

Vite listens on http://localhost:5173 by default. If 5173 is busy
(stale process from a previous session), Vite will auto-pick 5174
and log it. The dev server proxies `/api/*` to the backend (configured
in `frontend/vite.config.ts`).

### Visualizer engine — when do I rebuild?

You only need `npm run build` inside `backend/visualizer_engine/`
when:

- You changed code in `backend/visualizer_engine/src/`.
- You pulled new commits that touched that folder.

The frontend imports the same TypeScript source via tsconfig path,
so frontend changes there are hot-reloaded by Vite — no manual
rebuild. The Node sidecar (used by `compose_service`) reads from
`backend/visualizer_engine/dist/`, which is what `npm run build`
produces.

---

## Configuration

Two layers of config, in order of precedence:

1. **repository-root `.env`** — runtime parameters (ports, paths, debug
   flag). Read by `pydantic-settings` with `YTS_` prefix. See
   `.env.example` for the full list.
2. **`AppSetting` rows in the DB** — API keys, Claude API key, Suno
   cookie, OpenAI key, etc. Edit these from the **Settings** page in
   the UI; they're stored encrypted with `data/studio.key`.

API keys are deliberately NOT in `.env` so they live with the
encrypted DB — committing `.env` to a private repo doesn't leak
them, and the operator doesn't need to remember to roll keys when
they change machines.

---

## Tests

```powershell
cd backend
.\venv\Scripts\Activate.ps1
pytest -v
```

The backend suite covers services, workers, API endpoints, and the m2m
track migration. See `docs/TESTING.md` for the conventions
(in-memory SQLite fixture, mocked external integrations, async
session pattern).

Frontend has no automated tests yet — manual smoke testing in the
preview server is the workflow.

---

## Type-checking

```powershell
cd frontend
npx tsc -b
```

The build performs a TypeScript check before creating the Vite bundle.

`npm run build` runs `tsc -b` before creating the production bundle.
It is a release gate and should pass before a pull request is opened.

---

## Debugging tips

### Backend logs

`backend.log` (JSON, one event per line) is structured. Quick filters:

```powershell
# all errors today
Get-Content backend.log | Select-String '"level":"error"'

# everything for channel 2
Get-Content backend.log | Select-String '"channel_id":2'

# upload-related events
Get-Content backend.log | Select-String '"phase":"upload"'
```

### SQLite inspection

```powershell
# Quick check from a Python REPL
python -c "import sqlite3; c = sqlite3.connect('data/studio.db'); print(c.execute('SELECT id, name, niche FROM channels').fetchall())"
```

For a real GUI: DB Browser for SQLite (https://sqlitebrowser.org/)
opens `data/studio.db` directly. Don't have it open while the backend
is running — SQLite's BEGIN IMMEDIATE locks will collide.

### "Why is my task stuck?"

Three places to look:

1. **`/api/tasks/{id}`** — does the row say `status=running` with a
   stale `started_at`? Could be a hung ffmpeg or Node sidecar.
2. **OS process list** — `Get-Process ffmpeg`, `Get-Process node`.
   Kill any zombie processes; the task will fail at its timeout.
3. **`backend.log`** — search for `task_id=N`. The handler logs at
   each phase (`metadata_gen_start`, `compose_start`, `upload_done`).

If the task is stuck at >0% but no progress for 5+ minutes, it's
probably a network hang on a third-party API. Cancel it via
`POST /api/tasks/{id}/cancel`.

### Frontend stuck on "Loading…"

Open DevTools → Network. Either:

- An API request is 4xx/5xx → check `backend.log`.
- An API request is pending forever → backend is down or didn't
  pick up the file change. Restart uvicorn.
- React Query has a stale cache → hard-refresh (`Ctrl+Shift+R`).

### Hot-reload didn't pick up my Python change

Common causes (in order of likelihood):

1. `--reload` flag missing from `uvicorn`.
2. SSE connection blocking the reload (see above).
3. You edited a file `uvicorn` doesn't watch (e.g. inside `venv/`).
4. Your editor wrote to a temp file that didn't trigger the watcher.
   Try saving twice, or restart the server.

---

## Repository conventions

- **Imports**: backend uses absolute imports (`from app.services...`).
  Frontend uses path aliases (`@/components/...` mapped to `src/`
  in `tsconfig.json` + `vite.config.ts`).
- **Async**: all database access is async via `async_session`. Don't
  introduce sync sessions.
- **Errors**: services raise from `app.exceptions` (`NotFoundError`,
  `ValidationError`, `CredentialError`, `ServiceError`). The FastAPI
  exception handler in `app/main.py` turns those into JSON responses.
- **Tests**: live under `backend/tests/`; one file per service or
  feature area. The `db` fixture in `conftest.py` gives you a fresh
  in-memory SQLite per test. External APIs are always mocked.
- **Commits**: subject line ≤72 chars, imperative ("fix:", "feat:",
  "refactor:"). Body explains *why*, not what.

---

## Adding a new feature — checklist

1. Model: add columns / table to `models/`. Update `database.py`
   `init_db()` with an idempotent migration if you're adding to an
   existing table.
2. Schema: define request/response shapes in `schemas/`.
3. Service: business logic goes in `services/`, no FastAPI deps.
4. API: thin handler in `api/` that parses → calls service → returns.
   Mount the router in `api/router.py` if it's new.
5. Hook: add a TanStack Query hook in `frontend/src/hooks/`.
6. UI: page or component using the hook.
7. Test: at least one happy-path test in `backend/tests/`.
8. Update `docs/API.md` if you added a new endpoint.

---

## See also

- `README.md` — install instructions.
- `docs/ARCHITECTURE.md` — what runs where.
- `docs/TESTING.md` — pytest conventions.
- `docs/TROUBLESHOOTING.md` — when things break in dev.
