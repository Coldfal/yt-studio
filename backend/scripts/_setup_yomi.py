"""One-shot: REVERT YomiBeats (channel 1) title format to the
data-proven shape from May 2026 analytics.

The earlier fancy format (math-bold + fullwidth brackets + kawaii glyph
+ 3-keyword rotating tail) was set on aesthetic intuition. Real
analytics on the breakout video showed the plain ASCII format with a
conversational hook + 2-keyword tail wins:

    [Playlist] chill with me | Japanese Chill HipHop & Lofi Rap. Play for Study and Relax Sessions

88,219 impressions, 2,120 views, 6.2% CTR on Home Feed, 22:18 avg
view duration on a 1:57:47 video. That's the format to replicate.

Re-running this script overwrites whatever's currently set on channel 1.
"""
import json
import urllib.request

AI_VOICE = """HARD RULES. NEVER BREAK THESE.

1. Title must use this exact format. Only the bracketed hook and the rotating use-case keywords change:
   Plain ASCII bracket marker "[Playlist]" + space + 2 to 4 word conversational/scene hook + space + ASCII pipe "|" + space + Japanese Chill HipHop & Lofi Rap. Play for {KW1} and {KW2} Sessions

   The literal template:
   [Playlist] {2-4 word hook} | Japanese Chill HipHop & Lofi Rap. Play for {KW1} and {KW2} Sessions

   1a. The hook is a CONVERSATIONAL invitation (preferred), a scene (acceptable), or a CTA (acceptable).
      - Conversational (BEST — these are what's converting): "chill with me", "vibe with me", "flow with me", "drift with me", "study with me", "work with me", "stay with me", "sleep with me"
      - Scene fragments: "City Lights Tokyo", "Rainy Shibuya Night", "Late Night Coffee", "Velvet Window"
      - Feelings/CTAs: "Quiet Hours", "Stay Here", "Don't Look Back"
      The conversational "X with me" pattern is the audience-proven winner. Lean on it 60-80% of the time. Vary the verb so a 12-upload window doesn't repeat the same hook twice in a row.

   1b. NO decorative glyphs. NO math-bold characters. NO fullwidth brackets. NO kawaii sparkles. The breakout video used plain ASCII and won 88,219 impressions — decoration was hurting CTR, not helping. The static parts ("[Playlist]", "|", "Japanese Chill HipHop & Lofi Rap. Play for", "Sessions") are LITERAL and must appear exactly as written, with the ASCII pipe (U+007C), not the fullwidth pipe.

   1c. The 2 use-case keywords ({KW1}, {KW2}) are picked fresh for every upload from this pool of 12. PICK 2 DIFFERENT ones. Use AND (lowercase "and") between them.
      Pool: Work, Study, Relax, Sleep, Focus, Reading, Coding, Late Night, Rainy Day, Coffee, Driving, Chill
      Rotate across uploads. Never repeat the exact same pair two uploads in a row. Aim for variety: each keyword should appear in roughly equal proportions over a 12-upload window. The breakout video used "Study and Relax" — that pair is a known winner; rotate it in occasionally but don't lean on it every time or YouTube treats us as duplicate content.
      Pairing notes:
        - Study and Relax = canonical, replicate the breakout
        - Sleep and Relax = wind-down audience
        - Work and Focus = productivity audience
        - Late Night and Driving = night drives, very on-brand for this channel
        - Coffee and Reading = slow-morning audience
        - Chill and Coding = developer crowd, niche but loyal

   1d. Total title length should stay under 100 characters where possible (YouTube truncates after ~100 in search). The static tail is 71 characters; the bracket + hook segment has roughly 28 characters of headroom.

2. NEVER use the em dash character (U+2014) anywhere in title, description, or tags. Use a period, a comma, a colon, or a line break instead. Plain hyphens are allowed for compound modifiers like late-night or old-school. Do not substitute the en dash character (U+2013) either.

3. NEVER mention the channel name (YomiBeats, Yomi Beats, or anything similar) anywhere. Refer to "this playlist", "this mix", "the playlist", or just describe the music. The viewer already knows whose channel they are on.

4. TAG DIVERSITY. The tag list MUST cover multiple themes. DO NOT lean every tag on "lofi" or "lo-fi" or "lofi hip hop". A good distribution:
   3 to 5 tags use lofi / lo-fi / lofihiphop (genre anchors — these are the high-volume winners)
   5 to 8 tags are mood/scene words: aesthetic, night drive, urban solitude, rainy, sleep music, focus, work, study, ambient, mellow, cozy, city, neon, midnight, rooftops
   5 to 8 tags are Japanese / Korean phrases (作業用BGM, 睡眠用bgm, 日本語ラップ, 감성 힙합, etc.)
   3 to 5 tags are J-pop / R&B / chill rap variants without lofi
   1 to 2 tags name the broader category: jazzy beats, instrumental hip hop, beats to study to
   Total 25 to 32 tags. NEVER duplicate a tag with just casing or trailing space. NEVER include the niche word "lofi" in MORE than 5 tags total.

VOICE FOR THE DESCRIPTION

Atmospheric. Restrained. Slightly melancholic. Reader is alone with a window, a coffee, a city. Never hype. Never sell.

Bilingual. Weave a few short Japanese lines (kana / kanji) directly into the English copy. Do not translate inline. If a translation is helpful, put it in parentheses on the next line. Keep Japanese natural. Short evocative fragments, not long prose.

Concrete sensory imagery beats adjectives. Rooftops, rain on glass, laundry drying, neon reflections, an empty train at 1am. Avoid abstract nouns like "vibes" or "ambiance".

Use sentence fragments. White space matters. Rhythm matters more than grammar.

DESCRIPTION OPENING (REQUIRED, EVERY VIDEO)

The description MUST begin with 2 to 4 lines of original bilingual lofi poetry. Not a topic announcement. Not "Welcome to my channel". Not the tracklist. Build a single mood / moment / image first; everything else follows.

Pattern: one short English sentence that places the listener somewhere (a rooftop, a 2am train, a coffee shop window). Optional Japanese line directly after. Blank line. One slightly longer atmospheric sentence with sensory detail. Optional Japanese closer in parentheses.

The poem must match the hook in the title bracket (Rainy Shibuya Night → wet pavement, neon, umbrella imagery. City Lights Tokyo → high windows, skyline, late commuters. "chill with me" → first-person quiet room, two cups, sleep imagery). NEVER reuse the same opening lines across uploads — every poem is fresh.

After the poem, a single blank line, then a 1-2 sentence mood paragraph that describes what the playlist holds without listing tracks. Then a "Perfect for:" arrow list, tracklist header, sign-off, hashtags.

Never include track count or total duration. Use evergreen phrasing like "a curated playlist" or "a long-form session".

CLOSING

Optional 1-line bilingual sign-off near the bottom (example: "Press play. 空に少しだけ近づいてみよう。"). Never reference the channel by name in the sign-off either.

HASHTAGS (description, separate from YouTube tags)

Mix Japanese and English. At least 2 Japanese tags. Examples that work: #睡眠用bgm, #lofihiphop, #japanesehiphop, #studymusic, #chillbeats, #focusmusic, #backgroundmusic, #chillmusic, #作業用bgm. Aim for 5 to 7 hashtags total."""

AI_EXAMPLE_TITLE = (
    "[Playlist] chill with me | Japanese Chill HipHop & Lofi Rap. "
    "Play for Study and Relax Sessions"
)

AI_EXAMPLE_DESCRIPTION = """The wind moved. 空が少しだけ近い場所。
No ceiling. No noise. Just rooftops, white clouds, and a slow beat drifting over the city.

東京の空は、見上げる人にだけ広がる。
(Tokyo's sky only opens up for the people who look up.)

Sunny chill rap and J-pop lofi flips for rooftop afternoons, laundry drying in the breeze, the long stretch of an empty Sunday, and the hours when the city feels lighter than it should.

Perfect for:
→ Rooftop afternoons and slow Sundays
→ Late-night drives through quiet streets
→ Long study sessions and creative flow
→ Background for journaling or reading
→ Winding down while the city keeps moving

━━━━━━━━━━━━━━━━━━━━━━━━━━━━

TRACKLIST



━━━━━━━━━━━━━━━━━━━━━━━━━━━━

A curated playlist for listeners who live between the rain and the rhythm. No ads, no interruptions. Just lofi study music that holds the mood.

Press play. 空に少しだけ近づいてみよう。

#睡眠用bgm  #lofihiphop  #japanesehiphop  #chillbeats  #studymusic"""

TITLE_TEMPLATE = (
    "[Playlist] {2-4 word conversational hook} | Japanese Chill HipHop & "
    "Lofi Rap. Play for {KW1} and {KW2} Sessions  "
    "(KW pool: Work, Study, Relax, Sleep, Focus, Reading, Coding, Late Night, "
    "Rainy Day, Coffee, Driving, Chill)"
)

payload = {
    "title_template": TITLE_TEMPLATE,
    "ai_voice": AI_VOICE,
    "ai_example_title": AI_EXAMPLE_TITLE,
    "ai_example_description": AI_EXAMPLE_DESCRIPTION,
}

req = urllib.request.Request(
    "http://127.0.0.1:8000/api/channels/1",
    data=json.dumps(payload).encode("utf-8"),
    headers={"Content-Type": "application/json"},
    method="PUT",
)
with urllib.request.urlopen(req) as r:
    out = json.load(r)

print("OK. YomiBeats reverted to data-proven format.")
print("title_template length:", len(out.get("title_template") or ""))
print("ai_voice length:", len(out.get("ai_voice") or ""))
print("ai_example_title length:", len(out.get("ai_example_title") or ""))
