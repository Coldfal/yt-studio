# Multi-Channel Operations

How to run 5–10 YouTube channels through one YT Studio install
without stepping on yourself. Covers the OAuth gotchas (especially
brand accounts), per-channel automation patterns, rate-limit tuning,
and the dashboard signals you should rely on.

---

## Mental model

Every YT Studio "channel" row is a self-contained world:

- Its own asset library (music, images, composed videos).
- Its own OAuth token (separate sign-in per YouTube channel).
- Its own automation presets (cron schedule, music source, metadata
  template, visualizer look).
- Its own visualizer preset library.
- Its own translation languages list.
- Its own brand-identity prompt + house-style metadata templates.

The only thing shared is global API keys (Claude, Suno, OpenAI) — any
channel can use them, and quota is tracked per (provider, channel)
so a Suno-heavy channel doesn't starve another.

There's no "team" concept. One operator, multiple personas.

---

## Adding a channel — step by step

### 1. Create the row

UI: **Channels** → **New Channel**. Fill in:

- **Name**: this is the friendly handle that shows up in the
  dashboard, logs, and project titles. Doesn't have to match the
  YouTube channel name.
- **Niche**: free-text, used in metadata prompts and the keyword-
  research seed (e.g. `lofi`, `meditation`, `study music`).
- **Brand identity**: 1–3 sentences fed to Claude when generating
  metadata. Be specific — "calm, dreamy, slightly melancholy lofi"
  beats "good music".
- **Default tags**: comma-separated. Used as a starting point for
  every project's metadata prompt.

The folder layout under `data/assets/{new_channel_id}/` is created
on first asset upload.

### 2. Connect YouTube

UI: **Channel detail page** → **Connect YouTube**. This kicks off the
OAuth flow.

#### The brand-account picker problem

If you use **brand accounts** (i.e. you have one Google login but
several YouTube channels under it), the OAuth picker will let you
choose which channel to authorise. Pick wrong and you've connected
the channel row to the wrong YouTube channel.

The fix:

1. **Always sign out of Google in your browser first**, or use a
   private / incognito window with a separate Chrome profile per
   channel.
2. When the picker comes up, look for the channel by its **display
   name + the channel-icon image**, not the email — every brand
   account on the same login has the same email.
3. Verify the connection by clicking **whoami** on the channel detail
   page after the OAuth redirect. The `channel.title` in the response
   should match the channel you intended to connect.

If you connected the wrong channel:

```
Settings → channel page → Disconnect YouTube → Reconnect
```

Disconnect just clears `youtube_credentials_json`. Re-connect
re-prompts the picker.

#### Keep your OAuth scope minimal

The app requests `youtube.upload` + `youtube.readonly`. That's
enough to:

- Upload videos (the whole point).
- Read which channel you connected to (so `whoami` works and we
  can show the channel name + thumbnail in the UI).
- Push translations after upload via `videos.update`.

It does NOT request:

- `youtube.force-ssl` — would let us delete videos. Don't need to.
- Analytics scopes — we don't read your analytics.

If Google sends you a security email saying "X has access to your
account", that's normal — it lists the YT Studio OAuth client
(named in your Cloud Console).

### 3. Set up an automation preset

UI: **Channel detail page** → **Automation** tab → **New Preset**.

Recommended starting config:

| Field                       | Value                                 |
|-----------------------------|---------------------------------------|
| `name`                      | Anything memorable (`Daily LoFi 1h`)  |
| `is_active`                 | OFF until you test once               |
| `target_duration_seconds`   | `3600` (1 hour) for music channels    |
| `audio_extensions`          | `["mp3", "flac"]`                     |
| `music_folder_path`         | Empty if you'll use library mode      |
| `image_folder_path`         | Empty if you'll use library mode      |
| `video_style`               | `spectrum` (always — see below)       |
| `youtube_privacy`           | `private` until you're sure           |
| `auto_upload`               | OFF for first run                     |
| `metadata_mode`             | `claude` (or `template` if you want   |
|                             | full control)                         |
| `auto_translate_languages`  | Empty list initially                  |

> **Why `video_style: "spectrum"` always?** The audio-reactive
> engine routes through that style. The "no spectrum bars" look is
> achieved by toggling `visualizer_disabled` inside the composition
> config, not by changing `video_style`. Other style strings exist
> for legacy reasons but aren't actively maintained.

### 4. Test once manually

Don't enable cron yet. From the dashboard:

1. Click **Generate Video Now** on the channel card.
2. Watch the task progress through compose → metadata → upload (if
   `auto_upload` enabled).
3. Verify the output:
   - `data/assets/{channel_id}/composed/` has a fresh MP4.
   - The project shows on YouTube Studio (private if you set that).
   - If translations were generated, they appear under YouTube
     Studio → Subtitles → Languages.

If anything is off, the task's `error` field on `/api/tasks/{id}`
points at the failure phase.

### 5. Enable cron

Once a manual run succeeds, edit the preset:

- `is_active = TRUE`
- `cron_schedule` — e.g. `0 14 * * *` for 2 PM daily.
- `auto_upload = TRUE` (ideally `private` until you've trusted it
  for a few runs, then flip to `public`).

The next scheduler tick (within 60 seconds) picks it up.

---

## Channel growth patterns

### One channel, daily cron

Simplest case. One preset, `0 14 * * *`. The retention worker keeps
old composed-video files trimmed to your disk cap (default 50 GB).

### One channel, multiple presets

Useful when you want different vibes on different days. Example:

- `Mon/Wed/Fri 2pm` — preset A (lofi, 1h, spectrum visualizer).
- `Tue/Thu 2pm` — preset B (ambient, 3h, visualizer disabled).

Each preset can pull from a different folder or a different subset
of the channel's library by using folder organization.

### Multiple channels, staggered crons

For 5–10 channels, **stagger** so they don't all compose at the same
minute. The task runner allows 2 compose concurrency, so the third
channel waits — just adds to total wall time, but it's a sign you
should spread the load.

Example for 5 channels:

```
Channel 1 — 14:00 daily
Channel 2 — 14:30 daily
Channel 3 — 15:00 daily
Channel 4 — 15:30 daily
Channel 5 — 16:00 daily
```

A 1-hour render finishes well before the next one starts, giving the
upload pool time to drain.

### Folder-mode vs library-mode

- **Library-mode** (default): channel uploads music to YT Studio's
  library; presets pick tracks at random from that pool. Best for
  curated channels with a fixed track list.
- **Folder-mode**: preset points at a Windows folder; the backend
  scans it on each run. Best for channels where you drop new music
  into a folder and want each video to use whatever's currently
  there.

Set per-preset via the Music step's Folder mode. The setting is also
persisted on the channel as the "last-used" mode so a brand-new
preset on the same channel defaults to the same shape.

---

## Rate limit tuning

The `rate_limiter` service tracks token-bucket usage per
(provider, channel). Defaults:

| Provider          | Capacity | Refill rate | Per     |
|-------------------|----------|-------------|---------|
| `suno`            | 5        | 1 / 60s     | channel |
| `openai_dalle`    | 10       | 1 / 30s     | channel |
| `claude_cli`      | 20       | 1 / 10s     | channel |
| `youtube_api`     | 50       | 1 / 5s      | channel |
| `youtube_upload`  | 2        | 1 / 60s     | channel |

The tight `youtube_upload` bucket (1 per minute, capacity 2) is on
purpose: a retry storm on a temporary YouTube outage would otherwise
burn the daily 10,000-unit quota in seconds. With this in place, even
a runaway loop hits the rate limiter before it hits the API.

If you hit the limiter, the task pauses (status `running`,
`status_message: "Rate-limited, waiting…"`) until the bucket refills.

To raise a limit, edit `app/services/rate_limiter.py` defaults — but
do this only if you've actually hit a wall. The defaults are safe
for 5–10 channels.

---

## Quota dashboard

`/api/stats/quota/{channel_id}` returns the current day's usage per
provider:

```json
{
  "youtube_upload": { "used": 4200, "limit": 10000, "remaining": 5800 },
  "youtube_api":    { "used": 87,   "limit": 10000, "remaining": 9913 },
  "suno":           { "used": 23,   "limit": 100,   "remaining": 77 },
  "claude_cli":     { "used": 47,   "limit": 1000,  "remaining": 953 }
}
```

The dashboard surfaces the **tightest** quota (lowest
`remaining/limit` ratio) on each channel card as an amber line when
it drops below 70%. At <30% the card flips to red.

If you see red on `youtube_upload`, you'll want to back off uploads
for that channel — set `auto_upload=false` on its preset and resume
the next day. YouTube's daily quota resets at midnight Pacific time.

---

## Translations

Translations are generated automatically when:

1. The preset has `auto_translate_languages = ["es", "fr", "ja", ...]`.
2. The channel has Claude available (CLI or API).

The flow:

1. Metadata generation produces the English title + description.
2. Claude is called once with the English text and the language list,
   returning a `{lang: {title, description}}` map.
3. The map is stored on `project.youtube_translations`.
4. On upload, the YouTube Data API receives `localizations: {...}`
   alongside the snippet. Because `videos.insert` silently ignores
   that field, a follow-up `videos.update` is fired immediately
   afterward to actually apply them. (See `services/youtube_service.py`.)

Translations cost about 1 Claude call per video, regardless of
language count — they're generated in a single batch.

**To add languages later**: edit the preset's `auto_translate_languages`
list. The next run picks up the change. To push translations to a
video that was uploaded *before* you added the language, click
**Push translations to YouTube** on the project's history page —
that hits the standalone `/api/projects/{id}/push-translations`
endpoint which only sends the `videos.update` call without re-uploading.

---

## Per-channel customisations worth setting

These all live on the channel detail page → Brand Profile tab:

- **`title_template`** — `{channel_name} — {short_date} {niche} mix`.
  Variables get filled at render time. If you set this, Claude is
  told to fill in CREATIVE blocks like `{COMPELLING TITLE for X}`
  that you embed; the rest is template substitution.
- **`description_template`** — same idea, longer. Often includes a
  social links block at the bottom that Claude doesn't touch.
- **`tags_template`** — comma-separated, used as a starting point;
  Claude expands to ~28 tags per video.
- **`default_video_width` / `default_video_height` / `default_video_style`** —
  applied to brand-new VisualizerPresets so every new look starts at
  your channel's preferred dimensions.

The dashboard "Generate Video Now" button uses these every time. The
NewProjectPage wizard pre-fills from them on Step 1 and lets you
override per-project.

---

## Common multi-channel mistakes

### One YouTube account, multiple channels — wrong picker

Mentioned above. Always sign out, then connect each channel from a
clean state. A confused OAuth means uploads go to the wrong channel
and YouTube doesn't tell you.

### Reusing the same image library across channels

The image library is per-channel by design. Don't symlink one
`data/assets/X/image/` to another — the random-image picker filters
by `channel_id` and a symlink would mean both channels' "used" lists
stomp on each other.

If you genuinely want a shared image pool, upload images to channel 1
and **reassign** them to channel 2 from the Library UI's right-click
menu. The channel filter follows the row, not the file.

### Forgetting `auto_upload` is OFF after a test

Common: you test a preset manually with `auto_upload=true`, find a
bug, set it to `false` to debug, fix the bug, forget to flip it
back, then enable cron. Result: cron runs render videos but never
uploads. Look at the project list for "composed but not uploaded"
rows as a sanity check after enabling a new cron.

### Not setting `youtube_privacy` to `private` on the first scheduled run

On the very first cron-driven upload, set the preset's privacy to
`private` so you can verify the metadata + thumbnail in YouTube
Studio before flipping to `public`. Once you've trusted three runs,
flip to `public` (or `unlisted` if you prefer manual go-live).

---

## See also

- `docs/ARCHITECTURE.md` — what the channel row + presets actually
  drive.
- `docs/SECURITY.md` — what's encrypted, OAuth revocation, key
  rotation across channels.
- `docs/OPERATIONS.md` — backups (especially before scaling up to
  10 channels — losing the DB hurts more with every channel).
- `docs/TROUBLESHOOTING.md` — quota errors, OAuth errors, stuck
  uploads.
