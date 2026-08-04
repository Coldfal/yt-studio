# API Reference

Every endpoint exposed by the FastAPI backend, grouped by router
prefix. All routes live under `/api/*`. Default base URL is
`http://127.0.0.1:8000`.

There's no auth — the API is bound to `127.0.0.1` and assumed to be
behind your user account. Don't expose this to a network you don't
own.

For the canonical OpenAPI spec, hit `/docs` or `/openapi.json` while
the backend is running — every schema and example is auto-generated
from the FastAPI route signatures.

---

## Conventions

- **Errors**: every error response has shape
  `{"detail": "human-readable message", "code": "machine_readable"}`.
  Status codes follow the HTTP semantics: 400 validation, 404 not
  found, 401/403 auth, 502 upstream service down, 500 unexpected.
- **IDs**: all `id` fields are positive integers. URL paths use
  literal IDs (`/projects/42`), no slugs.
- **Timestamps**: ISO 8601 strings in UTC (`2026-05-05T14:30:00Z`).
- **Pagination**: most list endpoints return everything
  (single-operator app, datasets stay small). Where pagination
  exists, it's `?limit=N&offset=M`.
- **Tasks**: long-running operations return `TaskResponse` (id +
  status). Watch progress via SSE on `/api/tasks/stream`.

---

## Endpoint index by router

| Prefix                       | Router file                          |
|------------------------------|--------------------------------------|
| `/api/settings`              | `app/api/settings.py`                |
| `/api/channels`              | `app/api/channels.py`                |
| `/api/assets`                | `app/api/assets.py`                  |
| `/api/projects`              | `app/api/projects.py`                |
| `/api/tasks`                 | `app/api/tasks.py`                   |
| `/api/music`                 | `app/api/music.py`                   |
| `/api/compose`               | `app/api/compose.py`                 |
| `/api/metadata`              | `app/api/metadata.py`                |
| `/api/youtube`               | `app/api/youtube.py`                 |
| `/api/prompts`               | `app/api/prompts.py`                 |
| `/api/automation`            | `app/api/automation.py`              |
| `/api/streaming`             | `app/api/streaming.py`               |
| `/api/images`                | `app/api/images.py`                  |
| `/api/visualizer-presets`    | `app/api/visualizer_presets.py`      |
| `/api/stats`                 | `app/api/stats.py`                   |

---

## `/api/channels`

| Method | Path                              | Notes                                       |
|--------|-----------------------------------|---------------------------------------------|
| GET    | `/`                               | List all channels                           |
| POST   | `/`                               | Create a channel                            |
| GET    | `/{channel_id}`                   | Single channel                              |
| PUT    | `/{channel_id}`                   | Update name / brand / templates             |
| DELETE | `/{channel_id}`                   | Cascades: deletes assets, projects, presets |
| GET    | `/{channel_id}/stats`             | Counts (drafts, composed, uploaded, etc.)   |
| GET    | `/{channel_id}/last-config`       | Last-used composition config + image_ids    |

### `POST /api/channels/`

```json
{
  "name": "ZenTaoSounds",
  "niche": "ambient meditation",
  "brand_identity": "calm, dreamy, slightly melancholy lofi at 70 BPM",
  "default_tags": "lofi, study, chill"
}
```

→ `201 ChannelResponse`. The channel directory at
`data/assets/{new_id}/` is NOT created until the first asset upload.

---

## `/api/assets`

| Method | Path                                    | Notes                                       |
|--------|-----------------------------------------|---------------------------------------------|
| GET    | `/`                                     | Filter via `?channel_id=&asset_type=&folder_id=` |
| POST   | `/upload`                               | multipart/form-data; `file` + `channel_id`  |
| POST   | `/import-folder`                        | Server-side scan (no upload)                |
| POST   | `/reconcile`                            | Purge rows for files missing on disk        |
| POST   | `/backfill-durations`                   | Probe missing duration_seconds via ffprobe  |
| GET    | `/folders`                              | List all asset folders                      |
| POST   | `/folders`                              | Create folder                               |
| PUT    | `/folders/{id}`                         | Rename                                      |
| DELETE | `/folders/{id}`                         | Removes folder; assets stay (folder_id→null)|
| PUT    | `/move`                                 | `{asset_ids, folder_id}` — bulk move        |
| PUT    | `/reassign-channel`                     | `{asset_ids, channel_id}` — reassign        |
| POST   | `/merge-audio`                          | Concatenate selected music tracks           |
| GET    | `/youtube-cookies-status`               | yt-dlp cookies present?                     |
| POST   | `/youtube-cookies-upload`               | Upload `cookies.txt`                        |
| DELETE | `/youtube-cookies`                      | Remove cookies                              |
| POST   | `/youtube-info`                         | yt-dlp metadata probe (title, duration)     |
| POST   | `/youtube-download`                     | Start MP3 download task                     |
| POST   | `/youtube-download-chapters`            | MP3 download split by chapter               |
| GET    | `/{id}`                                 | One asset                                   |
| PUT    | `/{id}`                                 | Update title / description                  |
| GET    | `/{id}/stream`                          | Stream the file (Range support for video)   |
| DELETE | `/{id}`                                 | Removes file + row                          |

### `POST /api/assets/upload`

`multipart/form-data`:
- `file`: the binary
- `channel_id`: int
- `asset_type`: `music` | `image` | `video` | `composed` | `thumbnail`
- `replace_existing`: `"true"` | `"false"` (filename-based dedup)
- `folder_id`: optional int

→ `201 AssetResponse`. With `replace_existing=true`, an existing row
with the same `(channel_id, filename)` is updated in place rather
than creating a duplicate — preserves any project references.

### `POST /api/assets/import-folder`

```json
{
  "channel_id": 2,
  "asset_type": "music",
  "folder_path": "D:/Music/ZenTao",
  "recursive": true,
  "skip_existing": true
}
```

→ `{ "imported": 23, "skipped_existing": 100, "failed": 0, "scanned": 123, "asset_ids": [...] }`

Server-side copy. No HTTP upload of file bytes — way faster for
folders with thousands of tracks. Files already imported (matched by
filename within the channel) are skipped.

---

## `/api/projects`

| Method | Path                                      | Notes                                         |
|--------|-------------------------------------------|-----------------------------------------------|
| GET    | `/`                                       | Filter via `?channel_id=`                     |
| POST   | `/`                                       | Create draft                                  |
| GET    | `/{id}`                                   | One project                                   |
| PUT    | `/{id}`                                   | Update any field                              |
| DELETE | `/{id}`                                   | Cascade: tracks, composed asset, runs         |
| POST   | `/{id}/generate-translations`             | Claude → fill `youtube_translations` JSON     |
| POST   | `/{id}/push-translations-to-youtube`      | Apply existing translations to live video     |

### `POST /api/projects/{id}/generate-translations`

```json
{
  "languages": ["es", "fr", "ja", "de"],
  "merge": true
}
```

→ `200 ProjectResponse`. Synchronous (~5–15 seconds depending on
description length). With `merge=true`, existing translations for
languages NOT in the request are kept; new ones overwrite.

### `POST /api/projects/{id}/push-translations-to-youtube`

→ `200 ProjectResponse`. No body required. Fires a single
`videos.update(part="snippet,localizations")` call against the
channel's OAuth credentials. Useful for backfilling translations on
videos uploaded before translation was enabled.

400 if the project hasn't been uploaded yet (`youtube_video_id` is
null) or has no stored translations.

---

## `/api/tasks`

| Method | Path                          | Notes                                        |
|--------|-------------------------------|----------------------------------------------|
| GET    | `/stream`                     | **SSE** stream of all task events            |
| GET    | `/`                           | Filter `?status=&project_id=&channel_id=`    |
| GET    | `/{id}`                       | One task                                     |
| POST   | `/{id}/cancel`                | Cancel pending or running                    |
| POST   | `/{id}/retry`                 | Re-enqueue a failed task with same params    |

### `GET /api/tasks/stream`

Server-Sent Events stream. Each event has shape:

```
event: task_update
data: {"task_id": 42, "status": "running", "progress": 67.5, "status_message": "Composing..."}
```

Events:
- `task_update` — progress / status change
- `task_complete` — terminal (status → completed/failed/cancelled)
- `heartbeat` — every 15s, no payload, keeps idle proxies happy

Frontend uses `useTaskSSE` hook with exp-backoff reconnect.

### `POST /api/tasks/{id}/retry`

```
POST /api/tasks/42/retry
```

→ Creates a NEW BackgroundTask with the same `result` params, links
the original via `parent_task_id`. Original stays as a historical
record. Useful for the Failed Tasks panel's "Retry" button.

---

## `/api/automation`

| Method | Path                                                | Notes                                       |
|--------|-----------------------------------------------------|---------------------------------------------|
| GET    | `/presets`                                          | All presets across channels                 |
| GET    | `/channels/{id}/presets`                            | Presets for one channel                     |
| POST   | `/presets`                                          | Create preset                               |
| GET    | `/presets/{id}`                                     | One preset                                  |
| PUT    | `/presets/{id}`                                     | Update                                      |
| DELETE | `/presets/{id}`                                     | Delete                                      |
| POST   | `/presets/{id}/trigger`                             | Run NOW (ignores schedule)                  |
| POST   | `/channels/{id}/ensure-quick-generate-preset`       | Get-or-create primary preset                |
| GET    | `/channels/{id}/quick-generate-preview`             | Preview which image would be used           |
| POST   | `/channels/{id}/quick-generate-preview/reroll`      | Force a fresh random pick                   |
| POST   | `/channels/{id}/quick-generate`                     | One-click: enqueue automation_run           |
| GET    | `/presets/{id}/runs`                                | History of past runs (`?limit=20`)          |
| GET    | `/runs/{id}`                                        | One run record                              |
| POST   | `/scan-folder`                                      | Walk a folder, return audio file metadata   |

### `POST /api/automation/channels/{channel_id}/quick-generate`

→ `{"task_id": 1234, "preset_id": 7}`. Enqueues an
`automation_run` task using the channel's primary preset (or any
active preset, falling back to defaults). This is what "Generate
Video Now" on the dashboard calls.

---

## `/api/compose`

| Method | Path           | Notes                                                       |
|--------|----------------|-------------------------------------------------------------|
| GET    | `/styles`      | List of available `video_style` strings                     |
| POST   | `/start`       | Start a compose task for a project                          |
| POST   | `/extend`      | Loop-extend an already-composed video to a target duration  |

### `POST /api/compose/start`

```json
{
  "project_id": 42,
  "style": "spectrum",
  "config": {
    "presetId": "linear-dots",
    "output_width": 1920,
    "output_height": 1080,
    "output_fps": 30,
    "crf": 23,
    "visualizer_disabled": false,
    "loop_to_target": false
  }
}
```

→ `201 TaskResponse`. The visualizer engine spawns once (Node
sidecar), composes the natural-length MP4. If `loop_to_target=true`
and `target_duration > natural_duration`, the task automatically
chains an extend step at the end.

---

## `/api/youtube`

| Method | Path             | Notes                                                       |
|--------|------------------|-------------------------------------------------------------|
| GET    | `/auth-url`      | OAuth start URL — pass `?channel_id=N`                      |
| GET    | `/callback`      | OAuth callback (browser-only, redirected by Google)         |
| POST   | `/disconnect`    | Clear stored credentials for a channel                      |
| GET    | `/whoami`        | Verify connected YouTube account                            |
| POST   | `/upload`        | Enqueue upload task for a project                           |

### `POST /api/youtube/upload`

```json
{ "project_id": 42 }
```

→ `201 TaskResponse`. Reads `project.composed_asset_id`,
`youtube_title/description/tags/privacy/scheduled_at/translations`,
then enqueues a `youtube_upload` task. Privacy/schedule come from
the project (set by the wizard's Publish step or the preset).

---

## `/api/metadata`

| Method | Path                          | Notes                                       |
|--------|-------------------------------|---------------------------------------------|
| POST   | `/generate`                   | Async metadata via task queue               |
| POST   | `/fill-template`              | **Sync** Claude call (~3s)                  |
| GET    | `/research/{channel_id}`      | Keyword research panel data                 |

### `POST /api/metadata/fill-template`

```json
{
  "project_id": 42,
  "title_template": "ZenTaoSounds — {COMPELLING TITLE for an ambient mix}",
  "description_template": "{ENGAGING DESCRIPTION}\n\nTracklist: ...",
  "tag_count": 28
}
```

→ `{ "title": "...", "description": "...", "tags": [...] }`. Synchronous,
~3 seconds. Used by the wizard's "Generate with AI" button. Templates
support `{placeholder}` substitution + `{CREATIVE BLOCK}` insertion
points that Claude fills in.

### `GET /api/metadata/research/{channel_id}`

```
GET /api/metadata/research/2?refresh=false
```

→ Cached payload of YouTube autocomplete + trending tags for the
channel's niche. `?refresh=true` forces a fresh fetch (rate-limited).

---

## `/api/music`

| Method | Path             | Notes                                          |
|--------|------------------|------------------------------------------------|
| POST   | `/generate`      | Suno music generation task                     |
| POST   | `/import`        | Manual import of an external file              |
| GET    | `/scan-folder`   | Walk a folder, return audio metadata           |
| GET    | `/stream-file`   | Stream a file by absolute path (folder mode)   |

### `GET /api/music/scan-folder`

```
GET /api/music/scan-folder?folder_path=D:/Music/ZenTao
```

→ `{ "tracks": [{ "path": "...", "filename": "...", "duration": 180.5, "size": 4500000 }, ...] }`.
Cached per `folder_path` for 5 minutes.

---

## `/api/streaming`

| Method | Path                  | Notes                                          |
|--------|-----------------------|------------------------------------------------|
| POST   | `/start`              | Start a 24/7 RTMP stream                       |
| POST   | `/{id}/stop`          | Stop a stream                                  |
| GET    | `/active`             | Currently-running streams                      |
| GET    | `/history`            | Past streams (failed + completed)              |
| GET    | `/{id}`               | One stream                                     |

### `POST /api/streaming/start`

```json
{
  "channel_id": 2,
  "source_kind": "visualizer",
  "rtmp_url": "rtmp://a.rtmp.youtube.com/live2/your-stream-key",
  "music_folder_path": "D:/Music/ZenTao/24-7",
  "image_asset_id": 17,
  "composition_config": { ... }
}
```

`source_kind` is `"visualizer"` (audio-reactive) or `"folder"`
(simple shuffle, much lower CPU). For folder mode, omit
`composition_config`; for visualizer mode it's required.

---

## `/api/images`

| Method | Path                | Notes                                   |
|--------|---------------------|-----------------------------------------|
| POST   | `/generate`         | DALL·E task (async)                     |
| POST   | `/generate-sync`    | DALL·E synchronous (~10s)               |

### `POST /api/images/generate-sync`

```json
{
  "channel_id": 2,
  "prompt": "serene Japanese garden at dusk, watercolor",
  "size": "1792x1024"
}
```

→ Array of `AssetResponse`. Synchronous; doesn't go through the task
queue. Used in the wizard's Visuals step's "AI Generate" button.

---

## `/api/visualizer-presets`

| Method | Path                          | Notes                                  |
|--------|-------------------------------|----------------------------------------|
| GET    | `?channel_id=N`               | Presets for channel                    |
| POST   | (root)                        | Create preset                          |
| GET    | `/{id}`                       | One preset                             |
| PUT    | `/{id}`                       | Update                                 |
| DELETE | `/{id}`                       | Delete                                 |
| POST   | `/{id}/thumbnail`             | Upload thumbnail (data URL)            |

---

## `/api/prompts`

Saved Claude prompts, channel-scoped.

| Method | Path                | Notes                                 |
|--------|---------------------|---------------------------------------|
| GET    | `?channel_id=N`     | List channel's prompts                |
| POST   | (root)              | Create                                |
| GET    | `/{id}`             | One                                   |
| PUT    | `/{id}`             | Update                                |
| DELETE | `/{id}`             | Delete                                |
| POST   | `/{id}/use`         | Bump `last_used_at`                   |
| POST   | `/{id}/favorite`    | Toggle `is_favorite`                  |

---

## `/api/settings`

Encrypted key-value store. Used for API keys.

| Method | Path                          | Notes                                  |
|--------|-------------------------------|----------------------------------------|
| GET    | `/`                           | List settings (values decrypted)       |
| PUT    | `/`                           | Bulk update                            |
| GET    | `/claude-cli-status`          | Verify `claude` is on PATH             |
| POST   | `/test/{provider}`            | Probe a third-party API for liveness   |

### `PUT /api/settings/`

```json
[
  { "key": "claude_api_key", "value": "sk-ant-...", "encrypted": true },
  { "key": "youtube_api_key", "value": "AIza...", "encrypted": false }
]
```

`encrypted=true` runs the value through Fernet before storing. Reads
auto-decrypt.

---

## `/api/stats`

| Method | Path                                | Notes                                  |
|--------|-------------------------------------|----------------------------------------|
| GET    | `/channels`                         | Per-channel counts (today, all-time)   |
| GET    | `/storage`                          | Per-channel disk usage breakdown       |
| GET    | `/quota/{channel_id}`               | Provider quota usage today             |
| POST   | `/retention/preview`                | Dry-run retention sweep                |
| POST   | `/retention/run`                    | Force-run retention now                |
| GET    | `/failed-tasks`                     | Failed tasks (last 7 days, all chans)  |

### `GET /api/stats/channels`

→
```json
[
  {
    "channel_id": 2,
    "channel_name": "ZenTaoSounds",
    "tasks_today_pending": 0,
    "tasks_today_running": 1,
    "tasks_today_completed": 4,
    "tasks_today_failed": 0,
    "last_successful_upload": "2026-05-04T18:23:00Z",
    "last_failure_at": null,
    "last_failure_message": null
  },
  …
]
```

This is also what the dashboard channel cards render from.

---

## SSE event reference

`GET /api/tasks/stream` — long-lived connection, multiplexes all task
events. Reconnect with exp-backoff on disconnect (frontend handles
this in `use-sse.ts`).

| Event           | When                                       | Payload                                                  |
|-----------------|--------------------------------------------|----------------------------------------------------------|
| `task_update`   | Progress fraction or status_message change | `{task_id, status, progress, status_message}`            |
| `task_complete` | Terminal status                            | `{task_id, status: "completed"\|"failed"\|"cancelled", result}` |
| `heartbeat`     | Every 15s                                  | empty                                                    |

The heartbeat is purely there to keep idle proxies and corporate
firewalls from killing the connection.

---

## Error code catalog

Every `AppError` subclass defines a stable `code`. Use it for
client-side branching rather than message-matching.

| Code                | HTTP | Notes                                         |
|---------------------|------|-----------------------------------------------|
| `not_found`         | 404  | A specific row / file / external resource     |
| `validation_error`  | 400  | User-supplied input failed validation         |
| `service_error`     | 500  | Unexpected service-layer failure              |
| `credential_error`  | 401  | OAuth token / API key broken or missing       |
| `timeout_exceeded`  | 504  | Task ran past its per-type timeout            |
| `app_error`         | 500  | Catch-all (shouldn't appear; subclass instead)|

---

## See also

- `docs/ARCHITECTURE.md` — what's behind each endpoint.
- `docs/MULTI_CHANNEL.md` — workflows that drive these endpoints.
- `/docs` (auto-generated OpenAPI UI when backend is running) —
  always-current schemas + try-it-out forms.
