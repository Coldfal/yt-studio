"""One-shot: set up Yomi Radio (channel 5) brand profile.

Channel concept: instrumental study and work music. Soft, supportive,
motivational tone — the "let's do this together" voice. Visual style:
cream/beige backgrounds, food/coffee-item compositions (coffee cup +
croissant + glasses + lamp etc.), lowercase "playlist" + duration as
the only thumbnail text. The competitor channels in this lane
(referenced by the operator) consistently hit 700K-2.4M views per
upload using this pattern, with bare conversational titles and no
genre/keyword tail.

Distinct from YomiBeats:
  - No Japanese language / bilingual register
  - No urban/chillrap aesthetic
  - No "TOKYO" branding
  - Simpler, more direct description voice
  - Em dashes are ALLOWED (competitor titles use them)
"""
import json
import urllib.request

AI_VOICE = """HARD RULES. NEVER BREAK THESE.

1. Title must use this exact format. Only the conversational hook changes:
   Plain ASCII bracket marker "[Playlist]" + space + 4 to 10 word motivational/conversational hook

   The literal template:
   [Playlist] {motivational conversational hook, 4-10 words}

   1a. The hook is the entire creative space. Make it SOUND like a supportive friend, not a brand. The reference channels in this niche win with hooks like:
      - "Let's lock in and get it done"
      - "Let's work slow and easy"
      - "No Excuses, Just Progress"
      - "Focus now, feel proud later"
      - "Take it easy — you've been pushing hard"
      - "Your effort today builds your tomorrow"
      - "What you do today matters most"
      - "Let's tune out the noise and get things done"
      - "Do something today that your future self will thank you for"
      - "One more hour, one more chapter"
      - "Soft start, steady finish"
      - "Quiet hours, real progress"

      Patterns to draw from:
        - "Let's X" (invitation, plural, supportive)
        - "Focus X" / "Take X" / "Your X" (direct second-person, encouraging)
        - "X today, Y tomorrow" (cause-and-effect motivational)
        - "X but Y" (gentle realism — "tired but trying", "slow but steady")
        - Imperative + softener ("Focus now, feel proud later")

      Vary the opener across uploads so a 12-upload window doesn't open with "Let's" more than 4 times. Mix in "Focus", "Take", "Your", "What", "Soft", "Quiet" openers.

   1b. NO emoji. NO decorative glyphs (no ⋆｡°✩, no ❦, no math-bold characters, no fullwidth brackets). The competitor channels in this niche use plain typography only — that's what's converting.

   1c. Em dashes (U+2014) are ALLOWED in titles for this channel. Competitor titles use them ("Let's get things done — together", "Take it easy — you've been pushing hard") and convert at scale. Em dashes are still NOT allowed in tags (which are comma-separated and don't need them).

   1d. NO genre/keyword tail. Do NOT append "| Lofi Hip Hop", "| Study Music", "for Work and Focus", or anything similar. The competitor data is unambiguous: bare conversational titles win in this niche. SEO comes from tags and description, not title keywords.

   1e. Total title length should stay under 80 characters. Mobile truncation hits hard on study/work-music thumbnails because users scroll fast.

2. NEVER mention the channel name (Yomi Radio, YomiRadio, or anything similar) anywhere in title or description. Refer to "this playlist", "this session", "this hour", or just describe the moment.

3. TAG DIVERSITY. The tag list MUST cover multiple themes. Distribution target:
   3 to 5 tags name the genre anchors: study music, instrumental music, lofi, chill music, background music
   5 to 8 tags name the use-case scene: coffee shop music, cafe music, work playlist, study playlist, productivity music, focus music, deep work music, reading music
   4 to 6 tags name the mood: relaxing, calm, peaceful, mellow, soft, soothing
   3 to 5 tags name adjacent genres: chillhop, jazzhop, instrumental hip hop, retro lofi, ambient
   2 to 4 tags name listener intent: music for studying, music for working from home, music to focus, music for concentration
   Total 25 to 32 tags. NEVER duplicate a tag with just casing or trailing space. Avoid leaning more than 5 tags on any single genre word.

VOICE FOR THE DESCRIPTION

Warm. Direct. Supportive — like a friend who's also working alongside you. Short sentences. No purple prose, no bilingual flair (this is the English-only productivity register, NOT YomiBeats' Japanese lofi aesthetic).

The description does NOT need to be long. Three short paragraphs + tracklist + sign-off + hashtags is the full template. Quality over quantity.

DESCRIPTION OPENING (REQUIRED, EVERY VIDEO)

Open with 2 to 3 short lines that match the title's motivational tone. Pattern:
  - First line: a punchy contextual opener ("A new month is here.", "Monday again.", "Halfway through the week.", "Late afternoon.", "Early start today.")
  - Second line: an invitation ("Let's get it done.", "Let's take it slow.", "Let's lock in.")
  - Third line (optional): one sentence describing what this music is for ("A relaxing melody is perfect for focusing, relaxing, or simply savoring a peaceful moment.").

Keep it under 50 words total in the opener. The reference operator description:
  > "A new month is here. Let's get it done.
  >  A relaxing melody is perfect for focusing, relaxing, or simply savoring a peaceful moment."

NEVER reuse the exact same opener lines across uploads — vary the contextual hook each time (time of day, day of week, season, mood, etc.).

DESCRIPTION BODY

After the opener, ONE blank line, then the "TRACKLIST" header (3 hyphens on either side, no other decoration):
  ---TRACKLIST---

Leave the tracklist block empty — the wizard fills in timestamps + track names automatically.

After tracklist, ONE blank line, then a 2-line call to action:
  Subscribe and like
  (optional second line: a soft prompt — "Come back tomorrow.", "See you in the next session.", "Tea's still warm.")

After CTA, ONE blank line, then hashtags. Limit to 5 to 7 hashtags per video. Rotate them across uploads from the channel's known-good pool so different videos surface in different search lanes — never paste the exact same set two uploads in a row.

HASHTAGS POOL (rotate, mix 5-7 per upload)

#backgroundmusic #coffeetime #coffeebreak #coffeeshopmusic #cafemusic
#lofimusic #chillmusic #chillhop #lofihiphop #relaxingmusic
#lofimusicforsleep #musicforsleep #studymusic #retromusic #lofichill
#retrolofi #funk #funkopop #relaxation #relaxmusic
#lofiremix #backgroundmusicforsleep #lofiforstudy

Pairing notes:
  - #studymusic + #coffeeshopmusic + #lofimusic = productivity cluster (canonical)
  - #relaxingmusic + #musicforsleep + #backgroundmusic = wind-down cluster
  - #chillhop + #lofihiphop + #lofichill = genre-anchor cluster
  - #cafemusic + #coffeetime + #coffeebreak = scene cluster
  - Avoid using ALL three from the same cluster in one upload — mix one from each."""

AI_EXAMPLE_TITLE = "[Playlist] Let's lock in and get it done"

AI_EXAMPLE_DESCRIPTION = """A new month is here. Let's get it done.
A relaxing melody is perfect for focusing, relaxing, or simply savoring a peaceful moment.

---TRACKLIST---



Subscribe and like
See you in the next session.

#studymusic  #coffeeshopmusic  #lofimusic  #chillhop  #backgroundmusic"""

AI_EXAMPLE_TAGS = ",".join([
    # Genre anchors (4)
    "study music", "instrumental music", "lofi", "background music",
    # Use-case scene (8)
    "coffee shop music", "cafe music", "work playlist", "study playlist",
    "productivity music", "focus music", "deep work music", "reading music",
    # Mood (5)
    "relaxing music", "calm music", "peaceful", "mellow", "soft music",
    # Adjacent genres (4)
    "chillhop", "jazzhop", "instrumental hip hop", "ambient",
    # Listener intent (5)
    "music for studying", "music for working from home", "music to focus",
    "music for concentration", "music for reading",
    # Broader / category (2)
    "lofi study", "chill beats to work to",
])

DESCRIPTION_TEMPLATE = """{2-3 LINE MOTIVATIONAL OPENING that matches the title's hook}

---TRACKLIST---

{LIST OF TRACKS}


Subscribe and like
{optional soft sign-off}


{5-7 HASHTAGS rotated from the channel pool}"""

TITLE_TEMPLATE = (
    "[Playlist] {4-10 word motivational conversational hook}  "
    "(Hook patterns: \"Let's X\", \"Focus X\", \"Take X\", \"Your X\", "
    "\"X today, Y tomorrow\", \"X but Y\". NO genre tail. Em dashes OK.)"
)

payload = {
    "name": "yomi radio",
    "niche": "study music",
    "brand_identity": (
        "Instrumental study and work music. Soft, supportive, motivational. "
        "The 'let's do this together' register — like a friend who's "
        "working alongside you. Cream/beige aesthetic; coffee, books, "
        "headphones, soft lighting. NO bilingual flair, NO urban/chillrap "
        "branding (that's YomiBeats' territory)."
    ),
    "target_audience": (
        "Students cramming for exams, remote workers in a focus block, "
        "anyone with a 2-hour deep-work session ahead. Coffee-shop "
        "co-working crowd, evening journaling, weekend study marathons. "
        "Skews 18-35, gender-balanced (instrumental no-lyrics content "
        "doesn't gender-type the way chillrap does)."
    ),
    "default_tags": "study music, lofi, instrumental music, coffee shop music, background music",
    "title_template": TITLE_TEMPLATE,
    "description_template": DESCRIPTION_TEMPLATE,
    "ai_voice": AI_VOICE,
    "ai_example_title": AI_EXAMPLE_TITLE,
    "ai_example_description": AI_EXAMPLE_DESCRIPTION,
    "ai_example_tags": AI_EXAMPLE_TAGS,
    "thumbnail_style_notes": (
        "Cream / beige / off-white flat background. Cut-out food, drink, "
        "and stationery objects arranged in a row across the centre: "
        "iced coffee cup, croissant, cinnamon roll, stack of books, "
        "round glasses, desk lamp, vinyl record, headphones, matcha "
        "latte, cheesecake slice, alarm clock, plant pot. 3 to 5 items "
        "per thumbnail; vary the combination per video. Bottom-right of "
        "the thumbnail has a small badge reading lowercase \"playlist\" "
        "with a music-note icon and the duration (e.g. \"3:31:18\") next "
        "to it. NO faces, NO people, NO Japanese characters, NO city "
        "imagery. The objects ARE the brand."
    ),
    "default_image_style": (
        "minimalist product photography, isolated objects on cream "
        "background, soft natural lighting, no shadows, magazine layout, "
        "high resolution 4K"
    ),
    "default_prompt_prefix": "minimalist still-life of coffee + book + soft objects, cream background, magazine cutout style",
}

req = urllib.request.Request(
    "http://127.0.0.1:8000/api/channels/5",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="PUT",
)
with urllib.request.urlopen(req) as r:
    out = json.load(r)

print("OK. Yomi Radio (channel 5) configured.")
print(f"  niche             : {out.get('niche')}")
print(f"  brand_identity len: {len(out.get('brand_identity') or '')}")
print(f"  ai_voice len      : {len(out.get('ai_voice') or '')}")
print(f"  example tags count: {len((out.get('ai_example_tags') or '').split(','))}")
print(f"  example title     : {(out.get('ai_example_title') or '')[:80]}")
