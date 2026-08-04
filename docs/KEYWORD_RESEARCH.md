# Keyword research → smarter metadata

## What changed

Before: Claude generated titles, descriptions, and tags from a niche string
("lofi", "tech") plus track names. No external grounding — output was
plausible but invented.

Now: every metadata generation pulls real-time research first, then feeds
it to Claude as concrete signal:

- **YouTube autocomplete** — what users are typing into the YouTube search
  bar right now for the channel's niche. Free, no API key, runs on every
  call (cached 12 h per channel).
- **YouTube Data API trending** — top trending videos in the channel's
  category. Returns titles + tags so we can see what tags top performers
  are using and which titles are getting clicks. Requires an API key.

Claude is then given strict SEO rules baked into the system prompt: title
under 100 chars with primary keyword in first 60, description front-loaded
with keywords in first 150 chars, 10–15 tags mixing broad + mid-tail +
long-tail, total tag string ≤450 chars.

## Setup

### Without an API key (works out of the box)
Autocomplete data only. Already useful — gives Claude 60+ real long-tail
queries to anchor on. No setup needed.

### With an API key (recommended)
1. [Google Cloud Console](https://console.cloud.google.com) → APIs & Services → Credentials
2. Create credentials → API key (NOT OAuth — that's already set up for
   uploads). Restrict it to "YouTube Data API v3" for safety.
3. Paste it in **Settings → YouTube → Data API Key (server)**.

This uses the SAME Google Cloud project as your OAuth credentials, so it
shares the **10,000 units/day** quota. Our calls are cheap:
- `videos.list?chart=mostPopular` = 1 unit per call
- `search.list` = 100 units per call (we don't use this in the default
  flow — only on explicit "search competitor videos" actions)

At 1 unit per channel research + 12 h cache, you can run 800+ channel
researches per day on the free quota, more than enough for 10+ channels.

## Where to see it

- **Compose → Publish step**: shows a "Live keyword research" panel with
  autocomplete suggestions and trending tags Claude is being fed. Click
  Refresh to re-pull (force cache invalidation).
- **API**: `GET /api/metadata/research/{channel_id}` → JSON of the same
  data. Add `?refresh=true` to force a re-fetch.

## What Claude actually sees

When you click "Generate with AI" on the Publish step, Claude receives
(roughly):

```
Channel: YomiBeats
Niche: lofi
Brand identity: Tokyo nightscape lofi
Tracklist: ...
## Real-time research signals
Top YouTube autocomplete queries for this niche right now:
- lofi hip hop
- lofi beats
- lofi study music
...
Most-used tags across the current top trending videos:
lofi, chill beats, study music, ...
Example titles of the top trending videos:
- 1 A.M Study Session 📚 - [lofi hip hop/chill beats]
...
```

Plus the channel's title/description templates and explicit SEO rules.

## Caching

Per-channel/niche JSON files under `data/cache/keyword_research/`. TTL is
12 hours. Files are safe to delete — they regenerate on demand. The
front-end Refresh button bypasses cache.

## Multi-account hardening

The OAuth state map (used during channel YouTube linking) used to be
in-memory only — a backend restart between "Connect YouTube" and the
Google callback would lose the pending mapping and you'd hit "Invalid or
expired OAuth state". Now the state is persisted in `app_settings` keyed
`youtube_oauth_state__<state>` so restarts no longer break the flow.
This matters when running 5+ channels: each parallel link attempt now
survives a backend reload.

## Future improvements (not yet implemented)

- Glimpse / SerpApi Google Trends — when an API key is present, add
  breakout-term and seasonality data to the prompt.
- Reddit API for niche slang (free tier, 100 QPM, non-commercial only).
- Per-channel quota tracking — show "X / 10,000 units used today" in
  Settings to avoid surprise quota errors.
- Competitor video DB — opt-in `search.list` (100 units) to populate
  per-channel competitor list, refreshed weekly.
