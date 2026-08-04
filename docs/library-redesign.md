# Library redesign — channel-first asset model

> **Status**: design proposal. Audit done; awaiting approval before
> implementation. Replaces the current global-folder model with one
> where folders belong to a channel.

## TL;DR

The Library mixes assets from every channel into one global tree
because the sidebar's primary axis is `asset_type` (Music / Images /
Videos / Composed) instead of `channel`. Folders are also global —
"Lofi" is one row, even though every video render only ever pulls
from a single channel's library. This makes the folder UI
functionally pointless: you can't ever say "render uses Lofi
folder" because the renderer is always channel-scoped.

Proposal: flip the navigation axis. Channel is the top-level node;
asset_types are children; folders are grandchildren scoped to
`(channel_id, asset_type)`. Migration is near-trivial because no
existing folder spans multiple channels.

---

## Audit (current state, this database)

```
240 assets across 2 channels
  YomiBeats     148  (music 73, image 15, video 1, composed 59)
  ZenTaoSounds   92  (music 59, image 11, composed 22)

Orphan assets (channel_id pointing at a deleted channel):  0
Multi-channel folders (folder used by assets from >1 channel):  0

Folders today (6 total):
  [3]  image/Backgrounds          (empty)
  [5]  image/ZenImages            (empty)
  [1]  music/Lofi                 (empty)
  [4]  music/demoaudio            (empty)
  [2]  music/Asian Instrumental   ZenTaoSounds=59
  [6]  music/CHILLRAP             YomiBeats=1

Assets not in any folder (per channel, per type):
  YomiBeats/composed: 59   YomiBeats/image: 15
  YomiBeats/music:    72   YomiBeats/video: 1
  ZenTaoSounds/composed: 22   ZenTaoSounds/image: 11
```

Two observations driving the design:

1. **75% of assets are unfoldered.** The current folder system has
   barely been used. Whatever we do, we don't break much.
2. **Every populated folder belongs to one channel only.** Migration
   is a 1:1 assign — no splits or cross-channel choices to make.

---

## Goals

| #   | Goal                                                                     | Why                                                                  |
|-----|--------------------------------------------------------------------------|----------------------------------------------------------------------|
| G1  | Channel is the primary navigation axis                                   | Every workflow (compose, automation, rate limits) is channel-scoped. |
| G2  | "Show me ZenTao's music" is one click from anywhere in the Library       | Currently 2 clicks + visual scanning of channel names.               |
| G3  | Folders organize WITHIN a channel, not across                            | Cross-channel folders have no functional meaning in any compose path.|
| G4  | Surface orphans (files on disk without a DB row) so they can be cleaned  | Risk-free disk hygiene; user has no way to find these today.         |
| G5  | Path to per-asset metrics (CTR per image per video) stays open           | Per-asset DB rows (`Asset.id`) remain stable.                        |

Non-goals:

- Cross-channel asset sharing. If a user wants the same image on two
  channels, they upload twice (or use the existing "Reassign to
  channel" action).
- Filesystem-first library (point at `D:\Music\Foo` and skip the
  upload). That's a separate question — see "Future: filesystem-mode"
  at the bottom.

---

## Proposed model

### Schema change

```python
class AssetFolder(Base):
    id          = Mapped[int]   primary_key
    channel_id  = Mapped[int]   ForeignKey("channels.id", ondelete="CASCADE")  # NEW
    asset_type  = Mapped[str]   # unchanged
    name        = Mapped[str]   # unchanged
    created_at  = ...
    updated_at  = ...

    __table_args__ = (
        UniqueConstraint("channel_id", "asset_type", "name",
                         name="uq_folder_channel_type_name"),
    )
```

Invariants enforced server-side:

- Folder create requires `channel_id`. POST `/api/assets/folders`
  body becomes `{channel_id, asset_type, name}`.
- Move-to-folder requires `asset.channel_id == folder.channel_id`.
- Reassigning an asset to a different channel **strips its folder_id**
  (the old folder belongs to the old channel; preserving it would
  break the invariant).

### Sidebar — new layout

```
[All Assets · 240]
[Search……………………………………]                    [Upload] [Merge] [YT]

📺 YomiBeats · 148                              [+ Folder]
   🎵 Music · 73
      📁 CHILLRAP · 1
      📁 (Unfoldered · 72)
   🖼 Images · 15
      📁 (Unfoldered · 15)
   🎬 Videos · 1
   🎞 Composed · 59

📺 ZenTaoSounds · 92                            [+ Folder]
   🎵 Music · 59
      📁 Asian Instrumental · 59
   🖼 Images · 11
   🎞 Composed · 22

⚠ Orphan files · 3                              [Clean up]
```

Behaviour:

- Click a channel header → grid shows that channel's assets, all
  types mixed (channel-wide overview).
- Click a category (Music) → grid shows that channel + that type,
  including assets in folders.
- Click a folder → grid filtered to that folder.
- Click an "Unfoldered" pseudo-folder → assets in that
  (channel, type) with `folder_id IS NULL`.
- Click "All Assets" → 240 cards; back to the cross-channel view
  (rare, but useful for bulk-reassign).
- Right-click a category → "New folder" (creates with that
  category's `(channel_id, asset_type)`).
- Right-click a folder → Rename / Delete.

The "Channel" select we just added at the top of the sidebar
becomes redundant and gets removed — picking a channel is now a
click on the channel header.

### Orphan section

A new "Orphan files" entry appears IFF there are any files on disk
without a backing `Asset` row. Walks `data/assets/{N}/{type}/...`
and lists files whose name+channel pair doesn't match any DB row.

Two actions, both confirmation-gated:

- **Clean up** — deletes the files on disk. No DB write needed.
- **Adopt to channel ___** — for each file, creates an `Asset` row
  in the chosen channel and folder. Useful when the user has been
  dragging files into `data/assets/2/music/` directly and wants the
  app to pick them up.

(The reverse direction — DB rows pointing at missing files — is
already handled by `POST /api/assets/reconcile`.)

---

## Migration

```sql
-- 1. Add the column. Default NULL during migration window.
ALTER TABLE asset_folders ADD COLUMN channel_id INTEGER
    REFERENCES channels(id) ON DELETE CASCADE;

-- 2. Set channel_id from majority-of-assets-in-folder.
--    Multi-channel folders don't exist today, so this is exact.
UPDATE asset_folders
SET channel_id = (
    SELECT a.channel_id
    FROM assets a
    WHERE a.folder_id = asset_folders.id
    GROUP BY a.channel_id
    ORDER BY COUNT(*) DESC
    LIMIT 1
);

-- 3. Drop folders that are still NULL (= empty pre-migration).
--    Audit confirms: 4 folders affected, all unused.
DELETE FROM asset_folders WHERE channel_id IS NULL;

-- 4. Make the column NOT NULL + add the unique constraint.
--    SQLite needs a table rebuild for NOT NULL — done in init_db()
--    via the existing "rebuild table with new schema" pattern that
--    runs on startup (idempotent).

-- 5. Strip folder_id from any asset whose folder is on a different
--    channel — current data has zero such assets, so this is a no-op
--    today, but the migration ships the SQL anyway as a safety net.
UPDATE assets SET folder_id = NULL
WHERE folder_id IS NOT NULL
  AND channel_id != (
    SELECT channel_id FROM asset_folders
    WHERE asset_folders.id = assets.folder_id
  );
```

This runs idempotently in `init_db()` on startup. Re-running it is
safe (no-op once migrated).

**Risk**: dropping the 4 empty folders is destructive. The audit
shows zero assets reference them, but a paranoid alternative is to
move them all to channel 1 (oldest channel) so the user can decide.
Recommendation: **drop them**. They've been empty for the entire
project lifetime.

---

## Implementation phases

| Phase | What                                                    | Time   |
|-------|---------------------------------------------------------|--------|
| 1     | Backend: schema, migration, endpoints, validation       | 1 day  |
| 2     | Frontend: channel-first sidebar, NavSelection rework    | 1 day  |
| 3     | Folder dialogs: New / Rename / Move take channel scope  | 0.5 day|
| 4     | Orphan-files section + "Clean up" + "Adopt"             | 0.5 day|
|       | **Total**                                                | **3d** |

Phases 1+2 are the load-bearing work; 3 is polish; 4 is optional
(can ship without it and add later if disk-orphans show up in
practice).

### Phase 1 details

- `app/models/asset.py`: add `channel_id` column to `AssetFolder` +
  `UniqueConstraint("channel_id", "asset_type", "name")`.
- `app/database.py::init_db()`: idempotent migration block (the SQL
  above) + table rebuild for NOT NULL.
- `app/api/assets.py`:
  - `GET /folders` accepts `channel_id` filter.
  - `POST /folders` requires `channel_id` in body.
  - `PUT /move` validates `asset.channel_id == folder.channel_id`,
    400s otherwise.
  - `PUT /reassign-channel` strips `folder_id` server-side after the
    channel change.
- `app/services/automation_service/_shared.py`: nothing changes —
  the random-image / track-selection paths already filter by
  channel before they consider folders.
- Tests:
  - `test_asset_folders_per_channel.py`: create folder requires channel,
    move enforces match, reassign-channel strips folder_id.
  - Migration: stand up a DB with the pre-state, run init_db,
    assert post-state.

### Phase 2 details

- `frontend/src/pages/library/categories.tsx`: `NavSelection` becomes:
  ```ts
  type NavSelection =
    | { kind: "all" }
    | { kind: "channel"; channelId: number }
    | { kind: "category"; channelId: number; categoryKey: string }
    | { kind: "folder"; channelId: number; categoryKey: string;
        folderId: number; folderName: string }
    | { kind: "orphans" };
  ```
- `Sidebar.tsx`: rebuild as a channel-first tree. Drop the standalone
  "Channel" select at the top — channel headers are the picker now.
  Each channel header gets a "+ Folder" button (opens NewFolderDialog
  with `channel_id` pre-filled).
- `AssetsPage.tsx` (shell): the asset query passes `channel_id` based
  on `nav` (any kind except `all` carries it).
- URL state: `?channel_id=N&category=music&folder_id=K` — bookmark-
  friendly.

### Phase 3 details

- `NewFolderDialog`: receives `channelId` + `assetTypeLabel`, posts to
  `/api/assets/folders` with both.
- `MoveToFolderDialog`: receives the selected asset(s), only shows
  folders matching their channel + asset_type. Disabled when the
  selection spans multiple channels (with a clear "select assets from
  one channel" message).
- `AssetCard` right-click → "Move to folder" pre-filters folders.

### Phase 4 details

- New endpoint `GET /api/assets/orphan-files` walks `data/assets/`,
  cross-checks against the `assets` table, returns
  `[{path, channel_id, asset_type, size}]`.
- `POST /api/assets/orphan-files/clean` deletes them.
- `POST /api/assets/orphan-files/adopt` body
  `{paths: [...], channel_id, folder_id?}` creates `Asset` rows.
- Sidebar shows "⚠ Orphan files · N" only when N > 0.

---

## Open questions (answered, but flagged for visibility)

**Q: What about same-name folders in different categories of the
same channel?** (Music/Lofi vs Images/Lofi)
A: Allowed. Uniqueness is `(channel_id, asset_type, name)`.

**Q: What if a folder ends up empty after Phase 1 migration?**
A: Drop it (Phase 1 step 3). Current audit shows 4 empty folders
that never served a purpose.

**Q: Should an asset still be allowed to have `folder_id IS NULL`?**
A: Yes. "Unfoldered" is the default — most current assets are
unfoldered (180 of 240). The sidebar surfaces them under an
"(Unfoldered · N)" pseudo-folder.

**Q: What about the existing "Channel" picker we just shipped at the
top of the sidebar?**
A: It gets removed in Phase 2. Channel headers in the new tree are
the picker.

**Q: Cross-channel reassign — preserve or strip folder?**
A: Strip. The folder belongs to the old channel; preserving is an
invariant violation.

---

## Future: filesystem-mode (separate proposal)

The user mentioned wanting to point the library at a Windows folder
(`D:\.01 IMAGES`) instead of uploading. That's a bigger change with
its own trade-offs (per-asset metrics need stable IDs, watching the
filesystem for changes is non-trivial, etc.). The Music step
already supports a folder-mode for audio (`/api/music/scan-folder`)
— extending the same pattern to images is feasible but should be a
follow-up after this redesign lands.

---

## Recommendation

Ship Phases 1+2 first (2 days). They produce a usable, channel-first
library that makes "what does auto-generate pick from for ZenTao"
trivial to answer ("click ZenTao header → see its 92 assets").

Phase 3 is bundled because the dialog UX is broken without it
(NewFolderDialog can't create a folder with no channel anymore).

Phase 4 only matters if disk-orphans actually exist in practice;
audit shows zero today. Defer until they show up.

Total commitment: 2.5 days for a clean, channel-first Library.
