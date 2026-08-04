/**
 * Merge multiple audio assets into a single concatenated MP3 (Phase 2
 * extract from ``AssetsPage.tsx``).
 *
 * Self-contained: takes ``open``, ``onOpenChange``, the channel list,
 * and the audio asset list as props. All selection / ordering / merge
 * state lives inside the dialog. Channel for the merged output is
 * inferred from the first selected track — that's why only same-channel
 * tracks can be combined (no cross-channel mixes).
 */
import { useState } from "react";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Merge,
  Music,
  X,
} from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useMergeAudio } from "@/hooks/use-assets";
import { formatDuration } from "@/lib/format";
import type { Asset } from "@/types/index";

interface MergeAudioDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channels: { id: number; name: string }[];
  audioAssets: Asset[];
}

export function MergeAudioDialog({
  open,
  onOpenChange,
  channels,
  audioAssets,
}: MergeAudioDialogProps) {
  const [selected, setSelected] = useState<Asset[]>([]);
  const [title, setTitle] = useState("");
  const mergeAudio = useMergeAudio();

  const handleClose = (nextOpen: boolean) => {
    if (!nextOpen) {
      setSelected([]);
      setTitle("");
      mergeAudio.reset();
    }
    onOpenChange(nextOpen);
  };

  const toggleAsset = (asset: Asset) => {
    setSelected((prev) => {
      const exists = prev.find((a) => a.id === asset.id);
      if (exists) return prev.filter((a) => a.id !== asset.id);
      return [...prev, asset];
    });
  };

  const moveUp = (index: number) => {
    if (index === 0) return;
    setSelected((prev) => {
      const next = [...prev];
      [next[index - 1], next[index]] = [next[index], next[index - 1]];
      return next;
    });
  };

  const moveDown = (index: number) => {
    setSelected((prev) => {
      if (index >= prev.length - 1) return prev;
      const next = [...prev];
      [next[index], next[index + 1]] = [next[index + 1], next[index]];
      return next;
    });
  };

  const removeFromList = (index: number) => {
    setSelected((prev) => prev.filter((_, i) => i !== index));
  };

  const totalDuration = selected.reduce((sum, a) => sum + (a.duration_seconds ?? 0), 0);
  const channelId = selected.length > 0 ? selected[0].channel_id : null;

  const handleMerge = async () => {
    if (selected.length < 2 || !channelId) return;
    try {
      await mergeAudio.mutateAsync({
        asset_ids: selected.map((a) => a.id),
        channel_id: channelId,
        title: title.trim() || undefined,
      });
      toast.success("Audio tracks merged successfully!");
    } catch {
      toast.error("Failed to merge audio tracks");
    }
  };

  const assetsByChannel = audioAssets.reduce<Record<number, Asset[]>>((acc, a) => {
    if (!acc[a.channel_id]) acc[a.channel_id] = [];
    acc[a.channel_id].push(a);
    return acc;
  }, {});

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Merge className="size-5 text-purple-400" />
            Merge Audio Tracks
          </DialogTitle>
          <DialogDescription>
            Select audio tracks and arrange their order. They'll be concatenated into a
            single MP3.
          </DialogDescription>
        </DialogHeader>

        {mergeAudio.isSuccess ? (
          <div className="space-y-4">
            <div className="flex items-center gap-2 rounded-md border border-green-800 bg-green-950/40 p-3 text-sm text-green-400">
              <Music className="size-4" />
              Tracks merged! New file saved to your library.
            </div>
            <DialogFooter>
              <Button onClick={() => handleClose(false)}>Done</Button>
            </DialogFooter>
          </div>
        ) : (
          <>
            {selected.length > 0 && (
              <div className="space-y-2">
                <Label className="text-xs text-muted-foreground">
                  Track Order ({selected.length} tracks, {formatDuration(totalDuration)}{" "}
                  total)
                </Label>
                <div className="max-h-48 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                  {selected.map((asset, idx) => (
                    <div
                      key={asset.id}
                      className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1.5 text-sm"
                    >
                      <span className="w-5 shrink-0 text-center text-xs text-muted-foreground">
                        {idx + 1}
                      </span>
                      <Music className="size-3 shrink-0 text-purple-400" />
                      <span className="min-w-0 flex-1 truncate">
                        {asset.title || asset.filename}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatDuration(asset.duration_seconds ?? 0)}
                      </span>
                      <div className="flex shrink-0 gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => moveUp(idx)}
                          disabled={idx === 0}
                        >
                          <ChevronUp className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => moveDown(idx)}
                          disabled={idx === selected.length - 1}
                        >
                          <ChevronDown className="size-3" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => removeFromList(idx)}
                        >
                          <X className="size-3 text-destructive" />
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="merge-title">Title (optional)</Label>
              <Input
                id="merge-title"
                placeholder="e.g. Lofi Mix Vol. 1"
                value={title}
                onChange={(e) => setTitle(e.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label className="text-xs text-muted-foreground">
                Click tracks to add them
              </Label>
              <div className="max-h-52 space-y-1 overflow-y-auto rounded-md border border-border p-2">
                {audioAssets.length === 0 && (
                  <p className="py-4 text-center text-sm text-muted-foreground">
                    No audio assets available. Upload some tracks first.
                  </p>
                )}
                {Object.entries(assetsByChannel).map(([chId, assets]) => (
                  <div key={chId}>
                    <p className="mb-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                      {channels.find((c) => c.id === Number(chId))?.name ??
                        `Channel ${chId}`}
                    </p>
                    {assets.map((asset) => {
                      const isSelected = selected.some((s) => s.id === asset.id);
                      return (
                        <div
                          key={asset.id}
                          className={`flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm transition-colors ${
                            isSelected
                              ? "bg-purple-500/20 text-purple-300"
                              : "hover:bg-muted/50"
                          }`}
                          onClick={() => toggleAsset(asset)}
                        >
                          <Music className="size-3 shrink-0" />
                          <span className="min-w-0 flex-1 truncate">
                            {asset.title || asset.filename}
                          </span>
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {formatDuration(asset.duration_seconds ?? 0)}
                          </span>
                          {isSelected && (
                            <Badge variant="outline" className="text-[10px]">
                              #{selected.findIndex((s) => s.id === asset.id) + 1}
                            </Badge>
                          )}
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>
            </div>

            <DialogFooter>
              <Button variant="outline" onClick={() => handleClose(false)}>
                Cancel
              </Button>
              <Button
                onClick={handleMerge}
                disabled={selected.length < 2 || mergeAudio.isPending}
              >
                {mergeAudio.isPending ? (
                  <>
                    <Loader2 className="size-4 animate-spin" />
                    Merging...
                  </>
                ) : (
                  <>
                    <Merge className="size-4" />
                    Merge {selected.length} Tracks
                  </>
                )}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
