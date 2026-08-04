# Operations

Running YT Studio day-to-day on a single machine. Backups, log
rotation, deploy options, monitoring, and what to look at when
something breaks at 2am.

This is a single-operator app — no Docker, no Kubernetes, no
load-balancer. Everything below assumes one box.

---

## Where things live

| Path                                        | Purpose                                      |
|---------------------------------------------|----------------------------------------------|
| `data/studio.db`                            | All relational state. Back this up.          |
| `data/studio.key`                           | Fernet key. Lose it = lose all credentials.  |
| `data/assets/{channel_id}/{type}/`          | All media. Big — separate backup strategy.   |
| `backend.log`                               | Structured JSON logs (one event per line)    |
| `backend.err.log`                           | Stderr capture (uvicorn + ffmpeg subprocess) |
| `frontend.log` / `.err.log`                 | Vite dev server logs (only relevant in dev)  |
| `backend/.env`                              | Runtime settings (ports, paths)              |

The DB and the Fernet key are the two things that absolutely must be
backed up together — restoring just the DB without the matching key
gives you unreadable encrypted columns.

---

## Backups

### What to back up

1. **`data/studio.db`** — small (typically <100 MB). Daily.
2. **`data/studio.key`** — 44 bytes. Once, then on every rotation.
3. **`data/assets/`** — large. Decide between:
   - **Daily snapshot** if you rely on AI-generated music/images
     you can't easily reproduce.
   - **Weekly + `_unused_keep` whitelist** if your music comes from
     a separate Windows folder you back up independently.

### Simple Windows backup (Task Scheduler + 7-Zip)

Save as `C:\bin\yt-studio-backup.ps1`:

```powershell
$src = "D:\Projects\Youtube\data"
$dst = "D:\Backups\yt-studio"
$stamp = Get-Date -Format "yyyy-MM-dd"
New-Item -ItemType Directory -Force -Path $dst | Out-Null

# DB + key (small, copy verbatim)
Copy-Item "$src\studio.db"  "$dst\studio-$stamp.db"
Copy-Item "$src\studio.key" "$dst\studio-$stamp.key"

# Assets (compressed)
& "C:\Program Files\7-Zip\7z.exe" a -t7z -mx=3 `
  "$dst\assets-$stamp.7z" "$src\assets" | Out-Null

# Prune backups older than 30 days
Get-ChildItem $dst | Where-Object {
  $_.LastWriteTime -lt (Get-Date).AddDays(-30)
} | Remove-Item -Force
```

Schedule it via Task Scheduler at 4 AM (after the 3 AM retention
worker has run, so the snapshot is post-cleanup).

**Test the restore at least once.** A backup you've never restored
isn't a backup.

### Restoring

```powershell
# 1. Stop the backend.
# 2. Restore the matching pair:
Copy-Item "D:\Backups\yt-studio\studio-2026-04-30.db"  D:\Projects\Youtube\data\studio.db -Force
Copy-Item "D:\Backups\yt-studio\studio-2026-04-30.key" D:\Projects\Youtube\data\studio.key -Force
# 3. (Optional) Restore assets:
& "C:\Program Files\7-Zip\7z.exe" x -aoa `
  "D:\Backups\yt-studio\assets-2026-04-30.7z" -oD:\Projects\Youtube\data
# 4. Restart the backend.
```

After a restore, the **first thing** to verify: open the channel
detail page → click "whoami" or just trigger a quick render. If the
OAuth token is unreadable you'll see a "reconnect YouTube" prompt
on every channel.

---

## Running as a service

### Windows: NSSM

The simplest option. Install [NSSM](https://nssm.cc/) and:

```powershell
# Backend
nssm install YTStudio-Backend "D:\Projects\Youtube\backend\venv\Scripts\python.exe"
nssm set YTStudio-Backend AppParameters "-m uvicorn app.main:app --host 127.0.0.1 --port 8000"
nssm set YTStudio-Backend AppDirectory "D:\Projects\Youtube\backend"
nssm set YTStudio-Backend AppStdout "D:\Projects\Youtube\backend.log"
nssm set YTStudio-Backend AppStderr "D:\Projects\Youtube\backend.err.log"
nssm set YTStudio-Backend AppRotateFiles 1
nssm set YTStudio-Backend AppRotateBytes 10485760
nssm start YTStudio-Backend

# Frontend (dev) — only if you want auto-restart on a server box
nssm install YTStudio-Frontend "C:\Program Files\nodejs\node.exe"
nssm set YTStudio-Frontend AppParameters "node_modules\vite\bin\vite.js --host 0.0.0.0 --port 5173"
nssm set YTStudio-Frontend AppDirectory "D:\Projects\Youtube\frontend"
```

NSSM automatically restarts the process if it dies. The
`AppRotateFiles=1` + `AppRotateBytes` settings rotate the log when
it hits 10 MB.

### Linux: systemd

```ini
# /etc/systemd/system/yt-studio.service
[Unit]
Description=YT Studio backend
After=network.target

[Service]
Type=simple
User=opa
WorkingDirectory=/home/opa/yt-studio/backend
ExecStart=/home/opa/yt-studio/backend/venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000
Restart=on-failure
RestartSec=5
StandardOutput=append:/home/opa/yt-studio/backend.log
StandardError=append:/home/opa/yt-studio/backend.err.log

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now yt-studio
journalctl -u yt-studio -f    # live tail
```

For the frontend on a server, you'd typically `npm run build` once
and serve `frontend/dist/` via nginx — but for a single-operator
local-host setup, the `npm run dev` server is fine.

---

## Log rotation

### structlog → backend.log

The backend's logging config (`app/logging_config.py`) writes to
`backend.log` directly without a `RotatingFileHandler` — by design,
since most operators don't run the backend long enough to need it
and external rotation (NSSM, logrotate) is more reliable.

### Manual rotation (Windows, no NSSM)

Save as `C:\bin\yt-studio-rotate-logs.ps1`, schedule weekly:

```powershell
$root = "D:\Projects\Youtube"
$stamp = Get-Date -Format "yyyy-MM-dd"

# Stop the backend service to release the file lock
nssm stop YTStudio-Backend
Start-Sleep -Seconds 2

# Rotate
foreach ($name in @("backend.log", "backend.err.log")) {
  $path = "$root\$name"
  if (Test-Path $path) {
    Move-Item $path "$root\old-logs\$name.$stamp"
  }
}

# Start again — the backend recreates the file
nssm start YTStudio-Backend
```

Compress old-logs older than 30 days; delete older than 90.

### logrotate (Linux)

```
# /etc/logrotate.d/yt-studio
/home/opa/yt-studio/backend.log /home/opa/yt-studio/backend.err.log {
  weekly
  rotate 8
  compress
  missingok
  notifempty
  copytruncate
}
```

`copytruncate` is important here — the backend keeps the file handle
open. Without it, post-rotation logs would write to a deleted inode.

---

## Monitoring

### What to watch

- **`backend.log` errors today** — `Get-Content backend.log | Select-String '"level":"error"'`.
  A handful per day is normal (transient YouTube quota, Suno hiccups).
  More than a dozen, or anything with `error_type=CryptoKeyError`, is
  worth investigating.
- **Disk usage** — the dashboard's per-channel storage card surfaces
  this, or hit `/api/stats/storage` directly. Default cap is 50 GB
  per channel; the retention worker warns (doesn't delete).
- **Failed tasks** — the Failed Tasks panel on the dashboard shows
  every task that ended `failed` in the last 7 days, with a one-click
  retry. Empty = healthy.
- **Stuck tasks** — `/api/tasks/?status=running` and check `started_at`.
  Anything `running` for >1 hour is probably wedged; cancel it via
  the UI.

### Health-check ping (for external monitors)

```
GET /api/stats/channels
```

Always returns 200 with a JSON body. Hook a monitoring service
(UptimeRobot, healthchecks.io) at this URL with a 5-minute interval.

If the backend is wedged but uvicorn is alive, you'll get a 200 with
an empty / stale body — pair the HTTP check with a "did task_runner
heartbeat in the last 5 min" check by tailing `backend.log` for
`task_runner_tick` events (logged every minute).

### Quota tracking

Per-provider quotas are tracked at `/api/stats/quota/{channel_id}`:

```json
{
  "suno": { "used": 23, "limit": 100, "remaining": 77 },
  "openai_dalle": { "used": 8, "limit": 100, "remaining": 92 },
  "youtube_upload": { "used": 4200, "limit": 10000, "remaining": 5800 },
  "claude_cli": { "used": 47, "limit": 1000, "remaining": 953 }
}
```

The dashboard shows the tightest one (lowest `remaining/limit`) per
channel as an amber line when it drops below 70%.

---

## Updating

```powershell
# 1. Always back up first
.\C:\bin\yt-studio-backup.ps1

# 2. Stop the service
nssm stop YTStudio-Backend

# 3. Pull
cd D:\Projects\Youtube
git pull

# 4. Update Python deps if requirements.txt changed
cd backend
.\venv\Scripts\Activate.ps1
pip install -r requirements.txt

# 5. Update frontend deps if package.json changed
cd ..\frontend
npm install

# 6. Rebuild visualizer engine if its package.json changed
cd ..\backend\visualizer_engine
npm install
npm run build

# 7. Apply DB migrations (idempotent — safe to re-run)
# init_db() runs automatically on backend startup. No separate step.

# 8. Restart
nssm start YTStudio-Backend
```

DB migrations live in `backend/app/database.py::init_db()`. Each
migration checks `PRAGMA table_info` first and skips if the column /
table already exists — re-running on a fresh DB or an up-to-date one
is a no-op. The same code path handles backfills (e.g. populating
`VideoProjectTrack` rows from the legacy JSON column).

---

## Disaster recovery scenarios

### "I lost `studio.key`"

You'll lose access to:
- Every channel's YouTube OAuth (have to re-auth all of them).
- Every API key in `AppSetting` (have to re-paste them in the
  Settings UI).

You will NOT lose:
- Project metadata (title, description, tags) — plaintext.
- Asset files — plaintext on disk.
- The video render outputs.

**Procedure**:

```powershell
# 1. Stop the backend.
# 2. Delete the unreadable encrypted columns so the app boots cleanly:
sqlite3 data\studio.db <<EOF
UPDATE channels SET youtube_credentials_json = NULL;
DELETE FROM app_settings WHERE key LIKE 'api_key:%';
EOF
# 3. Generate a fresh key by deleting and restarting:
del data\studio.key
# 4. Restart the backend — it generates a new key on first run.
# 5. Re-paste API keys in Settings.
# 6. Re-connect YouTube on each channel page.
```

### "I lost `studio.db` but kept the key"

You can restore from the most recent backup; the key is unchanged
so encrypted credentials decrypt fine.

If there's no backup: you've lost projects, automation history,
folder organisation, and visualizer presets. Asset files are still
on disk, but the rows pointing at them are gone — running
`/api/assets/reconcile` won't help (it deletes orphan ROWS, not
files). You'd have to manually re-upload, or write a small script
that walks `data/assets/` and INSERTs `Asset` rows.

This is why daily DB backups are non-negotiable.

### "The backend crashed mid-render and won't start"

Check the lifespan startup logs:

- `CryptoKeyError` → `studio.key` is missing or corrupt; see above.
- `OperationalError: database is locked` → a previous instance
  didn't shut down cleanly. Wait 30 seconds for SQLite's WAL to
  release; if it persists, `del data\studio.db-shm data\studio.db-wal`
  (those are recreated on next start).
- `OperationalError: no such column` → DB schema is older than the
  code expects. The `init_db()` migration should handle this on
  first startup; if it fails, the migration error will be in
  `backend.err.log`.

---

## Performance tuning

The defaults work for 5–10 channels with up to 50 videos/week.
Knobs to tune for heavier workloads:

| Setting                                 | File                                | Default | Notes                                      |
|-----------------------------------------|-------------------------------------|---------|--------------------------------------------|
| Compose concurrency                     | `workers/task_runner.py`            | 2       | CPU/disk-bound. Don't exceed core count.   |
| Upload concurrency                      | `workers/task_runner.py`            | 2       | Network-bound. Higher hits YouTube quota.  |
| Metadata concurrency                    | `workers/task_runner.py`            | 3       | Cheap; fine to bump to 5.                  |
| Per-channel disk cap                    | `workers/retention_worker.py`       | 50 GB   | Warning only — won't auto-delete.          |
| Task retention                          | `workers/retention_worker.py`       | 90 days | Older completed/failed rows pruned daily.  |
| Cron tick interval                      | `workers/automation_scheduler.py`   | 60 s    | Fine grain not useful here.                |
| `output_fps` (per-preset)               | UI                                  | 30      | Drop to 24 or 15 for long mixes.           |
| `crf` (per-preset)                      | UI                                  | 23      | Higher = smaller file, lower quality.      |

If renders bottleneck on the FFmpeg encode (visible by `ffmpeg`
spinning at 100% CPU), bump `crf` to 26 and try `preset: ultrafast`
in the visualizer config — saves disk + render time, barely
visible at YouTube's compression level.

---

## See also

- `docs/SECURITY.md` — encryption + OAuth revocation procedure.
- `docs/TROUBLESHOOTING.md` — error messages keyed to fixes.
- `docs/MULTI_CHANNEL.md` — adding channels, OAuth tips.
- `README.md` — install.
