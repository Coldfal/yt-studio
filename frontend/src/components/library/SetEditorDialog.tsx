/**
 * SetEditorDialog — create or edit an AssetSet.
 *
 * Phase 5 of farm redesign. Three slots (background / thumbnail /
 * optional overlay). Each slot opens a channel-scoped asset picker
 * that filters by the appropriate role (background → role=background
 * images; thumbnail → role=thumbnail images; overlay → role=overlay).
 */
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Image as ImageIcon, Loader2, Save, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  useAssetSets as _unused,
  useCreateAssetSet,
  useUpdateAssetSet,
  type AssetSet,
} from "@/hooks/use-asset-sets";
import { useAssets } from "@/hooks/use-assets";
import type { Channel } from "@/types/index";

void _unused;

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
  /** When set, the dialog opens in EDIT mode for that set. */
  existing?: AssetSet | null;
}

export function SetEditorDialog({
  open,
  onOpenChange,
  channel,
  existing,
}: Props) {
  const isEdit = !!existing;
  const create = useCreateAssetSet();
  const update = useUpdateAssetSet();

  const [name, setName] = useState("");
  const [bgId, setBgId] = useState<number | null>(null);
  const [thumbId, setThumbId] = useState<number | null>(null);
  const [overlayId, setOverlayId] = useState<number | null>(null);
  const [isActive, setIsActive] = useState(true);

  // Reset state when dialog opens for a new vs existing set
  useEffect(() => {
    if (!open) return;
    if (existing) {
      setName(existing.name);
      setBgId(existing.background_asset_id);
      setThumbId(existing.thumbnail_asset_id);
      setOverlayId(existing.overlay_asset_id);
      setIsActive(existing.is_active);
    } else {
      setName("");
      setBgId(null);
      setThumbId(null);
      setOverlayId(null);
      setIsActive(true);
    }
  }, [open, existing]);

  // Fetch the channel's images once; filter client-side by role since
  // we need three subsets in the same dialog.
  const { data: images } = useAssets({
    channel_id: String(channel.id),
    asset_type: "image",
  });
  const backgrounds = (images ?? []).filter(
    (a) => (a.role ?? "background") === "background",
  );
  const thumbnails = (images ?? []).filter((a) => a.role === "thumbnail");
  const overlays = (images ?? []).filter((a) => a.role === "overlay");

  const canSave =
    name.trim().length > 0 && bgId != null && thumbId != null;
  const pending = create.isPending || update.isPending;

  const handleSave = async () => {
    if (!canSave || bgId == null || thumbId == null) return;
    try {
      if (existing) {
        await update.mutateAsync({
          id: existing.id,
          patch: {
            name: name.trim(),
            background_asset_id: bgId,
            thumbnail_asset_id: thumbId,
            overlay_asset_id: overlayId,
            is_active: isActive,
          },
        });
        toast.success("Set updated");
      } else {
        await create.mutateAsync({
          channel_id: channel.id,
          name: name.trim(),
          background_asset_id: bgId,
          thumbnail_asset_id: thumbId,
          overlay_asset_id: overlayId,
          is_active: isActive,
        });
        toast.success("Set created");
      }
      onOpenChange(false);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Save failed");
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[920px] max-h-[88vh] gap-0 p-0 overflow-hidden">
        <DialogHeader className="border-b p-4">
          <DialogTitle>
            {isEdit ? "Edit Set" : "Create new Set"} · {channel.name}
          </DialogTitle>
          <DialogDescription>
            A Set is a curated background + thumbnail (+ optional
            overlay). Quick Generate picks a random active set when{" "}
            <code className="rounded bg-muted px-1">use_asset_sets</code>{" "}
            is on for this channel.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 overflow-auto p-4 max-h-[68vh]">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-[1fr_auto]">
            <div className="space-y-1.5">
              <Label htmlFor="set-name" className="text-xs">Name</Label>
              <Input
                id="set-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. tokyo-night-01, fantasy-tavern-2am"
                className="h-8"
              />
            </div>
            <div className="flex items-end gap-2">
              <Label className="text-xs flex items-center gap-2">
                Active
                <Switch
                  checked={isActive}
                  onCheckedChange={setIsActive}
                />
              </Label>
            </div>
          </div>

          <SlotPicker
            label="Background (required)"
            assets={backgrounds}
            selectedId={bgId}
            onSelect={setBgId}
            emptyHint="No images tagged 'background' for this channel."
          />

          <SlotPicker
            label="Thumbnail (required)"
            assets={thumbnails}
            selectedId={thumbId}
            onSelect={setThumbId}
            emptyHint="No images tagged 'thumbnail'. Tag from the Library Assets tab."
          />

          <SlotPicker
            label="Overlay (optional)"
            assets={overlays}
            selectedId={overlayId}
            onSelect={setOverlayId}
            allowClear
            emptyHint="No images tagged 'overlay'."
          />
        </div>

        <DialogFooter className="border-t bg-muted/40 p-3">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            disabled={pending}
          >
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={!canSave || pending}>
            {pending ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving…
              </>
            ) : (
              <>
                <Save className="size-4" />
                {isEdit ? "Update Set" : "Create Set"}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface SlotPickerProps {
  label: string;
  assets: { id: number; filename: string; file_url: string; title?: string | null }[];
  selectedId: number | null;
  onSelect: (id: number | null) => void;
  emptyHint: string;
  allowClear?: boolean;
}

function SlotPicker({
  label,
  assets,
  selectedId,
  onSelect,
  emptyHint,
  allowClear,
}: SlotPickerProps) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between">
        <Label className="text-xs">{label}</Label>
        {allowClear && selectedId != null && (
          <button
            type="button"
            onClick={() => onSelect(null)}
            className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
            Clear
          </button>
        )}
      </div>
      {assets.length === 0 ? (
        <p className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-3 text-center text-[11px] text-muted-foreground">
          <ImageIcon className="mx-auto mb-1 size-5 opacity-30" />
          {emptyHint}
        </p>
      ) : (
        <div className="grid max-h-44 grid-cols-3 gap-2 overflow-y-auto rounded-md border border-border/40 bg-muted/10 p-2 sm:grid-cols-5">
          {assets.map((a) => {
            const isSel = a.id === selectedId;
            return (
              <button
                key={a.id}
                type="button"
                onClick={() => onSelect(a.id)}
                className={`group/tile relative aspect-video overflow-hidden rounded border transition ${
                  isSel
                    ? "border-primary ring-2 ring-primary/40"
                    : "border-border/40 hover:border-primary/50"
                }`}
                title={a.title || a.filename}
              >
                <img
                  src={a.file_url}
                  alt={a.title || a.filename}
                  className="h-full w-full object-cover"
                />
                <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/70 to-transparent px-1 pb-0.5 pt-2">
                  <p className="truncate text-[9px] text-white">
                    {a.title || a.filename}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
