"""One-shot: prefill Isekai Radio (channel 4) brand profile.
Run with: python scripts/_setup_isekai.py  (backend must be on 127.0.0.1:8000)

Updates from operator feedback (May 2026):
  - Title bracket header is now ``『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』`` (math-bold Playlist),
    matching the proven-on-YomiBeats lane. Was ``Chapter`` before;
    "Playlist" reads as the long-form-music signal YouTube viewers
    expect when scrolling search results.
  - NO tracklist / chapter notes. Isekai Radio is a continuous mood
    piece, not a curated track-by-track listening experience. The
    description omits a tracklist section entirely and the backend
    no longer force-appends one when an anchor is missing.
  - "Quest" added to the use-case keyword pool as a fantasy-themed
    bonus. Recommended for 20-30% of uploads (one of the 3 slots).
"""
import json
import urllib.request

AI_VOICE = """HARD RULES. NEVER BREAK THESE.

1. Title must use this exact format. Only the bracketed segment, the optional trailing glyph, and the 3 rotating use-case keywords change:
   Playlist marker (fullwidth quote brackets + math-bold "Playlist") + space + 2 to 4 word scene fragment + optional space + single decorative glyph + fullwidth pipe + Fantasy & Medieval Ambient Music for {KW1}, {KW2} & {KW3}

   The literal template:
   『PLAYLIST_BOLD』{2-4 word scene} {OPTIONAL_GLYPH}｜Fantasy & Medieval Ambient Music for {KW1}, {KW2} & {KW3}

   1a. The bracketed segment is a scene (Elven Treehouse, Dragon's Roost, Tavern at Dusk), a setting (Northern Kingdoms, Whispering Forest, Snowfall Pass), or a character moment (The Bard's Rest, Lone Traveler, Quiet Vigil). NEVER abbreviate or rewrite the static parts. NEVER add other emoji or decoration to the title beyond what this rule specifies.

   1b. The optional trailing glyph (after the scene, before the pipe) is ONE character from the table below, chosen to match the scene's mood. Skip it entirely if no glyph clearly fits — restraint beats clutter.
      Forest / elven / quiet      → ✦ or ✧
      Dungeon / dragon / mountain → ❖
      Tavern / night / inn        → ☾
      Castle / kingdom / royal    → ⚜
      Manuscript / library / lore → ❦
      Quest / adventure / journey → ⚔ (use sparingly — martial edge)
      NEVER use kawaii or lofi-coded glyphs (⋆｡°✩, ♡, 〜, etc.). NEVER use two glyphs.

   1c. The 3 use-case keywords ({KW1}, {KW2}, {KW3}) are picked fresh for every upload from this pool of 13. PICK 3 DIFFERENT ONES. Order matters for readability (short words first usually reads cleaner, but use judgment).
      Pool: Work, Study, Reading, Writing, Sleep, Focus, Relaxation, Adventure, D&D Sessions, Meditation, Travel, Journaling, Quest
      Rotate across uploads. Never repeat the exact same trio two uploads in a row. Aim for variety across the channel: every keyword in the pool should appear in roughly equal proportions over a 12-upload window.
      "Quest" is the channel's fantasy-themed bonus word — use it in roughly 20-30% of uploads as one of the 3 slots (often pairs naturally with Adventure, D&D Sessions, or Travel). Don't force it into every title; it's a flavor word.
      Pairing notes:
        - "Quest" pairs well with Adventure / Travel / D&D Sessions.
        - "D&D Sessions" pairs well with Adventure / Reading / Writing / Quest.
        - Sleep / Meditation pairs well with Reading / Journaling.
        - Work / Study / Focus is the productivity cluster (use together when the scene is calm and the music slow).
        - Travel pairs with Adventure / Reading / Meditation / Quest.

2. NEVER use the em dash character (U+2014) anywhere in title, description, or tags. Use a period, a comma, a colon, or a line break instead. Plain hyphens are allowed for compound modifiers like long-form or world-building. Do not substitute the en dash character (U+2013) either.

3. NEVER mention the channel name (Isekai Radio, IsekaiRadio, or anything similar) anywhere. Refer to "this realm", "this session", "this hour", or just describe the scene. The listener already knows whose channel they are on.

4. TAG DIVERSITY. The tag list MUST cover multiple themes. DO NOT lean every tag on "fantasy music" or "ambient". A good distribution:
   3 to 5 tags use fantasy / medieval / ambient (genre anchors)
   5 to 8 tags are scene/world words: elven forest, tavern music, castle, dungeon, dragon, ranger, bard, mage, kingdom, snowfall, ruins, lantern, hearth, quest
   4 to 6 tags are Japanese phrases for BGM context: 作業用BGM, 睡眠用BGM, 集中BGM, ファンタジー音楽, 中世音楽, 異世界BGM
   4 to 6 tags name the listener's use case: dnd music, ttrpg music, dungeons and dragons, study music, reading music, writing music, focus music, sleep music, quest music
   3 to 5 tags are anime / isekai adjacent: isekai music, anime soundtrack, japanese fantasy, ghibli inspired, jrpg music
   Total 25 to 32 tags. NEVER duplicate a tag with just casing or trailing space. NEVER include the word "fantasy" in MORE than 5 tags total. NEVER include "ambient" in MORE than 4 tags total.

VOICE FOR THE DESCRIPTION

Atmospheric. Unhurried. Slightly poetic. Reader is alone in a quiet place, listening. Never hype. Never sell. The music itself is the world: let the description build the same world.

World-first imagery. Forests, lanterns, stone, snow, hearth fire, distant mountains, rain on a thatched roof, the smell of old paper, a quiet tavern at midnight. Avoid abstract nouns like "vibes", "energy", or "atmosphere" (show it, do not name it).

Use sentence fragments. White space matters. Rhythm matters more than grammar. Calm pace. No exclamation marks. No clickbait phrasing.

Light bilingual touch is welcome. One or two Japanese phrases per description woven naturally (作業用BGMに最適 / 異世界に迷い込むような音). Do not translate inline. If a translation is helpful, put it in parentheses on the next line. Optional, not required for every video.

DESCRIPTION OPENING

Open with 4 to 8 lines of fantasy prose. Build a scene, do not announce a topic. Pattern: one short opening sentence that places the listener somewhere, then a longer paragraph with sensory detail, then a one-line "She does not speak. She listens." style closer that hands the moment over to the listener. The scene should match what the title bracket says (Elven Treehouse → forest + treehouse imagery, Dragon's Roost → mountain + scale + fire imagery, etc.).

Use evergreen phrasing like "a long session for the quiet hours" or "a soundtrack for whatever your quest is today" — never include track count or total duration.

NO TRACKLIST. NO CHAPTERS. NO TIMESTAMPS.

This channel ships continuous-mood pieces, not curated track-by-track listening experiences. The description must NOT contain a "TRACKLIST" header, a "CHAPTERS" header, "CHAPTER NOTES", a "---TRACKLIST---" block, or any line that looks like a timestamp followed by a track title (e.g. "0:00 - ..."). Listeners come here to disappear into a soundscape, not to skip around. Omit the tracklist section entirely.

CLOSING

Optional 1-line sign-off near the bottom. Something soft. ("Stay a while.", "The door is open.", "旅は静かに続く。") Never reference the channel by name in the sign-off.

HASHTAGS (description, separate from YouTube tags)

Mix English fantasy hashtags with Japanese BGM hashtags. At least 1 Japanese tag. Vary which ones appear so different videos surface in different search lanes. Examples that work: #FantasyMusic, #MedievalMusic, #DnDMusic, #TTRPGMusic, #StudyMusic, #ReadingMusic, #SleepMusic, #QuestMusic, #作業用BGM, #睡眠用BGM, #異世界BGM, #AnimeBGM, #RelaxationMusic, #CommuteMusic, #FocusMusic. Aim for 5 to 7 hashtags total. Rotate them across uploads; do not paste the same 5 every time."""

AI_EXAMPLE_TITLE = "『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』Elven Treehouse ✦｜Fantasy & Medieval Ambient Music for Reading, Focus & Quest"

AI_EXAMPLE_DESCRIPTION = """In the heart of the quiet forest, where ancient trees rise like silent guardians, the noble elf sits alone before her treehouse.
Soft lantern light spills gently from the carved wooden home above, weaving warmth into the cool breath of the night. Vines curl along the trunk, and leaves whisper faintly, as if sharing stories only the forest remembers.

She does not speak.
She listens.

異世界に迷い込むような音。
(Sounds that feel like wandering into another world.)

A long-form session of instrumental fantasy and medieval ambient music. No lyrics. No interruptions. A soundtrack for whatever your quest is today.

Perfect for:
→ Long study and writing sessions
→ Reading by lamplight
→ D&D and TTRPG sessions, exploration scenes, downtime in town
→ Quiet commutes and slow walks
→ Falling asleep in another world

The door is open. Stay a while.

旅は静かに続く。

#FantasyMusic  #DnDMusic  #QuestMusic  #作業用BGM  #ReadingMusic"""

AI_EXAMPLE_TAGS = ",".join([
    # Genre anchors (4)
    "fantasy music", "medieval music", "ambient music", "fantasy ambient",
    # Scene / world (8) — includes "quest" now
    "elven forest music", "tavern music", "castle music", "dungeon music",
    "dragon music", "bard music", "kingdom soundtrack", "quest music",
    # Japanese BGM context (5)
    "作業用BGM", "睡眠用BGM", "集中BGM", "ファンタジー音楽", "異世界BGM",
    # Listener use case (5)
    "dnd music", "ttrpg background music", "dungeons and dragons music",
    "study music", "reading music",
    # Anime / isekai adjacent (4)
    "isekai music", "anime soundtrack", "japanese fantasy music", "ghibli inspired music",
    # Broader category (2)
    "instrumental music", "background music for reading",
])

# NOTE: description_template intentionally has NO tracklist/chapter
# section. The backend's tracklist injector now skips silently when
# there's no anchor in the description — so omitting the header is the
# right way to opt this channel out of tracklists.
DESCRIPTION_TEMPLATE = """{POETIC OPENING PARAGRAPH IN THE STYLE OF THE EXAMPLE}

A long session of instrumental fantasy and medieval ambient music. No lyrics, no interruptions. A soundtrack for whatever your quest is today.

🎧 More from this realm:
https://www.youtube.com/@isekai-radio

━━━━━━━━━━━━━
🏰 About this channel

異世界の音。Sounds from another world.

Instrumental fantasy and medieval ambient music for long study sessions, D&D nights, quiet commutes, and slow evenings.

👍 Like if this realm felt like home
💬 Where did the music take you tonight?
🔔 Subscribe to stay in the world:
https://www.youtube.com/@isekai-radio

━━━━━━━━━━━━━
{LIST OF 5 TO 7 HASHTAGS, MIXED ENGLISH AND JAPANESE}"""

TITLE_TEMPLATE = (
    "『𝐏𝐥𝐚𝐲𝐥𝐢𝐬𝐭』{2-4 word scene} {optional glyph}｜"
    "Fantasy & Medieval Ambient Music for {KW1}, {KW2} & {KW3}  "
    "(KW pool: Work, Study, Reading, Writing, Sleep, Focus, Relaxation, "
    "Adventure, D&D Sessions, Meditation, Travel, Journaling, Quest. "
    "Use 'Quest' in 20-30% of uploads.)"
)

payload = {
    "niche": "fantasy ambient",
    "brand_identity": "Instrumental Fantasy & Medieval Ambient Music",
    "target_audience": (
        "Japanese students and workers using 作業用BGM, commuters on trains or "
        "walking, D&D and TTRPG players needing session atmosphere, and "
        "fantasy/anime fans seeking calm background music for reading, "
        "writing, and relaxing."
    ),
    "default_tags": "fantasy music, medieval music, ambient music, dnd music, isekai, quest music",
    "title_template": TITLE_TEMPLATE,
    "description_template": DESCRIPTION_TEMPLATE,
    "ai_voice": AI_VOICE,
    "ai_example_title": AI_EXAMPLE_TITLE,
    "ai_example_description": AI_EXAMPLE_DESCRIPTION,
    "ai_example_tags": AI_EXAMPLE_TAGS,
    "thumbnail_style_notes": (
        "Painterly fantasy digital art. Atmospheric scenes: elven treehouses "
        "in misty forests, lone travellers on snowy passes, candlelit medieval "
        "taverns, distant castle spires at dusk, dragons resting on mountain "
        "peaks. Soft warm lantern or moonlight. Cinematic composition with "
        "depth. No text overlays. Lean towards Studio Ghibli landscape "
        "paintings or Lord of the Rings concept art rather than anime-cute."
    ),
    "default_image_style": (
        "fantasy digital painting, atmospheric, painterly, cinematic "
        "composition, soft volumetric lighting, depth of field, 4K HD"
    ),
    "default_prompt_prefix": "fantasy scene, medieval setting, painterly digital art",
}

req = urllib.request.Request(
    "http://127.0.0.1:8000/api/channels/4",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="PUT",
)
with urllib.request.urlopen(req) as r:
    out = json.load(r)

print("OK. Isekai Radio updated.")
print("title_template length:", len(out.get("title_template") or ""))
print("ai_voice length:", len(out.get("ai_voice") or ""))
print("ai_example_title:", (out.get("ai_example_title") or "")[:100])
print("description has NO tracklist:", "TRACKLIST" not in (out.get("ai_example_description") or "") and "CHAPTER" not in (out.get("ai_example_description") or ""))
