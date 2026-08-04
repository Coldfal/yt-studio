# AI metadata voice — audit + redesign

> **Status**: design proposal. Waiting for approval before code.

You asked: "where do all the AI instructions live, why does it feel
like there are duplicates, and where do I tweak them per channel?"
The audit found **8 distinct places** AI-related instructions can
sit. Some are dead. The one that does the most work is hardcoded
for YomiBeats, which is why your other channels get YomiBeats-style
output regardless of niche.

This doc maps the current state and proposes a single-source-of-
truth replacement.

---

## Where AI instructions live today

| #   | Location                                              | Type   | Used by                                                | Status         |
|-----|-------------------------------------------------------|--------|--------------------------------------------------------|----------------|
| 1   | `claude_cli_service.py::style_block()`                | system | **Both** dashboard auto-gen AND wizard "Generate with AI" | **dominant + hardcoded for YomiBeats** |
| 2   | `Channel.brand_identity`                              | user   | Both paths                                             | active, weak signal |
| 3   | `Channel.target_audience`                             | user   | Both paths                                             | active, weak signal |
| 4   | `Channel.niche`                                       | system | Both paths (SEO niche string)                          | active         |
| 5   | `Channel.title_template` / `description_template`     | user   | Wizard's "Generate with AI" button only                | partial — dead in dashboard auto-gen |
| 6   | `AutomationPreset.title_template` / `description_template` / `tags_template` | template format | `execute_run` only (cron, folder mode) | **dead** for dashboard "Quick Generate" |
| 7   | `AutomationPreset.claude_prompt`                      | user   | Dashboard auto-gen ("extra instructions")              | active         |
| 8   | `Prompt` table (`/api/prompts`)                       | n/a    | UI catalog only — never read by the metadata flow      | **dead** — just a clipboard |

The **dominant force** is `style_block()` — a function that returns
~50 lines of Markdown describing the YomiBeats Japanese-chill-rap
brand voice with a concrete title example (`『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』
Rainy Tokyo Night ⋆｡°✩ | Japanese Chill Rap・Pop R&B Mix`). Both
the dashboard's "Generate Video Now" path and the wizard's manual
"Generate with AI" button paste this verbatim into the system
prompt for every channel.

The system prompt also literally instructs Claude:

> open the title with 『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』☯, etc.

So when ZenTaoSounds (your meditation/zen channel) generates a
title, the AI is being told to open with the same Japanese-rap
typographic decoration as YomiBeats. The per-channel
`brand_identity` field is dribbled in as ONE line of user-prompt
context — drowned out by the system-level instructions.

That's the bug. Per-channel "voice" is bolted on as a footnote
instead of being the primary driver.

---

## The two flows, side by side

### Dashboard "Generate Video Now" / cron auto-generate

```
quick_generate.run_quick_generate
  → claude_cli_service.generate_metadata
       system_prompt = (
         "You are a senior YouTube SEO copywriter for the '{niche}' niche. ...
          {style_block()}"     ← hardcoded YomiBeats example
       )
       user_prompt = (
         "Channel: {channel.name}
          Niche: {channel.niche}
          Brand identity: {channel.brand_identity}
          Target audience: {channel.target_audience}
          Tracklist: ...
          Research: ...
          Extra instructions: {preset.claude_prompt}"
       )
```

What channel-specific knobs you have:
- `Channel.brand_identity` — 1 line, lost in the noise.
- `Channel.target_audience` — 1 line, same.
- `Channel.niche` — controls only the niche string in line 1.
- `AutomationPreset.claude_prompt` — appended at the end as
  "Extra instructions". Closer to a real lever but presets are
  per-channel-per-flavor, not per-channel.

What you DON'T have a knob for:
- The hardcoded `style_block()` content. The actual brand voice.

### Wizard "Generate with AI" button

```
api/metadata.py::fill_template
  → claude_cli_service.generate_raw
       system_prompt = (
         "You are a senior YouTube SEO copywriter for the '{niche}' niche.
          {style_block()}     ← same hardcoded YomiBeats reference
          If template is empty, generate following the house style
          verbatim — open the title with 『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』☯..."
       )
       user_prompt = (
         "Channel: {channel.name}
          Brand identity: {channel.brand_identity}
          Title template: {channel.title_template}      ← used here
          Description template: {channel.description_template}"
       )
```

This path also pastes `style_block()`. The
`channel.title_template` / `description_template` ARE used here as
"fill these {placeholders}" — but the surrounding system prompt is
still YomiBeats-flavored.

---

## Why the duplicates exist

- `Channel.title_template` was added so the user could lock down a
  template format. Then the auto-generate path was switched to
  always use `metadata_mode="claude"`, which routes through
  `style_block()` and ignores templates. Channel templates became
  half-orphaned.
- `AutomationPreset.title_template` was added before per-channel
  templates existed. Once `Channel.title_template` shipped, presets
  were supposed to inherit-with-override; today they just sit
  there as duplicates.
- `AutomationPreset.claude_prompt` was a quick patch to inject
  per-flavor instructions without touching the channel record.
- The `Prompts` library was a separate "save your favorite Claude
  prompts" feature and was never wired into the auto-gen flow.

Each addition was fine in isolation; together they're a tar pit.

---

## Proposed redesign

### One source of truth per channel

Replace the scattered fields with **one channel-scoped "AI voice"
record** that owns the system-level instructions:

```python
class Channel:
    # Existing (kept):
    niche: str | None
    brand_identity: str | None
    target_audience: str | None
    auto_translate_languages: list[str]   # already on preset; lift to channel

    # NEW — per-channel system-prompt content, replaces style_block():
    ai_voice: str | None              # free-form Markdown instructions
    ai_example_title: str | None      # concrete title example
    ai_example_description: str | None  # concrete description example
    ai_example_tags: str | None       # concrete CSV tag example

    # DEPRECATED (read-compat, write-redirect into ai_*):
    title_template: str | None        # → fold into ai_voice
    description_template: str | None  # → fold into ai_voice
```

The system prompt becomes a **template** that fills from the channel:

```
You are a senior YouTube SEO copywriter for the '{niche}' niche.
You ship metadata that ranks. Use the research signals below to
anchor real keywords.

## House voice (channel-specific)
{channel.ai_voice}

## Concrete examples (match the structure, swap the topic)
TITLE example:
  {channel.ai_example_title}

DESCRIPTION example:
{channel.ai_example_description}

TAGS example:
  {channel.ai_example_tags}

(... rest of structural rules — title length cap, JSON shape, etc.)
```

Now ZenTaoSounds gets meditation-flavored examples and YomiBeats
gets its existing chill-rap examples, **without code changes**.

### Drop dead code

- `AutomationPreset.title_template` — drop (or, if any presets in
  the wild use template mode, leave the column but stop reading
  it from `claude` mode flows; same effect).
- `AutomationPreset.description_template` — drop.
- `AutomationPreset.tags_template` — drop.
- `AutomationPreset.claude_prompt` — drop (folded into `ai_voice`).
  Per-flavor variation should live as multiple SAVED preset names,
  not as buried text on each preset.
- `Prompts` library — keep as a copy-paste catalog (it's a
  separate UX feature). Document that it's not wired to auto-gen.

### "Channel AI Voice" page

When the user clicks a channel in the Library (or via a new tab on
the channel detail page), they land on a page like:

```
ZenTaoSounds  →  AI Voice
─────────────────────────────────────────────────────────

[Niche]                  ambient meditation
[Brand identity]         Calm, dreamy, slightly melancholy ambient...
[Target audience]        People winding down, studying, sleeping...

──────────────  System-level voice  ──────────────
[AI voice]
┌────────────────────────────────────────────────┐
│ Open titles with a single emoji like 🌙 or ✨. │
│ Use lowercase mostly. Keep tone soft, never    │
│ commercial. Avoid hype words. The vibe is      │
│ "stillness, return to yourself."               │
└────────────────────────────────────────────────┘

──────────────  Concrete examples  ──────────────
[Example title]
🌙 deep sleep ambient · 8 hours of dreaming sound

[Example description]                  [Insert tracklist marker]
There's no rush. Let the night carry you ...
... (tracklist here) ...
... (channel pitch + CTA + 3 hashtags) ...

[Example tags]
ambient, sleep music, deep sleep, meditation,
healing frequencies, ...

──────────────  Translation  ──────────────
[Auto-translate to: ja, ko, es, fr  (✚ add language)]

──────────────  Live preview  ──────────────
[Show me what Claude will see for the next render]
[Generate a sample title, description, tags right now]
```

The "Show me what Claude will see" button renders the FULL system
+ user prompt with the channel's current voice + a real recent
project's tracks. Tells the user exactly what's getting sent.

The "Generate a sample" button hits the existing fill-template
endpoint with the channel's saved settings and shows the output.
Cheap to iterate — change voice → click sample → see effect.

---

## Implementation plan

### Phase 1 — Backend (1 day)

- Add `ai_voice`, `ai_example_title`, `ai_example_description`,
  `ai_example_tags` to `Channel`. Idempotent migration.
- One-time data move: copy the current hardcoded `style_block()`
  values into YomiBeats's record so its output stays identical.
  ZenTaoSounds and any new channels start with empty fields and a
  generic fallback.
- `claude_cli_service.style_block()` becomes
  `style_block(channel)` and reads from the channel. If
  `channel.ai_example_title` is empty, falls back to a
  generic instruction set ("write a title with the niche name +
  a hook word + ≤100 chars").
- `api/metadata.py::fill_template` switches to channel-aware
  `style_block(channel)`.
- New endpoints:
  - `GET /api/channels/{id}/ai-prompt-preview` — returns the full
    rendered system + user prompt for the channel's most recent
    project (or a synthetic preview if none).
  - `POST /api/channels/{id}/ai-sample` — runs Claude with the
    channel's voice + a fake or recent track list, returns sample
    title/description/tags. Cached for ~10 min so the user can
    iterate without burning Claude credits.
- Tests: voice gets injected per-channel, fallback behaviour
  when fields are empty, dropping the preset fields doesn't break
  cron-driven `execute_run`.

### Phase 2 — Frontend (1 day)

- New `ChannelAIVoiceTab` on the channel detail page (or a new
  page at `/channels/{id}/ai-voice`).
- Form-driven (react-hook-form + zod, matching `BrandProfileTab`
  style): `niche`, `brand_identity`, `target_audience`, `ai_voice`,
  `ai_example_title`, `ai_example_description`, `ai_example_tags`,
  `auto_translate_languages`.
- "Show me what Claude will see" panel — fetches the preview
  endpoint, renders the prompt in a `<pre>` block.
- "Generate a sample" button — hits the sample endpoint, renders
  the title/description/tags side-by-side with the saved values.
- Drop the `claude_prompt` / `*_template` fields from the
  `AutomationPresetForm`. Keep them on the model in case any
  cron jobs reference them, but stop showing them.

### Phase 3 — Cleanup (0.5 day)

- Drop the dead preset fields from the frontend forms.
- Update `docs/MULTI_CHANNEL.md` + `docs/ARCHITECTURE.md` to
  describe the new model.
- Optional: remove the dead `Prompts` library entirely OR move it
  to a "Snippets" page that's clearly labeled as a catalog.

---

## Risk + migration

- **Backward compat**: YomiBeats's output stays identical because
  we copy the hardcoded examples into its record before switching
  the code over. If `channel.ai_example_title` is empty for any
  reason, the fallback is a generic style brief — output gets
  worse but doesn't fail.
- **Auto-translate**: the languages list lives on `AutomationPreset`
  today (`auto_translate_languages`). Lifting it to `Channel` is a
  Phase 2 nice-to-have; can defer.
- **Dropping preset templates**: nothing breaks because the dashboard
  flow already ignores them. Only `execute_run` (cron, folder mode)
  reads them — leaving the code path intact preserves any cron
  schedules that still rely on it.

---

## What you'd see after this lands

- One tab per channel — "AI Voice" — with everything that controls
  the per-video metadata in one form.
- Live preview button to see exactly what Claude is being told.
- Sample button to test before committing.
- Other channels (ZenTaoSounds, foreplay radio) generate output that
  reflects their own niche, not YomiBeats's typographic mannerisms.
- The 5-field tangle (`brand_identity` × `claude_prompt` ×
  `title_template` × `description_template` × `tags_template`)
  collapses to: niche, brand_identity, target_audience, ai_voice,
  ai_example_title, ai_example_description, ai_example_tags.
