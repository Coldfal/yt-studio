import { useState, useMemo } from "react";
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
import { Plus, Star, BookOpen, Trash2, Pencil, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { useChannels } from "@/hooks/use-channels";
import {
  usePrompts,
  useCreatePrompt,
  useUpdatePrompt,
  useDeletePrompt,
  useToggleFavorite,
} from "@/hooks/use-prompts";
import type { Prompt, Channel } from "@/types/index";
import { PROMPT_TYPES } from "@/types/index";

function PromptFormDialog({
  open,
  onOpenChange,
  prompt,
  channels,
  defaultChannelId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: Prompt | null;
  channels: Channel[];
  defaultChannelId?: number;
}) {
  const [channelId, setChannelId] = useState<string>(
    prompt ? String(prompt.channel_id) : defaultChannelId ? String(defaultChannelId) : ""
  );
  const [promptType, setPromptType] = useState(prompt?.prompt_type ?? "");
  const [name, setName] = useState(prompt?.name ?? "");
  const [content, setContent] = useState(prompt?.content ?? "");

  const createPrompt = useCreatePrompt();
  const updatePrompt = useUpdatePrompt();
  const isEditing = !!prompt;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!channelId || !promptType || !name.trim() || !content.trim()) {
      toast.error("Please fill in all fields");
      return;
    }
    try {
      if (isEditing) {
        await updatePrompt.mutateAsync({
          id: prompt.id,
          channel_id: parseInt(channelId),
          prompt_type: promptType,
          name: name.trim(),
          content: content.trim(),
        });
        toast.success("Prompt updated");
      } else {
        await createPrompt.mutateAsync({
          channel_id: parseInt(channelId),
          prompt_type: promptType,
          name: name.trim(),
          content: content.trim(),
        });
        toast.success("Prompt created");
      }
      onOpenChange(false);
    } catch {
      toast.error(isEditing ? "Failed to update prompt" : "Failed to create prompt");
    }
  };

  const isPending = createPrompt.isPending || updatePrompt.isPending;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit}>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Prompt" : "New Prompt"}</DialogTitle>
            <DialogDescription>
              {isEditing
                ? "Update prompt details and content."
                : "Create a reusable prompt for your AI pipeline."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>Channel</Label>
              <Select value={channelId} onValueChange={setChannelId}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select channel" />
                </SelectTrigger>
                <SelectContent>
                  {channels.map((ch) => (
                    <SelectItem key={ch.id} value={String(ch.id)}>
                      {ch.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Prompt Type</Label>
              <Select value={promptType} onValueChange={setPromptType}>
                <SelectTrigger className="w-full">
                  <SelectValue placeholder="Select type" />
                </SelectTrigger>
                <SelectContent>
                  {PROMPT_TYPES.map((pt) => (
                    <SelectItem key={pt.value} value={pt.value}>
                      {pt.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt-name">Name</Label>
              <Input
                id="prompt-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Chill Lofi Beat Generator"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="prompt-content">Content</Label>
              <Textarea
                id="prompt-content"
                value={content}
                onChange={(e) => setContent(e.target.value)}
                placeholder="Write your prompt here..."
                rows={8}
                required
              />
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Saving...
                </>
              ) : isEditing ? (
                "Save Changes"
              ) : (
                "Create Prompt"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-9 w-32 animate-pulse rounded bg-muted" />
      </div>
      <div className="flex gap-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-9 w-36 animate-pulse rounded bg-muted" />
        ))}
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Card key={i}>
            <CardHeader>
              <div className="h-5 w-32 animate-pulse rounded bg-muted" />
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                <div className="h-4 w-full animate-pulse rounded bg-muted" />
                <div className="h-4 w-3/4 animate-pulse rounded bg-muted" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function PromptLibraryPage() {
  const [channelFilter, setChannelFilter] = useState<string>("");
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [favoritesOnly, setFavoritesOnly] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);

  const queryParams = useMemo(() => {
    const params: {
      channel_id?: number;
      prompt_type?: string;
      is_favorite?: boolean;
    } = {};
    if (channelFilter && channelFilter !== "all") params.channel_id = parseInt(channelFilter);
    if (typeFilter && typeFilter !== "all") params.prompt_type = typeFilter;
    if (favoritesOnly) params.is_favorite = true;
    return params;
  }, [channelFilter, typeFilter, favoritesOnly]);

  const { data: channels, isLoading: channelsLoading } = useChannels();
  const { data: prompts, isLoading: promptsLoading } = usePrompts(queryParams);
  const deletePrompt = useDeletePrompt();
  const toggleFavorite = useToggleFavorite();

  const channelMap = useMemo(() => {
    const map = new Map<number, Channel>();
    (channels ?? []).forEach((ch) => map.set(ch.id, ch));
    return map;
  }, [channels]);

  const isLoading = channelsLoading || promptsLoading;

  if (isLoading) {
    return (
      <div className="space-y-6">
        <h1 className="text-2xl font-bold">Prompt Library</h1>
        <LoadingSkeleton />
      </div>
    );
  }

  const promptList = prompts ?? [];
  const channelList = channels ?? [];

  const handleEdit = (prompt: Prompt) => {
    setEditingPrompt(prompt);
    setDialogOpen(true);
  };

  const handleNew = () => {
    setEditingPrompt(null);
    setDialogOpen(true);
  };

  const handleDelete = async (id: number) => {
    try {
      await deletePrompt.mutateAsync(id);
      toast.success("Prompt deleted");
    } catch {
      toast.error("Failed to delete prompt");
    }
  };

  const handleToggleFavorite = async (id: number) => {
    try {
      await toggleFavorite.mutateAsync(id);
    } catch {
      toast.error("Failed to update favorite");
    }
  };

  const getPromptTypeInfo = (type: string) =>
    PROMPT_TYPES.find((pt) => pt.value === type);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <BookOpen className="size-6 text-primary" />
          <h1 className="text-2xl font-bold">Prompt Library</h1>
        </div>
        <Button onClick={handleNew}>
          <Plus className="size-4" />
          New Prompt
        </Button>
      </div>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-3">
        <Select value={channelFilter} onValueChange={setChannelFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All Channels" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Channels</SelectItem>
            {channelList.map((ch) => (
              <SelectItem key={ch.id} value={String(ch.id)}>
                {ch.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select value={typeFilter} onValueChange={setTypeFilter}>
          <SelectTrigger className="w-44">
            <SelectValue placeholder="All Types" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Types</SelectItem>
            {PROMPT_TYPES.map((pt) => (
              <SelectItem key={pt.value} value={pt.value}>
                {pt.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Button
          variant={favoritesOnly ? "default" : "outline"}
          size="sm"
          onClick={() => setFavoritesOnly(!favoritesOnly)}
        >
          <Star
            className={`size-4 ${favoritesOnly ? "fill-current" : ""}`}
          />
          Favorites
        </Button>
      </div>

      {/* Prompt grid */}
      {promptList.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <BookOpen className="mb-4 size-12 text-muted-foreground" />
            <h3 className="mb-2 text-lg font-medium">No prompts found</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              {channelFilter || typeFilter || favoritesOnly
                ? "Try adjusting your filters or create a new prompt."
                : "Create your first prompt to get started."}
            </p>
            <Button onClick={handleNew}>
              <Plus className="size-4" />
              New Prompt
            </Button>
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {promptList.map((prompt) => {
            const channel = channelMap.get(prompt.channel_id);
            const typeInfo = getPromptTypeInfo(prompt.prompt_type);
            return (
              <Card
                key={prompt.id}
                className="group cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => handleEdit(prompt)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1">
                      <CardTitle className="truncate text-base">
                        {prompt.name}
                      </CardTitle>
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {channel?.name ?? "Unknown channel"}
                      </p>
                    </div>
                    <div className="flex shrink-0 items-center gap-1">
                      <button
                        className="rounded p-1 hover:bg-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleToggleFavorite(prompt.id);
                        }}
                      >
                        <Star
                          className={`size-4 ${
                            prompt.is_favorite
                              ? "fill-yellow-400 text-yellow-400"
                              : "text-muted-foreground"
                          }`}
                        />
                      </button>
                    </div>
                  </div>
                </CardHeader>
                <CardContent>
                  <div className="mb-3">
                    {typeInfo && (
                      <Badge className={`${typeInfo.color} text-white`}>
                        {typeInfo.label}
                      </Badge>
                    )}
                  </div>
                  <p className="mb-3 text-sm text-muted-foreground line-clamp-3">
                    {prompt.content.length > 150
                      ? prompt.content.slice(0, 150) + "..."
                      : prompt.content}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      Used {prompt.times_used} time
                      {prompt.times_used !== 1 ? "s" : ""}
                    </span>
                    <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                      <button
                        className="rounded p-1 hover:bg-accent"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleEdit(prompt);
                        }}
                      >
                        <Pencil className="size-3.5 text-muted-foreground" />
                      </button>
                      <button
                        className="rounded p-1 hover:bg-destructive/20"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete(prompt.id);
                        }}
                      >
                        <Trash2 className="size-3.5 text-destructive" />
                      </button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <PromptFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingPrompt(null);
        }}
        prompt={editingPrompt}
        channels={channelList}
        defaultChannelId={channelFilter && channelFilter !== "all" ? parseInt(channelFilter) : undefined}
      />
    </div>
  );
}
