import { useState, useEffect, useCallback } from "react";
import { useForm, Controller } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { useParams, useNavigate, useSearchParams } from "react-router-dom";
import {
  Video,
  Image,
  Settings2,
  Plus,
  Music,
  Film,
  FileImage,
  Loader2,
  BookOpen,
  FolderOpen,
  ExternalLink,
  Star,
  Trash2,
  Pencil,
  ChevronDown,
  ChevronRight,
  RefreshCw,
  Zap,
  HardDrive,
  Sparkles,
} from "lucide-react";
import { AIVoiceTab } from "./channel/AIVoiceTab";
import { PerformanceTab } from "./channel/PerformanceTab";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  useChannel,
  useChannelStats,
  useStorageStats,
  useUpdateChannel,
} from "@/hooks/use-channels";
import { formatBytes } from "@/lib/format";
import { YOUTUBE_COUNTRIES } from "@/lib/youtube-countries";
import { ChannelLocalizationsCard } from "@/components/ChannelLocalizationsCard";
import { useProjects } from "@/hooks/use-projects";
import { useAssets } from "@/hooks/use-assets";
import {
  usePrompts,
  useCreatePrompt,
  useUpdatePrompt,
  useDeletePrompt,
  useToggleFavorite,
} from "@/hooks/use-prompts";
import { NICHE_OPTIONS, STATUS_COLORS, PROMPT_TYPES } from "@/types/index";
import type { Channel, Prompt } from "@/types/index";
import { formatDistanceToNow } from "date-fns";
import api from "@/lib/api";
import { AutomationContent } from "@/pages/AutomationPage";

// ---------- Brand Profile Tab ----------

const brandProfileSchema = z.object({
  brand_identity: z.string(),
  target_audience: z.string(),
  default_tags: z.string(),
  title_template: z.string(),
  description_template: z.string(),
  notes: z.string(),
  thumbnail_style_notes: z.string(),
  upload_schedule: z.string(),
  default_video_width: z.number().int().min(1).max(7680),
  default_video_height: z.number().int().min(1).max(4320),
  default_video_style: z.string(),
  default_image_style: z.string(),
  master_language: z.string(),
  country: z.string(),
});
type BrandProfileValues = z.infer<typeof brandProfileSchema>;

function channelToBrandDefaults(channel: Channel): BrandProfileValues {
  return {
    brand_identity: channel.brand_identity ?? "",
    target_audience: channel.target_audience ?? "",
    default_tags: channel.default_tags ?? "",
    title_template: channel.title_template ?? "",
    description_template: channel.description_template ?? "",
    notes: channel.notes ?? "",
    thumbnail_style_notes: channel.thumbnail_style_notes ?? "",
    upload_schedule: channel.upload_schedule ?? "",
    default_video_width: channel.default_video_width ?? 1920,
    default_video_height: channel.default_video_height ?? 1080,
    default_video_style: channel.default_video_style ?? "spectrum",
    default_image_style: channel.default_image_style ?? "",
    master_language: channel.master_language ?? "en",
    country: channel.country ?? "",
  };
}

function BrandProfileTab({ channel }: { channel: Channel }) {
  const updateChannel = useUpdateChannel();
  const [techOpen, setTechOpen] = useState(false);

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { isDirty, isSubmitting },
  } = useForm<BrandProfileValues>({
    resolver: zodResolver(brandProfileSchema),
    defaultValues: channelToBrandDefaults(channel),
  });

  // When the channel prop changes (e.g. after save invalidates the query
  // and a fresh channel object arrives), sync form state.
  useEffect(() => {
    reset(channelToBrandDefaults(channel));
  }, [channel.id, reset]); // eslint-disable-line react-hooks/exhaustive-deps

  const onSubmit = async (values: BrandProfileValues) => {
    try {
      await updateChannel.mutateAsync({
        id: channel.id,
        brand_identity: values.brand_identity.trim() || null,
        target_audience: values.target_audience.trim() || null,
        default_tags: values.default_tags.trim() || null,
        title_template: values.title_template.trim() || null,
        description_template: values.description_template.trim() || null,
        notes: values.notes.trim() || null,
        thumbnail_style_notes: values.thumbnail_style_notes.trim() || null,
        upload_schedule: values.upload_schedule.trim() || null,
        default_video_width: values.default_video_width,
        default_video_height: values.default_video_height,
        default_video_style: values.default_video_style,
        default_image_style: values.default_image_style.trim() || null,
        master_language: values.master_language || "en",
        country: values.country.trim().toUpperCase() || null,
      });
      toast.success("Brand profile saved");
      reset(values); // mark form as pristine after successful save
    } catch {
      toast.error("Failed to save brand profile");
    }
  };

  return (
    <form onSubmit={handleSubmit(onSubmit)} className="space-y-6">
      <div className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="brand-identity">Brand Identity</Label>
          <Textarea
            id="brand-identity"
            {...register("brand_identity")}
            rows={4}
            placeholder="Describe your channel's brand, vibe, and content style"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="target-audience">Target Audience</Label>
          <Textarea
            id="target-audience"
            {...register("target_audience")}
            rows={2}
            placeholder="Who watches your content?"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="default-tags">Default Tags</Label>
          <Input
            id="default-tags"
            {...register("default_tags")}
            placeholder="comma separated, e.g. lofi, chill, study music"
          />
        </div>

        {/* Master language — the YouTube ``snippet.defaultLanguage`` for
            every video uploaded from this channel. Drives the
            translations machinery: the channel's master title +
            description are treated as written in this language;
            ``auto_translate_languages`` then targets every OTHER code.
            Default "en" preserves legacy behaviour. Set to "ko" /
            "ja" / etc. for non-English-master channels (e.g. yomii
            studio targets the Korean lofi/R&B audience). */}
        <div className="space-y-2">
          <Label htmlFor="master-language">Master Language</Label>
          <Controller
            control={control}
            name="master_language"
            render={({ field }) => (
              <Select
                value={field.value || "en"}
                onValueChange={field.onChange}
              >
                <SelectTrigger id="master-language" className="w-full">
                  <SelectValue placeholder="English" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="en">🇬🇧 English (en)</SelectItem>
                  <SelectItem value="ja">🇯🇵 Japanese (ja)</SelectItem>
                  <SelectItem value="ko">🇰🇷 Korean (ko)</SelectItem>
                  <SelectItem value="zh-Hans">🇨🇳 Simplified Chinese (zh-Hans)</SelectItem>
                  <SelectItem value="es">🇪🇸 Spanish (es)</SelectItem>
                  <SelectItem value="pt">🇵🇹 Portuguese (pt)</SelectItem>
                  <SelectItem value="id">🇮🇩 Indonesian (id)</SelectItem>
                  <SelectItem value="vi">🇻🇳 Vietnamese (vi)</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
          <p className="text-xs text-muted-foreground">
            The language the master title + description are written in.
            YouTube uses this as the video's primary audience signal.
            Auto-translate picker filters this out automatically.
          </p>
        </div>

        {/* Channel country — YouTube brandingSettings.channel.country.
            A fixed list prevents invalid-code 400s on the branding
            push. Empty = leave YouTube's value untouched. */}
        <div className="space-y-2">
          <Label htmlFor="channel-country">Channel Country</Label>
          <Controller
            control={control}
            name="country"
            render={({ field }) => (
              <Select
                value={field.value || "none"}
                onValueChange={(v) => field.onChange(v === "none" ? "" : v)}
              >
                <SelectTrigger id="channel-country" className="w-full">
                  <SelectValue placeholder="Not set" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">— Not set —</SelectItem>
                  {YOUTUBE_COUNTRIES.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.flag} {c.label} ({c.code})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          />
          <p className="text-xs text-muted-foreground">
            The channel's country on YouTube. Save here, then push it
            live with the Channel Localizations card below.
          </p>
        </div>

        <div className="space-y-2">
          <Label htmlFor="title-template">Title Template</Label>
          <Input
            id="title-template"
            {...register("title_template")}
            placeholder="e.g. {topic} | Lofi Beats"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="description-template">Description Template</Label>
          <Textarea
            id="description-template"
            {...register("description_template")}
            rows={4}
            placeholder="Default video description template"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="channel-notes">
            Operator Notes
            <span className="ml-2 text-xs font-normal text-muted-foreground">
              fed into metadata generation as soft context — what's working, audience feedback, learnings
            </span>
          </Label>
          <Textarea
            id="channel-notes"
            {...register("notes")}
            rows={10}
            placeholder={
              "Use Markdown or plain text. Examples:\n" +
              "## What's working\n" +
              "- Bilingual JP/EN titles outperform pure-English on this channel\n" +
              "- Tracks tagged \"sleep\" get 2x the watch-time minutes\n\n" +
              "## What's not working\n" +
              "- Generic \"chill lofi\" titles get ignored — too crowded a search lane\n\n" +
              "## Recent learnings (2026-05)\n" +
              "- Studio analytics show 18-24yo segment growing fastest; lean into that vocabulary\n" +
              "- Rainy / nighttime scene words convert better than sunny / morning"
            }
            className="font-mono text-xs"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="thumbnail-notes">Thumbnail Style Notes</Label>
          <Textarea
            id="thumbnail-notes"
            {...register("thumbnail_style_notes")}
            rows={2}
            placeholder="Visual style preferences for thumbnails"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="upload-schedule">Upload Schedule</Label>
          <Input
            id="upload-schedule"
            {...register("upload_schedule")}
            placeholder="e.g. Daily at 8am EST"
          />
        </div>
      </div>

      <Separator />

      {/* Collapsible Technical Defaults */}
      <div>
        <button
          type="button"
          className="flex w-full items-center gap-2 py-2 text-sm font-medium text-muted-foreground hover:text-foreground transition-colors"
          onClick={() => setTechOpen(!techOpen)}
        >
          {techOpen ? (
            <ChevronDown className="size-4" />
          ) : (
            <ChevronRight className="size-4" />
          )}
          Technical Defaults
        </button>
        {techOpen && (
          <div className="mt-3 space-y-4 rounded-lg border border-border p-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="video-width">Video Width</Label>
                <Input
                  id="video-width"
                  type="number"
                  {...register("default_video_width", { valueAsNumber: true })}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="video-height">Video Height</Label>
                <Input
                  id="video-height"
                  type="number"
                  {...register("default_video_height", { valueAsNumber: true })}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Video Composition Style</Label>
              <Controller
                control={control}
                name="default_video_style"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
                    <SelectTrigger className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="loop">Loop</SelectItem>
                      <SelectItem value="ken_burns">Ken Burns</SelectItem>
                      <SelectItem value="static">Static</SelectItem>
                      <SelectItem value="spectrum">Visualizer</SelectItem>
                    </SelectContent>
                  </Select>
                )}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="image-style">Default Image Style</Label>
              <Input
                id="image-style"
                placeholder="e.g. anime, realistic, watercolor"
                {...register("default_image_style")}
              />
            </div>
          </div>
        )}
      </div>

      <Button type="submit" disabled={isSubmitting || !isDirty}>
        {isSubmitting ? "Saving..." : isDirty ? "Save Brand Profile" : "Saved"}
      </Button>
    </form>
  );
}

// ---------- Brand Profile tab wrapper ----------
// The brand-profile form + the channel-localizations card are siblings.
// The card is a standalone component (not part of the zod form) because
// a per-language title/description map is awkward in a flat form — same
// reasoning as TranslationsPanel for per-video translations.
function BrandProfileSection({ channel }: { channel: Channel }) {
  return (
    <div className="space-y-6">
      <BrandProfileTab channel={channel} />
      <ChannelLocalizationsCard channel={channel} />
    </div>
  );
}

// ---------- Prompts Tab ----------

const promptFormSchema = z.object({
  prompt_type: z.string().min(1, "Please select a prompt type"),
  name: z.string().min(1, "Name is required").max(200),
  content: z.string().min(1, "Content is required"),
});
type PromptFormValues = z.infer<typeof promptFormSchema>;

function PromptFormDialog({
  open,
  onOpenChange,
  prompt,
  channelId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  prompt: Prompt | null;
  channelId: number;
}) {
  const createPrompt = useCreatePrompt();
  const updatePromptMut = useUpdatePrompt();
  const isEditing = !!prompt;

  const {
    register,
    handleSubmit,
    control,
    reset,
    formState: { errors, isSubmitting },
  } = useForm<PromptFormValues>({
    resolver: zodResolver(promptFormSchema),
    defaultValues: {
      prompt_type: prompt?.prompt_type ?? "",
      name: prompt?.name ?? "",
      content: prompt?.content ?? "",
    },
  });

  // Re-populate when switching between prompts (edit A → close → edit B).
  useEffect(() => {
    reset({
      prompt_type: prompt?.prompt_type ?? "",
      name: prompt?.name ?? "",
      content: prompt?.content ?? "",
    });
  }, [prompt?.id, open, reset]); // reset when the target prompt or open state changes

  const onSubmit = async (values: PromptFormValues) => {
    try {
      if (isEditing) {
        await updatePromptMut.mutateAsync({
          id: prompt.id,
          channel_id: channelId,
          prompt_type: values.prompt_type,
          name: values.name.trim(),
          content: values.content.trim(),
        });
        toast.success("Prompt updated");
      } else {
        await createPrompt.mutateAsync({
          channel_id: channelId,
          prompt_type: values.prompt_type,
          name: values.name.trim(),
          content: values.content.trim(),
        });
        toast.success("Prompt created");
      }
      onOpenChange(false);
    } catch {
      toast.error(isEditing ? "Failed to update prompt" : "Failed to create prompt");
    }
  };

  const isPending = createPrompt.isPending || updatePromptMut.isPending || isSubmitting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit(onSubmit)}>
          <DialogHeader>
            <DialogTitle>{isEditing ? "Edit Prompt" : "New Prompt"}</DialogTitle>
            <DialogDescription>
              {isEditing ? "Update prompt details." : "Create a new prompt for this channel."}
            </DialogDescription>
          </DialogHeader>
          <div className="mt-4 space-y-4">
            <div className="space-y-2">
              <Label>Prompt Type</Label>
              <Controller
                control={control}
                name="prompt_type"
                render={({ field }) => (
                  <Select value={field.value} onValueChange={field.onChange}>
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
                )}
              />
              {errors.prompt_type && (
                <p className="text-xs text-destructive">{errors.prompt_type.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ch-prompt-name">Name</Label>
              <Input
                id="ch-prompt-name"
                {...register("name")}
                placeholder="e.g. Chill Lofi Beat Generator"
              />
              {errors.name && (
                <p className="text-xs text-destructive">{errors.name.message}</p>
              )}
            </div>
            <div className="space-y-2">
              <Label htmlFor="ch-prompt-content">Content</Label>
              <Textarea
                id="ch-prompt-content"
                {...register("content")}
                placeholder="Write your prompt here..."
                rows={8}
              />
              {errors.content && (
                <p className="text-xs text-destructive">{errors.content.message}</p>
              )}
            </div>
          </div>
          <DialogFooter className="mt-6">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
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

function PromptsTab({ channelId }: { channelId: number }) {
  const { data: prompts, isLoading } = usePrompts({ channel_id: channelId });
  const deletePrompt = useDeletePrompt();
  const toggleFavorite = useToggleFavorite();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editingPrompt, setEditingPrompt] = useState<Prompt | null>(null);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const promptList = prompts ?? [];

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

  if (promptList.length === 0) {
    return (
      <>
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-12">
            <BookOpen className="mb-4 size-10 text-muted-foreground" />
            <h3 className="mb-2 font-medium">No prompts yet</h3>
            <p className="mb-4 text-sm text-muted-foreground">
              Create reusable prompts for this channel.
            </p>
            <Button onClick={handleNew}>
              <Plus className="size-4" />
              New Prompt
            </Button>
          </CardContent>
        </Card>
        <PromptFormDialog
          open={dialogOpen}
          onOpenChange={(open) => {
            setDialogOpen(open);
            if (!open) setEditingPrompt(null);
          }}
          prompt={editingPrompt}
          channelId={channelId}
        />
      </>
    );
  }

  return (
    <>
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted-foreground">
            {promptList.length} prompt{promptList.length !== 1 ? "s" : ""}
          </p>
          <Button size="sm" onClick={handleNew}>
            <Plus className="size-4" />
            New Prompt
          </Button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          {promptList.map((prompt) => {
            const typeInfo = getPromptTypeInfo(prompt.prompt_type);
            return (
              <Card
                key={prompt.id}
                className="group cursor-pointer transition-colors hover:bg-accent/50"
                onClick={() => handleEdit(prompt)}
              >
                <CardHeader className="pb-2">
                  <div className="flex items-start justify-between gap-2">
                    <CardTitle className="truncate text-base">
                      {prompt.name}
                    </CardTitle>
                    <button
                      className="shrink-0 rounded p-1 hover:bg-accent"
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
                </CardHeader>
                <CardContent>
                  <div className="mb-2">
                    {typeInfo && (
                      <Badge className={`${typeInfo.color} text-white`}>
                        {typeInfo.label}
                      </Badge>
                    )}
                  </div>
                  <p className="mb-2 text-sm text-muted-foreground line-clamp-2">
                    {prompt.content.length > 150
                      ? prompt.content.slice(0, 150) + "..."
                      : prompt.content}
                  </p>
                  <div className="flex items-center justify-between">
                    <span className="text-xs text-muted-foreground">
                      Used {prompt.times_used} time{prompt.times_used !== 1 ? "s" : ""}
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
      </div>
      <PromptFormDialog
        open={dialogOpen}
        onOpenChange={(open) => {
          setDialogOpen(open);
          if (!open) setEditingPrompt(null);
        }}
        prompt={editingPrompt}
        channelId={channelId}
      />
    </>
  );
}

// ---------- Projects Tab (preserved) ----------

function ProjectsTab({ channelId }: { channelId: string }) {
  const navigate = useNavigate();
  const { data: projects, isLoading } = useProjects({
    channel_id: channelId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!projects || projects.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Video className="mb-4 size-10 text-muted-foreground" />
          <h3 className="mb-2 font-medium">No projects yet</h3>
          <p className="mb-4 text-sm text-muted-foreground">
            Create your first video project for this channel.
          </p>
          <Button onClick={() => navigate("/projects/new")}>
            <Plus className="size-4" />
            New Project
          </Button>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          {projects.length} project{projects.length !== 1 ? "s" : ""}
        </p>
        <Button size="sm" onClick={() => navigate("/projects/new")}>
          <Plus className="size-4" />
          New Project
        </Button>
      </div>
      {projects
        .sort(
          (a, b) =>
            new Date(b.updated_at).getTime() -
            new Date(a.updated_at).getTime()
        )
        .map((project) => (
          <Card
            key={project.id}
            className="cursor-pointer transition-colors hover:bg-accent/50"
            onClick={() => navigate(`/projects/${project.id}`)}
          >
            <CardContent className="flex items-center justify-between">
              <div className="min-w-0 flex-1">
                <p className="truncate font-medium">{project.title}</p>
                <p className="text-xs text-muted-foreground">
                  Updated{" "}
                  {formatDistanceToNow(new Date(project.updated_at))} ago
                </p>
              </div>
              <Badge
                className={`${STATUS_COLORS[project.status] ?? "bg-gray-500"} text-white`}
              >
                {project.status.replace(/_/g, " ")}
              </Badge>
            </CardContent>
          </Card>
        ))}
    </div>
  );
}

// ---------- Assets Tab (preserved) ----------

function AssetsTab({ channelId }: { channelId: string }) {
  const { data: assets, isLoading } = useAssets({
    channel_id: channelId,
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!assets || assets.length === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <Image className="mb-4 size-10 text-muted-foreground" />
          <h3 className="mb-2 font-medium">No assets yet</h3>
          <p className="text-sm text-muted-foreground">
            Assets will appear here once you create projects.
          </p>
        </CardContent>
      </Card>
    );
  }

  const assetTypeIcon = (type: string) => {
    switch (type) {
      case "music":
        return <Music className="size-8 text-blue-400" />;
      case "image":
        return <FileImage className="size-8 text-green-400" />;
      case "composed":
        return <Film className="size-8 text-purple-400" />;
      default:
        return <Image className="size-8 text-muted-foreground" />;
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        {assets.length} asset{assets.length !== 1 ? "s" : ""}
      </p>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {assets.map((asset) => (
          <Card key={asset.id}>
            <CardContent className="flex items-start gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-lg bg-muted">
                {asset.asset_type === "image" && asset.file_url ? (
                  <img
                    src={asset.file_url}
                    alt={asset.filename}
                    className="size-12 rounded-lg object-cover"
                  />
                ) : (
                  assetTypeIcon(asset.asset_type)
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium">
                  {asset.filename}
                </p>
                <div className="mt-1 flex items-center gap-2">
                  <Badge variant="outline" className="text-xs">
                    {asset.asset_type}
                  </Badge>
                  {asset.file_size && (
                    <span className="text-xs text-muted-foreground">
                      {(asset.file_size / 1024 / 1024).toFixed(1)} MB
                    </span>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}

// ---------- Storage Tab ----------

/**
 * Per-channel disk-usage breakdown sourced from
 * ``GET /api/stats/storage``. Surfaces what's eating disk so the user
 * can spot when, e.g., 80% of space is composed videos and decide to
 * delete old uploads. Sets up the Phase 3 retention worker which will
 * automate this with a per-channel disk cap.
 */
function StorageTab({ channelId }: { channelId: number }) {
  const { data: rows, isLoading } = useStorageStats();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="size-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const row = rows?.find((r) => r.channel_id === channelId);
  if (!row || row.asset_count === 0) {
    return (
      <Card>
        <CardContent className="flex flex-col items-center justify-center py-12">
          <HardDrive className="mb-4 size-10 text-muted-foreground" />
          <h3 className="mb-2 font-medium">No assets yet</h3>
          <p className="text-sm text-muted-foreground">
            Storage will populate here once this channel has assets.
          </p>
        </CardContent>
      </Card>
    );
  }

  // Sort by-type entries descending by bytes so the heaviest category
  // is always at the top — that's what the operator wants to see first.
  const types = Object.entries(row.by_type).sort(
    (a, b) => b[1].bytes - a[1].bytes,
  );
  const total = row.total_bytes || 1; // avoid div/0 on the bar widths

  const TYPE_LABELS: Record<string, string> = {
    music: "Music",
    image: "Images",
    video: "Video clips",
    composed: "Composed videos",
    thumbnail: "Thumbnails",
  };
  const TYPE_COLORS: Record<string, string> = {
    music: "bg-blue-500",
    image: "bg-green-500",
    video: "bg-orange-500",
    composed: "bg-purple-500",
    thumbnail: "bg-pink-500",
  };

  return (
    <div className="space-y-4">
      {/* Top-line summary */}
      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="flex items-center gap-2 text-base">
            <HardDrive className="size-4 text-muted-foreground" />
            Total: {formatBytes(row.total_bytes)}
            <span className="text-sm font-normal text-muted-foreground">
              · {row.asset_count} assets
            </span>
          </CardTitle>
        </CardHeader>
        <CardContent>
          {/* Stacked bar — each segment proportional to its byte share. */}
          <div className="flex h-3 overflow-hidden rounded-full bg-muted">
            {types.map(([type, info]) => (
              <div
                key={type}
                className={TYPE_COLORS[type] ?? "bg-muted-foreground"}
                style={{ width: `${(info.bytes / total) * 100}%` }}
                title={`${TYPE_LABELS[type] ?? type}: ${formatBytes(info.bytes)}`}
              />
            ))}
          </div>
        </CardContent>
      </Card>

      {/* Per-type breakdown */}
      <div className="grid gap-3 sm:grid-cols-2">
        {types.map(([type, info]) => {
          const pct = (info.bytes / total) * 100;
          return (
            <Card key={type}>
              <CardContent className="space-y-2 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div
                      className={`size-2.5 rounded-full ${TYPE_COLORS[type] ?? "bg-muted-foreground"}`}
                    />
                    <span className="text-sm font-medium">
                      {TYPE_LABELS[type] ?? type}
                    </span>
                  </div>
                  <span className="text-xs text-muted-foreground">
                    {info.count} {info.count === 1 ? "file" : "files"}
                  </span>
                </div>
                <div className="flex items-baseline justify-between">
                  <span className="text-lg font-semibold tabular-nums">
                    {formatBytes(info.bytes)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {pct.toFixed(1)}%
                  </span>
                </div>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="text-xs text-muted-foreground">
        Composed videos and downloaded YouTube audio account for most of the
        weight. Phase 3 will add an automatic per-channel cap so this never
        runs away on you.
      </p>
    </div>
  );
}

// ---------- YouTube Tab ----------

function YouTubeTab({ channel }: { channel: Channel }) {
  const [searchParams] = useSearchParams();
  const [authLoading, setAuthLoading] = useState(false);

  useEffect(() => {
    if (searchParams.get("oauth") === "success") {
      toast.success("YouTube connected successfully!");
    }
  }, [searchParams]);

  const handleConnect = async () => {
    setAuthLoading(true);
    try {
      const { data } = await api.get(`/youtube/auth-url?channel_id=${channel.id}`);
      window.location.href = data.url || data.auth_url;
    } catch {
      toast.error("Failed to get YouTube auth URL");
      setAuthLoading(false);
    }
  };

  const [disconnecting, setDisconnecting] = useState(false);

  const handleDisconnect = async () => {
    setDisconnecting(true);
    try {
      await api.post("/youtube/disconnect", { channel_id: channel.id });
      toast.success("YouTube disconnected");
      window.location.reload();
    } catch {
      toast.error("Failed to disconnect YouTube");
    } finally {
      setDisconnecting(false);
    }
  };

  if (channel.youtube_connected) {
    return <ConnectedYouTubeCard
      channel={channel}
      onReconnect={handleConnect}
      onDisconnect={handleDisconnect}
      authLoading={authLoading}
      disconnecting={disconnecting}
    />;
  }

  return (
    <Card>
      <CardContent className="py-12">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-muted">
            <ExternalLink className="size-8 text-muted-foreground" />
          </div>
          <div>
            <h3 className="text-lg font-medium">Connect YouTube</h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Link your YouTube account to enable direct uploads and scheduling.
            </p>
            <p className="mx-auto mt-2 max-w-md text-xs text-muted-foreground">
              Got multiple channels under one Google account (brand
              accounts)? On the consent screen, click your profile icon
              and pick the brand channel you want to upload TO before
              accepting.
            </p>
          </div>
          <Button onClick={handleConnect} disabled={authLoading}>
            {authLoading ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Redirecting...
              </>
            ) : (
              <>
                <ExternalLink className="size-4" />
                Connect YouTube
              </>
            )}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- "Currently uploading as" card with whoami check ----------

interface YouTubeWhoami {
  youtube_channel_id: string;
  title: string | null;
  thumbnail: string | null;
  subscriber_count: number | null;
  video_count: number;
}

function ConnectedYouTubeCard({
  channel,
  onReconnect,
  onDisconnect,
  authLoading,
  disconnecting,
}: {
  channel: Channel;
  onReconnect: () => void;
  onDisconnect: () => void;
  authLoading: boolean;
  disconnecting: boolean;
}) {
  const [me, setMe] = useState<YouTubeWhoami | null>(null);
  const [meErr, setMeErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setMeErr(null);
    try {
      const { data } = await api.get<YouTubeWhoami>(
        `/youtube/whoami?channel_id=${channel.id}`,
      );
      setMe(data);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      setMeErr(typeof detail === "string" ? detail : "Could not check YouTube");
    } finally {
      setLoading(false);
    }
  }, [channel.id]);

  useEffect(() => {
    load();
  }, [load]);

  // Detect when the actual upload-target channel doesn't match the channel
  // we recorded at connect time — happens when a brand-account user picked
  // the wrong account on the Google consent screen.
  const mismatch =
    me &&
    channel.youtube_channel_id &&
    me.youtube_channel_id !== channel.youtube_channel_id;

  return (
    <Card>
      <CardContent className="py-8">
        <div className="flex flex-col items-center gap-4 text-center">
          <div className="flex size-16 items-center justify-center rounded-full bg-green-500/10">
            <ExternalLink className="size-8 text-green-500" />
          </div>
          <div>
            <h3 className="text-lg font-medium text-green-500">
              YouTube Connected
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Uploads from this channel land on the YouTube account below.
            </p>
          </div>

          {/* Live "uploading as" summary from the YouTube API */}
          <div className="w-full max-w-md rounded-lg border border-border/60 bg-muted/20 p-3 text-left">
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Currently uploading as
            </p>
            {loading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-3 animate-spin" />
                Checking with YouTube…
              </div>
            )}
            {meErr && !loading && (
              <p className="text-xs text-destructive">⚠ {meErr}</p>
            )}
            {me && !loading && (
              <div className="flex items-center gap-3">
                {me.thumbnail && (
                  <img
                    src={me.thumbnail}
                    alt={me.title ?? me.youtube_channel_id}
                    className="size-10 shrink-0 rounded-full object-cover"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">
                    {me.title ?? "(unnamed channel)"}
                  </p>
                  <p className="truncate text-[11px] text-muted-foreground">
                    {me.video_count} videos
                    {me.subscriber_count != null && (
                      <> · {me.subscriber_count.toLocaleString()} subs</>
                    )}
                  </p>
                  <p className="truncate font-mono text-[10px] text-muted-foreground">
                    {me.youtube_channel_id}
                  </p>
                </div>
              </div>
            )}
          </div>

          {mismatch && (
            <div className="w-full max-w-md rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-left text-xs text-amber-200/90">
              ⚠ Heads up — the channel uploads will land on doesn't match
              the channel ID we have on file. If you have multiple YouTube
              channels under one Google account (brand accounts) this is
              normal: click <strong>Reconnect</strong> below, then on the
              Google consent screen pick the right brand channel from the
              account picker.
            </div>
          )}

          <p className="max-w-md text-center text-xs text-muted-foreground">
            <strong>Wrong channel?</strong> If you have multiple YouTube
            channels under one Google account, click Reconnect, and on the
            consent screen click your profile icon (top right) → "Use
            another account" or pick the brand channel you want.
            <br />
            <span className="opacity-70">
              Tokens unused for ~6 months expire and need a Reconnect too.
            </span>
          </p>

          <div className="flex gap-2">
            <Button onClick={onReconnect} disabled={authLoading}>
              <RefreshCw className="size-4" />
              {authLoading ? "Redirecting..." : "Reconnect"}
            </Button>
            <Button
              variant="destructive"
              onClick={onDisconnect}
              disabled={disconnecting}
            >
              {disconnecting ? "Disconnecting..." : "Disconnect"}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ---------- Loading Skeleton ----------

function LoadingSkeleton() {
  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <div className="h-8 w-48 animate-pulse rounded bg-muted" />
        <div className="h-5 w-16 animate-pulse rounded-full bg-muted" />
      </div>
      <div className="h-10 w-80 animate-pulse rounded bg-muted" />
      <div className="space-y-3">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-xl bg-muted" />
        ))}
      </div>
    </div>
  );
}

// ---------- Main Page ----------

export default function ChannelDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") ?? "brand";

  const { data: channel, isLoading, error } = useChannel(id);
  const { data: stats } = useChannelStats(id);

  if (isLoading) return <LoadingSkeleton />;

  if (error || !channel) {
    return (
      <Card>
        <CardContent className="py-12 text-center">
          <p className="text-sm text-destructive">
            {error ? "Failed to load channel." : "Channel not found."}
          </p>
        </CardContent>
      </Card>
    );
  }

  const nicheLabel =
    NICHE_OPTIONS.find((n) => n.value === channel.niche)?.label ??
    channel.niche;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold">{channel.name}</h1>
          <Badge variant="secondary">{nicheLabel}</Badge>
          <div className="flex items-center gap-1.5 text-sm">
            <Video className="size-4" />
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
        </div>
      </div>

      {channel.description && (
        <p className="text-sm text-muted-foreground">{channel.description}</p>
      )}

      {stats && (
        <div className="flex gap-6 text-sm text-muted-foreground">
          <span>{stats.total_projects} projects</span>
          <span>{stats.total_assets} assets</span>
        </div>
      )}

      <ChannelSetupChecklist channel={channel} stats={stats} />

      {/* Tabs */}
      <Tabs
        value={activeTab}
        onValueChange={(v) => setSearchParams({ tab: v })}
      >
        <TabsList>
          <TabsTrigger value="brand">
            <Settings2 className="size-4" />
            Brand Profile
          </TabsTrigger>
          <TabsTrigger value="ai-voice">
            <Sparkles className="size-4" />
            AI Voice
          </TabsTrigger>
          <TabsTrigger value="prompts">
            <BookOpen className="size-4" />
            Prompts
          </TabsTrigger>
          <TabsTrigger value="projects">
            <Video className="size-4" />
            Projects
          </TabsTrigger>
          <TabsTrigger value="assets">
            <FolderOpen className="size-4" />
            Assets
          </TabsTrigger>
          <TabsTrigger value="storage">
            <HardDrive className="size-4" />
            Storage
          </TabsTrigger>
          <TabsTrigger value="youtube">
            <ExternalLink className="size-4" />
            YouTube
          </TabsTrigger>
          <TabsTrigger value="performance">
            <ExternalLink className="size-4" />
            Performance
          </TabsTrigger>
          <TabsTrigger value="automation">
            <Zap className="size-4" />
            Automation
          </TabsTrigger>
        </TabsList>
        <TabsContent value="brand">
          <BrandProfileSection channel={channel} />
        </TabsContent>
        <TabsContent value="ai-voice">
          <AIVoiceTab channel={channel} />
        </TabsContent>
        <TabsContent value="prompts">
          <PromptsTab channelId={channel.id} />
        </TabsContent>
        <TabsContent value="projects">
          <ProjectsTab channelId={id!} />
        </TabsContent>
        <TabsContent value="assets">
          <AssetsTab channelId={id!} />
        </TabsContent>
        <TabsContent value="storage">
          <StorageTab channelId={channel.id} />
        </TabsContent>
        <TabsContent value="youtube">
          <YouTubeTab channel={channel} />
        </TabsContent>
        <TabsContent value="performance">
          <PerformanceTab channelId={channel.id} />
        </TabsContent>
        <TabsContent value="automation">
          <AutomationContent channelId={channel.id} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

// ── Setup checklist ─────────────────────────────────────────────────────
//
// 4-item progress strip telling the user what they still need to configure
// before they can press "Generate now" on the Dashboard. Items map to:
//  1) Brand profile is filled in
//  2) YouTube is connected
//  3) Music library has at least one asset
//  4) An automation preset exists (and ideally is_primary)

function ChannelSetupChecklist({
  channel,
  stats,
}: {
  channel: { id: number; brand_identity?: string | null; youtube_connected?: boolean };
  stats: { total_assets: number; total_projects: number } | null | undefined;
}) {
  const items = [
    {
      label: "Brand profile",
      done: Boolean(channel.brand_identity && channel.brand_identity.length > 10),
      hint: "Fill in the channel's identity and templates below.",
    },
    {
      label: "YouTube connected",
      done: Boolean(channel.youtube_connected),
      hint: "Connect via the YouTube tab.",
    },
    {
      label: "Music library",
      done: (stats?.total_assets ?? 0) > 0,
      hint: "Import music assets in the Assets page.",
    },
    {
      label: "Automation preset",
      done: false, // can't probe cheaply without another query — surface as suggestion
      hint: "Create one on the Automation page to enable the Dashboard one-click button.",
      optional: true,
    },
  ];

  const done = items.filter((i) => i.done).length;
  const total = items.length;

  return (
    <div className="rounded-lg border border-border/60 bg-card/40 p-3">
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-medium text-muted-foreground">
          Setup progress
        </p>
        <p className="text-xs text-muted-foreground">
          {done} of {total} done
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {items.map((it) => (
          <div
            key={it.label}
            className="flex items-start gap-2 rounded-md border border-border/40 bg-background/40 p-2 text-xs"
          >
            <span
              className={
                it.done ? "text-green-500" : "text-muted-foreground/60"
              }
            >
              {it.done ? "✓" : "○"}
            </span>
            <div className="flex-1">
              <p
                className={
                  it.done ? "font-medium text-foreground" : "font-medium"
                }
              >
                {it.label}
                {it.optional && (
                  <span className="ml-1 text-[10px] text-muted-foreground">
                    (optional)
                  </span>
                )}
              </p>
              {!it.done && (
                <p className="text-[11px] text-muted-foreground">{it.hint}</p>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
