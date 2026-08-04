/**
 * Category + navigation shapes shared between the Library shell and its
 * sidebar/grid children.
 *
 * The Library is channel-first: the primary navigation axis is the
 * channel, with asset_type categories nested inside, and folders
 * nested inside those. Folders belong to a single (channel_id,
 * asset_type) — see ``docs/library-redesign.md`` and the
 * AssetFolder model.
 */
import type { ReactNode } from "react";
import { Music, FileImage, Film } from "lucide-react";

export interface SidebarCategory {
  key: string;
  label: string;
  icon: ReactNode;
  /** asset_type values that belong to this category */
  types: string[];
}

export const CATEGORIES: SidebarCategory[] = [
  {
    key: "music",
    label: "Music",
    icon: <Music className="size-4 text-blue-400" />,
    types: ["music"],
  },
  {
    key: "image",
    label: "Images",
    icon: <FileImage className="size-4 text-green-400" />,
    types: ["image", "thumbnail"],
  },
  {
    key: "video",
    label: "Videos",
    icon: <Film className="size-4 text-cyan-400" />,
    types: ["video"],
  },
  {
    key: "composed",
    label: "Composed",
    icon: <Film className="size-4 text-purple-400" />,
    types: ["composed"],
  },
];

/**
 * Library navigation state.
 *
 * - ``all``       — cross-channel view, all asset_types. The top
 *                   "All Assets" entry. Useful for bulk-reassign.
 * - ``channel``   — one channel, all asset_types. The default
 *                   landing for a single channel's library.
 * - ``category``  — one channel + one asset_type (Music / Images / …).
 *                   Includes assets in folders + unfoldered.
 * - ``folder``    — one channel + one asset_type + one folder.
 *                   Folders are scoped to (channel, asset_type).
 *
 * The shell derives ``channel_id``, ``asset_type``, and ``folder_id``
 * query params for ``useAssets`` from this single source of truth.
 */
export type NavSelection =
  | { kind: "all" }
  | { kind: "channel"; channelId: number }
  | { kind: "category"; channelId: number; categoryKey: string }
  | {
      kind: "folder";
      channelId: number;
      categoryKey: string;
      folderId: number;
      folderName: string;
    };
