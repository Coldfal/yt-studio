/**
 * Sets tab — Phase 5 of farm redesign.
 *
 * Lists every AssetSet across channels (or scoped to a channel via
 * dropdown). Each set is a card with the bg + thumbnail thumbnails,
 * an Active toggle, Edit, and Delete actions. A 'Create Set' button
 * opens the SetEditorDialog.
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  Image as ImageIcon,
  Layers,
  Loader2,
  Pencil,
  Plus,
  Power,
  Trash2,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useAssetSets,
  useDeleteAssetSet,
  useToggleAssetSetActive,
  type AssetSet,
} from "@/hooks/use-asset-sets";
import { useChannels } from "@/hooks/use-channels";
import { SetEditorDialog } from "./SetEditorDialog";

export function SetsTab() {
  const { data: channels } = useChannels();
  const [channelId, setChannelId] = useState<number | "all">("all");
  const { data: sets, isLoading } = useAssetSets(
    channelId === "all" ? undefined : channelId,
  );
  const toggle = useToggleAssetSetActive();
  const del = useDeleteAssetSet();

  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<AssetSet | null>(null);

  // Edit dialog requires a channel context, so when "all" is selected
  // the Create button is disabled and editing a row pre-selects the
  // row's channel.
  const dialogChannel = channels?.find((c) =>
    editing ? c.id === editing.channel_id : c.id === channelId,
  );

  const openCreate = () => {
    setEditing(null);
    setDialogOpen(true);
  };

  const openEdit = (s: AssetSet) => {
    setEditing(s);
    setDialogOpen(true);
  };

  const handleDelete = async (s: AssetSet) => {
    if (
      !window.confirm(
        `Delete Set "${s.name}"? Quick Generate will skip it on the next pick.`,
      )
    ) {
      return;
    }
    try {
      await del.mutateAsync(s.id);
      toast.success("Set deleted");
    } catch {
      toast.error("Delete failed");
    }
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Layers className="size-4 text-primary" />
              Asset Sets
            </CardTitle>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              Curated bg + thumbnail pairings. Quick Generate picks
              one at random when a channel's "Use asset sets" toggle
              is on.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Label className="text-xs">Channel</Label>
            <Select
              value={channelId === "all" ? "all" : String(channelId)}
              onValueChange={(v) =>
                setChannelId(v === "all" ? "all" : Number(v))
              }
            >
              <SelectTrigger className="h-8 w-44 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All channels</SelectItem>
                {(channels ?? []).map((c) => (
                  <SelectItem key={c.id} value={String(c.id)}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              size="sm"
              onClick={openCreate}
              disabled={channelId === "all"}
              title={
                channelId === "all"
                  ? "Pick a channel first"
                  : "Create a new Set on this channel"
              }
            >
              <Plus className="size-3.5" />
              New Set
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {isLoading && (
            <div className="flex justify-center py-8">
              <Loader2 className="size-5 animate-spin text-muted-foreground" />
            </div>
          )}

          {!isLoading && (sets?.length ?? 0) === 0 && (
            <div className="rounded-md border border-dashed border-border bg-muted/20 px-3 py-10 text-center text-xs text-muted-foreground">
              <Layers className="mx-auto mb-2 size-6 opacity-30" />
              <p className="font-medium">No Sets yet</p>
              <p className="mt-1 text-[11px]">
                {channelId === "all"
                  ? "Pick a channel and click New Set to pair a background with a thumbnail."
                  : "Click New Set to pair a background image with a thumbnail."}
              </p>
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {(sets ?? []).map((s) => {
              const channelName =
                channels?.find((c) => c.id === s.channel_id)?.name ??
                `Channel ${s.channel_id}`;
              return (
                <div
                  key={s.id}
                  className={`rounded-md border p-2 transition ${
                    s.is_active
                      ? "border-border bg-muted/10"
                      : "border-border/40 bg-muted/5 opacity-60"
                  }`}
                >
                  <div className="grid grid-cols-2 gap-2">
                    <SlotPreview
                      label="Background"
                      file_url={s.background_file_url}
                    />
                    <SlotPreview
                      label="Thumbnail"
                      file_url={s.thumbnail_file_url}
                    />
                  </div>

                  <div className="mt-2 flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-sm font-medium">{s.name}</p>
                      <p className="truncate text-[10px] text-muted-foreground">
                        {channelName}
                      </p>
                      <div className="mt-1 flex items-center gap-1">
                        <Badge
                          variant={s.is_active ? "default" : "outline"}
                          className="text-[9px] py-0"
                        >
                          {s.is_active ? "Active" : "Inactive"}
                        </Badge>
                        {s.overlay_file_url && (
                          <Badge variant="outline" className="text-[9px] py-0">
                            +overlay
                          </Badge>
                        )}
                      </div>
                    </div>
                    <div className="flex gap-1">
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => toggle.mutate(s.id)}
                        title={s.is_active ? "Deactivate" : "Activate"}
                      >
                        <Power className="size-3" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => openEdit(s)}
                        title="Edit"
                      >
                        <Pencil className="size-3" />
                      </Button>
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        onClick={() => handleDelete(s)}
                        title="Delete"
                      >
                        <Trash2 className="size-3" />
                      </Button>
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </CardContent>
      </Card>

      {dialogChannel && (
        <SetEditorDialog
          open={dialogOpen}
          onOpenChange={setDialogOpen}
          channel={dialogChannel}
          existing={editing}
        />
      )}
    </div>
  );
}

function SlotPreview({ label, file_url }: { label: string; file_url: string | null }) {
  return (
    <div className="space-y-1">
      <p className="text-[9px] uppercase tracking-wider text-muted-foreground">
        {label}
      </p>
      <div
        className="overflow-hidden rounded bg-muted ring-1 ring-border"
        style={{ aspectRatio: "16/9" }}
      >
        {file_url ? (
          <img
            src={file_url}
            alt={label}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center">
            <ImageIcon className="size-5 text-muted-foreground/30" />
          </div>
        )}
      </div>
    </div>
  );
}
