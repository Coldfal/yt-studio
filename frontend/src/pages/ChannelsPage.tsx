import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Plus,
  MoreHorizontal,
  Pencil,
  Trash2,
  Video,
  Tv,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  useChannels,
  useCreateChannel,
  useUpdateChannel,
  useDeleteChannel,
} from "@/hooks/use-channels";
import { NICHE_OPTIONS } from "@/types/index";
import type { Channel } from "@/types/index";

function ChannelFormDialog({
  open,
  onOpenChange,
  channel,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel?: Channel;
}) {
  const [name, setName] = useState(channel?.name ?? "");
  const [niche, setNiche] = useState(channel?.niche ?? "");
  const [description, setDescription] = useState(channel?.description ?? "");
  const [defaultPromptPrefix, setDefaultPromptPrefix] = useState(
    channel?.default_prompt_prefix ?? ""
  );

  const createChannel = useCreateChannel();
  const updateChannel = useUpdateChannel();
  const isEditing = !!channel;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !niche) {
      toast.error("Name and niche are required");
      return;
    }

    try {
      if (isEditing) {
        await updateChannel.mutateAsync({
          id: channel.id,
          name: name.trim(),
          niche,
          description: description.trim() || null,
          default_prompt_prefix: defaultPromptPrefix.trim() || null,
        });
        toast.success("Channel updated");
      } else {
        await createChannel.mutateAsync({
          name: name.trim(),
          niche,
          description: description.trim() || null,
          default_prompt_prefix: defaultPromptPrefix.trim() || null,
        });
        toast.success("Channel created");
      }
      onOpenChange(false);
      setName("");
      setNiche("");
      setDescription("");
      setDefaultPromptPrefix("");
    } catch {
      toast.error(
        isEditing ? "Failed to update channel" : "Failed to create channel"
      );
    }
  };

  const isPending = createChannel.isPending || updateChannel.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>
              {isEditing ? "Edit Channel" : "New Channel"}
            </DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update your channel details."
                : "Create a new YouTube automation channel."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label htmlFor="channel-name">Channel Name</Label>
              <Input
                id="channel-name"
                placeholder="My Lofi Channel"
                value={name}
                onChange={(e) => setName(e.target.value)}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Niche</Label>
              <Select value={niche} onValueChange={setNiche}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select a niche" />
                </SelectTrigger>
                <SelectContent>
                  {NICHE_OPTIONS.map((opt) => (
                    <SelectItem key={opt.value} value={opt.value}>
                      {opt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-desc">Description</Label>
              <Textarea
                id="channel-desc"
                placeholder="Channel description..."
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="channel-prompt">Default Prompt Prefix</Label>
              <Textarea
                id="channel-prompt"
                placeholder="Prefix for all AI prompts on this channel..."
                value={defaultPromptPrefix}
                onChange={(e) => setDefaultPromptPrefix(e.target.value)}
                rows={2}
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="submit" disabled={isPending}>
              {isPending
                ? isEditing
                  ? "Saving..."
                  : "Creating..."
                : isEditing
                  ? "Save Changes"
                  : "Create Channel"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ChannelCardItem({ channel }: { channel: Channel }) {
  const navigate = useNavigate();
  const deleteChannel = useDeleteChannel();
  const [editOpen, setEditOpen] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(false);

  const nicheLabel =
    NICHE_OPTIONS.find((n) => n.value === channel.niche)?.label ??
    channel.niche;

  const handleDelete = async () => {
    try {
      await deleteChannel.mutateAsync(channel.id);
      toast.success("Channel deleted");
    } catch {
      toast.error("Failed to delete channel");
    }
    setDeleteConfirm(false);
  };

  return (
    <>
      <Card className="transition-colors hover:bg-accent/50">
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div
              className="min-w-0 flex-1 cursor-pointer"
              onClick={() => navigate(`/channels/${channel.id}`)}
            >
              <CardTitle className="truncate">{channel.name}</CardTitle>
            </div>
            <div className="flex items-center gap-2">
              <Badge variant="secondary">{nicheLabel}</Badge>
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<Button variant="ghost" size="icon-sm" />}
                >
                  <MoreHorizontal className="size-4" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setEditOpen(true)}>
                    <Pencil className="size-4" />
                    Edit
                  </DropdownMenuItem>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    variant="destructive"
                    onClick={() => setDeleteConfirm(true)}
                  >
                    <Trash2 className="size-4" />
                    Delete
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </div>
        </CardHeader>
        <CardContent
          className="cursor-pointer"
          onClick={() => navigate(`/channels/${channel.id}`)}
        >
          {channel.description && (
            <p className="mb-3 line-clamp-2 text-sm text-muted-foreground">
              {channel.description}
            </p>
          )}
          <div className="flex items-center gap-4 text-sm text-muted-foreground">
            <div className="flex items-center gap-1.5">
              <Video className="size-3.5" />
              <span
                className={
                  channel.youtube_connected
                    ? "text-green-500"
                    : "text-red-400"
                }
              >
                {channel.youtube_connected ? "Connected" : "Not connected"}
              </span>
            </div>
            <div className="flex items-center gap-1.5">
              <Video className="size-3.5" />
              <span>
                {channel.default_video_width}x{channel.default_video_height}
              </span>
            </div>
          </div>
        </CardContent>
      </Card>

      <ChannelFormDialog
        open={editOpen}
        onOpenChange={setEditOpen}
        channel={channel}
      />

      <Dialog open={deleteConfirm} onOpenChange={setDeleteConfirm}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete Channel</DialogTitle>
            <DialogDescription>
              Are you sure you want to delete &quot;{channel.name}&quot;? This
              action cannot be undone and will remove all associated projects and
              assets.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setDeleteConfirm(false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleDelete}
              disabled={deleteChannel.isPending}
            >
              {deleteChannel.isPending ? "Deleting..." : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

function LoadingSkeleton() {
  return (
    <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      {Array.from({ length: 6 }).map((_, i) => (
        <Card key={i}>
          <CardHeader>
            <div className="h-5 w-32 animate-pulse rounded bg-muted" />
          </CardHeader>
          <CardContent>
            <div className="space-y-2">
              <div className="h-4 w-48 animate-pulse rounded bg-muted" />
              <div className="h-4 w-36 animate-pulse rounded bg-muted" />
            </div>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

export default function ChannelsPage() {
  const { data: channels, isLoading, error } = useChannels();
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Channels</h1>
        <Button onClick={() => setCreateOpen(true)}>
          <Plus className="size-4" />
          New Channel
        </Button>
      </div>

      {isLoading && <LoadingSkeleton />}

      {error && (
        <Card>
          <CardContent className="py-8 text-center">
            <p className="text-sm text-destructive">
              Failed to load channels. Please try again.
            </p>
          </CardContent>
        </Card>
      )}

      {!isLoading && !error && channels?.length === 0 && (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <Tv className="mb-4 size-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-medium">No channels yet</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              Get started by creating your first channel.
            </p>
            <Button onClick={() => setCreateOpen(true)}>
              <Plus className="size-4" />
              Create Channel
            </Button>
          </CardContent>
        </Card>
      )}

      {!isLoading && channels && channels.length > 0 && (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {channels.map((channel) => (
            <ChannelCardItem key={channel.id} channel={channel} />
          ))}
        </div>
      )}

      <ChannelFormDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}
