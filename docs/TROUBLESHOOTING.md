# Troubleshooting

Errors keyed by the message you see (in the UI, the logs, or stderr),
each with the cause + fix. Search by the literal error text first;
fall back to the section index below.

If your error isn't here, check `backend.log` for the full
structured record — it carries `phase`, `task_id`, `channel_id`, and
the `error_type`, which usually points at the right section.

---

## Index

- [Backend startup](#backend-startup)
- [Frontend won't load](#frontend-wont-load)
- [Upload to YouTube fails](#upload-to-youtube-fails)
- [Compose / FFmpeg fails](#compose--ffmpeg-fails)
- [Visualizer engine errors](#visualizer-engine-errors)
- [Claude metadata errors](#claude-metadata-errors)
- [Suno / OpenAI / external API errors](#suno--openai--external-api-errors)
- [Database / SQLite errors](#database--sqlite-errors)
- [OAuth / permission errors](#oauth--permission-errors)
- [Live streaming errors](#live-streaming-errors)
- [Translations not applied](#translations-not-applied)
- [Performance / stuck tasks](#performance--stuck-tasks)

---

## Backend startup

### `CryptoKeyError: data/studio.key is missing`

**Cause**: the Fernet key is gone. App can read project metadata
fine but can't decrypt `youtube_credentials_json` or
`AppSetting.value` for encrypted keys.

**Fix**:

- If you have a backup: restore `data/studio.key` from it.
- If not: delete the unreadable encrypted columns + let the app
  generate a new key, then re-paste API keys + reconnect YouTube on
  every channel. See `docs/OPERATIONS.md` → "I lost studio.key".

### `OperationalError: database is locked`

**Cause**: a previous backend instance didn't shut down cleanly, or
DB Browser for SQLite is open and holding a lock.

**Fix**:

```powershell
# Close any GUI tool that has data/studio.db open.
# Then wait 30s for SQLite's WAL to release.
# If still locked, manually clear the WAL files:
del data\studio.db-shm data\studio.db-wal
```

The WAL/SHM files are recreated on next startup.

### `OperationalError: no such column / no such table`

**Cause**: code is newer than the DB schema. The startup
`init_db()` migration should have handled this — if it didn't,
something failed mid-migration.

**Fix**:

1. Stop the backend.
2. Check `backend.err.log` for the migration error.
3. Most likely a migration partially applied. Restore from the
   nightly backup (see `docs/OPERATIONS.md`).
4. If you really have to repair manually: each migration in
   `app/database.py::init_db()` is an idempotent `ALTER TABLE`.
   Run the missing one in `sqlite3 data/studio.db` directly.

### `Address already in use: ('127.0.0.1', 8000)`

**Cause**: a previous uvicorn from the same session is still
listening.

**Fix**:

```powershell
# Find the PID
netstat -ano | findstr :8000
# Kill it (replace 12345 with the actual PID)
Stop-Process -Id 12345 -Force
```

If you can't find it cleanly, just bind on a different port:

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8001 --reload
```

…and update the frontend's API base URL.

---

## Frontend won't load

### Blank page, no errors in console

Two flavours:

**Vite is on a different port than you think.** Check the terminal
where you ran `npm run dev` — Vite logs `Local: http://localhost:5174/`
when 5173 is busy. Open that URL.

**Stale dev-server bookkeeping.** If you're hitting a port that has
nothing listening (because Vite moved), kill any zombie node
processes:

```powershell
Get-Process node | Stop-Process -Force
cd frontend
npm run dev
```

### `No routes matched location "/library"`

**Cause**: you typed `/library` but the route is `/assets`. The page
is *titled* "Library" but the URL hasn't changed.

**Fix**: navigate to `/assets`.

### `useTaskSSE` reconnect loop

**Cause**: backend is down or the SSE endpoint
(`/api/tasks/stream`) is being intercepted by a corporate proxy
that strips `text/event-stream`.

**Fix**:

- Verify backend is up (`curl http://127.0.0.1:8000/api/stats/channels`).
- If you're behind a proxy, bypass it for `127.0.0.1`.
- Last resort: the dashboard refreshes via React Query polling
  every 60s even without SSE, so you can keep working — task
  progress just won't be live.

---

## Upload to YouTube fails

### `invalid_grant: Token has been expired or revoked`

**Cause**: YouTube revoked the OAuth refresh token. Common when:
- The refresh token sat unused for >6 months.
- The user revoked access from their Google security page.
- The Google Cloud project was paused or deleted.

**Fix**: the app auto-clears the broken token and shows a "Reconnect
YouTube" prompt on the channel detail page. Click it, complete the
OAuth flow. The previously failed upload can be retried from the
dashboard's Failed Tasks panel.

### `quotaExceeded` / `dailyLimitExceeded`

**Cause**: the channel's YouTube Data API v3 daily quota (default
10,000 units) is exhausted. Each upload is ~1,600 units, so
typically you hit this around the 6th upload of the day.

**Fix**:
- Wait until midnight Pacific time for the quota to reset.
- For long-term capacity: request a quota increase in Google Cloud
  Console (Quotas page → search YouTube Data API → Edit). Anthropic
  has approved increases for legitimate use.
- Stagger uploads across the day rather than firing 5 at once.

### `videoNotFound` / `forbidden` on `videos.update`

**Cause**: the follow-up `videos.update` call (used to apply
localizations) couldn't find the freshly inserted video. Usually a
processing-state race — YouTube hasn't finished the video setup yet.

**Fix**: it's logged as a warning, not an error, so the upload itself
succeeds. Translations can be pushed later via the project history
page → "Push translations to YouTube".

### `invalidVideoMetadata`

**Cause**: usually a snippet field outside the writable subset
(thumbnails, channelId, etc.) was sent in the update body. Should be
prevented by `_WRITABLE_SNIPPET_FIELDS` whitelist.

**Fix**: open `backend.log` and grep for `videos.update body=` —
verify the payload only contains `title`, `description`, `tags`,
`categoryId`, `defaultLanguage`. If a non-writable field crept in
(after a code change, perhaps), revert that change.

### Title rejected / sanitised silently

**Cause**: YouTube's title cap is 100 UTF-16 code units (so emoji
counted as 2 each). Our sanitiser truncates and adds an ellipsis.

**Fix**: shorten your title template, or check the warning in
`backend.log` (`Truncated title from N to M UTF-16 code units`).
The truncated title is what gets uploaded.

---

## Compose / FFmpeg fails

### `[error] FFmpeg subprocess returned with code 1`

**Cause**: see `backend.err.log` — ffmpeg's stderr is captured
verbatim there.

Common causes:
- `Conversion failed!` with `Error opening input file` → an asset
  file is missing on disk. Run `/api/assets/reconcile` to clean
  up orphan rows.
- `Unable to find a suitable output format` → mismatched output
  extension and codec settings.
- `Conversion failed: Killed` → the OS killed ffmpeg, usually OOM
  on a long render. Drop `output_fps` or shorten the source.

### Compose hangs at ~97% for 60–90 seconds

**Cause**: ken_burns finalization (final frame settle + audio mux).
Not a hang — wait it out. See
`memory/ffmpeg_finalization_phase.md`.

### `napi-canvas` errors on Windows

**Cause**: missing Visual C++ Redistributable for the version
`@napi-rs/canvas` needs.

**Fix**:

```powershell
# Install Microsoft VC++ 2015–2022 Redistributable (x64).
# Then rebuild:
cd backend\visualizer_engine
rmdir /s /q node_modules
npm install
npm run build
```

---

## Visualizer engine errors

### `Cannot find module '@napi-rs/canvas-win32-x64-msvc'`

**Cause**: native binary for your platform wasn't installed during
`npm install` (often happens after switching machines or Node
versions).

**Fix**:

```powershell
cd backend\visualizer_engine
npm install --force
npm run build
```

### Spectrum bars look wrong (frequency clumping at low end)

Not really an error — this is the engine working as designed. The
bar density is tuned for ~128 bars at 48 kHz audio. If you see weird
clumping, check `n_bars` in the visualizer config.

See `memory/spectrum_visualizer_perf.md` for tuning notes.

### Render is slower than real-time

At 1080p / 30 fps / 128 bars, expect ~1.8× real-time on a modern
laptop. Slower means CPU-bound — drop FPS or n_bars.

---

## Claude metadata errors

### `claude command not found`

**Cause**: the Claude Code CLI isn't on `PATH` (or
`YTS_CLAUDE_CLI_PATH` points at a missing binary).

**Fix**:
- Install: https://docs.claude.com/en/docs/claude-code
- Verify: `claude --version` in a fresh terminal.
- Set `YTS_CLAUDE_CLI_PATH` in `.env` if you have the binary
  somewhere unusual.

### Metadata generation timed out (5 min)

**Cause**: Claude is slow today, or the prompt is huge (long
tracklist + lots of brand context).

**Fix**:
- Check Claude's status (`https://status.anthropic.com/`).
- Try again — usually transient.
- If recurring, shorten `brand_identity` / `description_template`.

### Generated metadata is generic / not channel-flavored

**Cause**: `brand_identity` field on the channel is empty or vague.
Claude follows it heavily — "calm music" produces calm-music
metadata; "instrumental Asian-fusion lofi at 70 BPM with traditional
shamisen" produces specific, on-brand metadata.

**Fix**: write a paragraph for `brand_identity`, not a sentence.

---

## Suno / OpenAI / external API errors

### Suno: `cookie invalid`

**Cause**: your Suno session cookie expired or was rotated.

**Fix**: copy a fresh cookie from your browser's dev tools
(Application → Cookies → suno.com → `__Secure-next-auth.session-token`)
and paste it into Settings → API Keys → Suno.

### OpenAI: `invalid_api_key`

**Cause**: API key in Settings is wrong, or the key was revoked.

**Fix**: regenerate at https://platform.openai.com/api-keys, paste
into Settings.

### `Rate-limited, waiting…`

Not an error — the rate limiter is doing its job. The task pauses
until the bucket refills (usually 30–60 seconds). See
`docs/MULTI_CHANNEL.md` → Rate Limit Tuning.

---

## Database / SQLite errors

### `IntegrityError: FOREIGN KEY constraint failed`

**Cause**: code tried to insert a row referencing a missing parent
(e.g. a `VideoProjectTrack` referencing a deleted `Asset`).

**Fix**: this shouldn't happen — `ondelete=CASCADE` is set on every
relationship. If it does, the structured log carries the offending
SQL — paste into `sqlite3 data/studio.db` to inspect.

### `IntegrityError: UNIQUE constraint failed: video_project_tracks.project_id, video_project_tracks.position`

**Cause**: two tracks at the same position in the same project.
The unique constraint is `(project_id, position)`.

**Fix**: This should never trigger from app code (`set_project_tracks`
deletes existing rows before inserting new ones). If it does, run:

```sql
DELETE FROM video_project_tracks WHERE project_id = ?;
```

Then re-save the project from the UI to re-write the rows.

---

## OAuth / permission errors

### `OAuth state expired` (after auth callback)

**Cause**: you started the OAuth flow, walked away for >15 minutes,
then completed it. The state row is gone (we sweep stale OAuth
state every startup + on each new auth-url request).

**Fix**: click **Connect YouTube** again, complete it within 15
minutes.

### Wrong YouTube channel got connected

**Cause**: brand-account picker confusion — see
`docs/MULTI_CHANNEL.md` → "The brand-account picker problem".

**Fix**: Disconnect, re-connect carefully (sign out of Google first,
or use a dedicated Chrome profile).

### `403 Forbidden` on `videos.insert`

**Cause**: account doesn't have upload permission. Common when:
- The channel is unverified (have to verify by phone before
  uploading non-15-minute videos).
- Channel is in violation of YouTube ToS.

**Fix**: log into youtube.com directly with that account, complete
verification, retry.

---

## Live streaming errors

### Stream stuck at `starting`

**Cause**: ffmpeg is still ramping up the encode buffer. Give it
30 seconds. After that, check `LiveStream.error` field via
`/api/streaming/{stream_id}`.

### `RTMP server returned error`

**Cause**: stream key is wrong, or YouTube hasn't enabled live
streaming for the account (requires verification).

**Fix**:
- Verify the stream key on YouTube Studio → Go Live → Stream
  settings.
- If account is unverified, do that first (https://www.youtube.com/verify).

### Stream keeps restarting every few minutes

**Cause**: ffmpeg encoder dying — usually OOM or a transient
network blip.

**Fix**: drop `output_fps` to 24 or 15. Check Task Manager during
the stream — if RAM is climbing, you have a leak somewhere.

---

## Translations not applied

### Translations stored on project but not on YouTube

**Cause**: was a real bug pre-Phase 1 (`videos.insert` ignores
the `localizations` field). Fixed in `commit 028e254` — now the
upload path fires a follow-up `videos.update` call.

**Fix if still seeing it post-fix**:
- Verify backend version: `cd backend && git log --oneline -1`.
- The fix is in `services/youtube_service.py::upload_video`,
  search for `Apply localizations via a follow-up videos.update call`.
- If the comment is missing, you're on old code.

### "Push translations" button works but auto-upload doesn't

Should not happen post-fix. If it does, check `backend.log` for
`Failed to apply localizations to video {id}` — the warning
captures whatever YouTube returned. Most likely a transient
`videoNotFound` (race) — try the manual push as a fallback.

---

## Performance / stuck tasks

### Task stuck at `running`, no progress for >5 min

**Diagnose**:

1. `/api/tasks/{id}` — what's the `status_message`? When did
   `started_at` fire?
2. OS process list — is there an actual `ffmpeg` / `node` /
   `claude` subprocess still running?

If yes, it's working — just slow.
If no, the parent task hung waiting for a subprocess that died
silently (rare; ffmpeg signal handling on Windows).

**Fix**:

```
POST /api/tasks/{id}/cancel
```

Then retry from the Failed Tasks panel.

### `Maximum update depth exceeded` in console (frontend)

**Cause**: a React effect causing infinite re-renders. Almost
always introduced by a recent code change to `ComposeStep` or
`VisualizerEditor`.

**Fix**: revert the offending change. The wizard's stable callback
pattern (refs holding latest state) is finicky — avoid inline
closures in the props passed to `VisualizerEditor`.

### Backend memory keeps climbing

**Cause**: typically a long-running asyncio task accumulating
references (e.g. a never-cancelled SSE subscription).

**Diagnose**:

```python
# In a Python REPL with the backend reachable:
import psutil, requests
p = psutil.Process(<backend pid>)
print(f"RSS: {p.memory_info().rss / 1024**2:.1f} MB")
# Compare over an hour — should plateau, not grow linearly.
```

**Fix**: restart the backend daily via NSSM/systemd if you can't
find the leak. Open an issue with the memory profile.

---

## See also

- `docs/OPERATIONS.md` — backups, log rotation, restoring after
  catastrophic failures.
- `docs/SECURITY.md` — credential rotation procedures.
- `docs/ARCHITECTURE.md` — what each subsystem does.
- `backend.log` — every error has more context here than what
  surfaces in the UI.
