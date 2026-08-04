# Onboarding

For a new developer (or future-you in 6 months) walking up to a fresh
clone. Goal: from `git clone` to a video uploaded to a YouTube channel,
without spelunking source.

For the install steps themselves, see the **README.md** at the repo
root — that file is the source of truth for "what runs where". This
doc picks up after the backend is on `:8000` and the frontend on
`:5173`.

## 1. Add your API keys

Open the **Settings** page in the UI. Every key here is stored
encrypted in `data/studio.db` with the Fernet key in `data/studio.key`.

The minimum to be useful:

- **YouTube OAuth client ID + secret** — required for any upload.
  Create one at https://console.cloud.google.com → APIs & Services
  → Credentials → "OAuth client ID" → Application type **Web**.
  Authorized redirect URI: `http://127.0.0.1:8000/api/youtube/callback`.

- **YouTube Data API v3 key** (recommended) — for keyword research.
  Same Cloud project, "API Key" instead of OAuth.

- **Claude API key** *or* Claude CLI on PATH — at least one is needed
  for AI-generated metadata. CLI uses your subscription credits;
  the API key bills per-token.

Optional, only if you'll use those features:
- Suno cookie — for AI music generation.
- OpenAI key — for DALL·E image generation.

## 2. Create a Channel

**Channels → New Channel**.

- **Name** is for your own reference, not pushed to YouTube.
- **Default tags / description / keywords** become the house style for
  metadata generation. The Claude prompt picks these up so every video
  on the channel has consistent SEO and branding.

You can leave most fields blank and edit later.

## 3. Link the YouTube account

Inside the channel detail page, click **Connect YouTube**. A popup
sends you to Google's OAuth screen. After consent you're redirected
back; the channel page now shows "Currently uploading as: <YouTube
channel name>".

Important for **brand accounts** (multiple channels under one Google
login): the consent screen asks "Continue as…". Pick the brand channel
this YT Studio channel maps to. We force `prompt=select_account` so
you always see the picker, even on subsequent re-auths.

If you uploaded to the wrong channel by mistake, click **Disconnect**
and reconnect, choosing the right brand account this time.

## 4. Import or generate assets

Two ways to get audio + images into a channel:

- **Library → Upload** — drag-drop existing files. They're copied into
  `data/assets/<channel_id>/`.
- **YouTube Download** — paste a URL, the backend uses `pytubefix` to
  pull the audio (or video). Requires explicit user click; no
  background scraping.
- **AI generation** — Suno for music, DALL·E for images. Each task
  shows up in the task queue with progress.

Folders inside the library are organisational only — not surfaced to
YouTube or to the visualizer.

## 5. Save a visualizer preset (optional)

**Visualizer Editor** lets you tweak background colour, spectrum bars,
particles, logo overlay, subscribe-button overlay, etc. Click **Save
Preset** to make it reusable. Mark one as "default" and Quick Generate
picks it automatically.

## 6. Generate your first video

Two paths:

- **Quick Generate** (dashboard one-click). Uses the channel's primary
  automation preset to pick image + tracks, render with the default
  visualizer, generate metadata, and (if `auto_upload=true`) upload.

- **New Project** wizard — full control: image, tracks, visualizer
  config, metadata mode (template vs. Claude), schedule.

Either way you can watch progress on the dashboard or in the **Tasks**
panel.

## 7. Set up automation (optional)

Channel detail → **Automation** tab. Create an automation preset with
a cron expression (`0 18 * * *` = 6 PM daily) and `is_active=true`.
The scheduler polls every 60 seconds and fires a Quick Generate run
whenever `next_run_at` is reached.

Multiple presets per channel are fine — only one should be marked
`is_primary` (it's the one Quick Generate uses).

## Common first-run gotchas

- **"Invalid OAuth redirect URI"** — the URL in your Cloud OAuth
  client must exactly match `http://127.0.0.1:8000/api/youtube/callback`
  including the port. Trailing slashes matter.
- **"FFmpeg not found"** — set `YTS_FFMPEG_PATH` in `.env` to the
  absolute path. Default assumes `ffmpeg` is on PATH.
- **"Claude CLI timeout"** — generally a network issue or rate limit.
  Falls back to template metadata if the CLI isn't available — the
  flow won't crash.
- **Particles missing in final compose, but visible in preview** —
  this was a bug in `tryLoadImage` mis-detecting PNGs as SVGs (fixed
  in Phase 0). If it recurs, check `backend/visualizer_engine/src/exporter.ts`.

## What to read next

- `README.md` — install + run.
- `docs/ARCHITECTURE.md` — what the system looks like internally.
- `docs/KEYWORD_RESEARCH.md` — the keyword pipeline (existing doc).
