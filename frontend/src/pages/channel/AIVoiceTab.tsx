/**
 * Channel → AI Voice Studio (Phase 2 of farm redesign).
 *
 * Replaces the old "fill seven textareas, click Save, then click
 * Generate Sample" linear flow with a two-pane Studio:
 *   - Left: editable voice form (niche, identity, audience, ai_voice,
 *     example title/description/tags, notes). Inline save button. The
 *     form holds an unsaved-edit draft so the live preview can use it.
 *   - Right: live sample preview. "Generate a sample" calls the
 *     /ai-sample endpoint with the CURRENT (possibly unsaved) draft
 *     values as a voice_override, so the operator sees the effect of
 *     edits immediately. Saved values aren't required.
 *
 * Plus three new affordances surfaced as top-bar buttons:
 *   - Profiles ▾ — save current voice as a named profile or apply a
 *     saved profile to this channel. Cross-channel reuse.
 *   - Learn from URL — paste a competitor channel/video URL, run the
 *     Claude in Chrome MCP scrape from another session if the operator
 *     wants assisted learning, then POST the scraped content for rule
 *     proposals. Operator reviews each rule with Apply / Skip.
 *   - History — drawer of every voice snapshot for this channel,
 *     restorable with one click.
 *
 * NOTE: the older "Show me what Claude will see" preview is kept
 * intact below the Studio — the system prompt readout is the most
 * useful for senior operators auditing what the system actually does.
 */
import { useEffect, useState } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import {
  AlertCircle,
  Eye,
  History,
  Library,
  Loader2,
  Sparkles,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { useUpdateChannel } from "@/hooks/use-channels";
import {
  useGenerateVoiceSample,
} from "@/hooks/use-voice-profiles";
import { VoiceProfilesMenu } from "@/components/voice/VoiceProfilesMenu";
import { VoiceHistoryDrawer } from "@/components/voice/VoiceHistoryDrawer";
import { LearnFromUrlDialog } from "@/components/voice/LearnFromUrlDialog";
import api from "@/lib/api";
import type { Channel } from "@/types/index";

// ── Form schema ──────────────────────────────────────────────────────

const voiceSchema = z.object({
  niche: z.string(),
  brand_identity: z.string(),
  target_audience: z.string(),
  ai_voice: z.string(),
  ai_example_title: z.string(),
  ai_example_description: z.string(),
  ai_example_tags: z.string(),
  notes: z.string(),
});

type VoiceValues = z.infer<typeof voiceSchema>;

function channelToDefaults(channel: Channel): VoiceValues {
  return {
    niche: channel.niche ?? "",
    brand_identity: channel.brand_identity ?? "",
    target_audience: channel.target_audience ?? "",
    ai_voice: channel.ai_voice ?? "",
    ai_example_title: channel.ai_example_title ?? "",
    ai_example_description: channel.ai_example_description ?? "",
    ai_example_tags: channel.ai_example_tags ?? "",
    notes: channel.notes ?? "",
  };
}

// ── Component ────────────────────────────────────────────────────────

interface PromptPreview {
  system_prompt: string;
  user_prompt: string;
  based_on_project_id: number | null;
  based_on_project_title: string | null;
  track_names_used: string[];
  research_available: boolean;
  channel_has_examples: boolean;
}

export function AIVoiceTab({ channel }: { channel: Channel }) {
  const updateChannel = useUpdateChannel();
  const sampleMut = useGenerateVoiceSample();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [learnOpen, setLearnOpen] = useState(false);

  const {
    register,
    handleSubmit,
    reset,
    getValues,
    watch,
    setValue,
    formState: { isDirty, isSubmitting },
  } = useForm<VoiceValues>({
    resolver: zodResolver(voiceSchema),
    defaultValues: channelToDefaults(channel),
  });

  // Re-seed the form when navigating between channels (channel.id
  // dependency only — re-running on every render would clobber typing).
  useEffect(() => {
    reset(channelToDefaults(channel));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // Old system-prompt preview kept for senior operators (audit aid).
  const [preview, setPreview] = useState<PromptPreview | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const onSubmit = async (values: VoiceValues) => {
    try {
      await updateChannel.mutateAsync({ id: channel.id, ...values });
      toast.success("Voice saved");
      reset(values, { keepValues: true });
    } catch {
      toast.error("Save failed");
    }
  };

  const showPreview = async () => {
    setPreviewLoading(true);
    try {
      const { data } = await api.get<PromptPreview>(
        `/channels/${channel.id}/ai-prompt-preview`,
      );
      setPreview(data);
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Failed to load preview");
    } finally {
      setPreviewLoading(false);
    }
  };

  /** Generate a sample using the CURRENT draft (unsaved edits and all). */
  const generateLivePreview = async () => {
    const values = getValues();
    try {
      await sampleMut.mutateAsync({
        channelId: channel.id,
        override: values,
      });
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(typeof detail === "string" ? detail : "Sample failed");
    }
  };

  /** When the operator applies a Learn-from-URL proposal, splice the
   *  rule text into the current ai_voice field (or replace the example
   *  title) without committing — so they can review more proposals
   *  before saving. */
  const applyProposedRule = (ruleText: string) => {
    const cur = getValues("ai_voice");
    const next = cur.trim()
      ? `${cur.trim()}\n\n${ruleText.trim()}`
      : ruleText.trim();
    setValue("ai_voice", next, { shouldDirty: true });
    toast.success("Rule queued — save to persist");
  };

  const applyProposedTitle = (titleText: string) => {
    setValue("ai_example_title", titleText.trim(), { shouldDirty: true });
    toast.success("Example title updated — save to persist");
  };

  const sample = sampleMut.data;
  const sampleLoading = sampleMut.isPending;

  // Watch ai_voice + ai_example_title for the LearnFromUrl dialog so it
  // can preserve the operator's current voice as context.
  const aiVoiceVal = watch("ai_voice");
  const aiExampleTitleVal = watch("ai_example_title");
  const nicheVal = watch("niche");

  return (
    <div className="space-y-6">
      {/* ── Top bar: profiles + learn + history ─────────────────── */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold">
            <Sparkles className="size-4 text-primary" />
            AI Voice Studio
          </h2>
          <p className="text-xs text-muted-foreground">
            Edit on the left, see Claude&apos;s output on the right. No save
            required for previews.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <VoiceProfilesMenu channel={channel} />
          <Button
            variant="outline"
            size="sm"
            onClick={() => setLearnOpen(true)}
          >
            <Library className="size-3.5" />
            Learn from URL
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setHistoryOpen(true)}
          >
            <History className="size-3.5" />
            History
          </Button>
        </div>
      </div>

      {/* ── Two-pane Studio ───────────────────────────────────────── */}
      <div className="grid gap-4 lg:grid-cols-[1fr_1fr]">
        {/* LEFT — edit form */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <Wand2 className="size-4 text-primary" />
                Voice configuration
              </span>
              <Button
                type="button"
                size="sm"
                disabled={isSubmitting || !isDirty}
                onClick={handleSubmit(onSubmit)}
              >
                {isSubmitting ? "Saving…" : isDirty ? "Save" : "Saved"}
              </Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <form
              onSubmit={handleSubmit(onSubmit)}
              className="space-y-4"
            >
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1.5">
                  <Label htmlFor="niche" className="text-xs">Niche</Label>
                  <Input
                    id="niche"
                    placeholder="lofi, ambient, fantasy ambient…"
                    {...register("niche")}
                    className="h-8 text-xs"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="target_audience" className="text-xs">
                    Target audience
                  </Label>
                  <Input
                    id="target_audience"
                    placeholder="late-night listeners, students…"
                    {...register("target_audience")}
                    className="h-8 text-xs"
                  />
                </div>
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="brand_identity" className="text-xs">
                  Brand identity
                </Label>
                <Textarea
                  id="brand_identity"
                  rows={2}
                  placeholder="Calm, dreamy, 70bpm lofi…"
                  {...register("brand_identity")}
                  className="text-xs"
                />
              </div>

              <Separator />

              <div className="space-y-1.5">
                <Label htmlFor="ai_voice" className="flex items-center gap-1 text-xs">
                  <Wand2 className="size-3" />
                  Voice instructions (HIGH priority)
                </Label>
                <Textarea
                  id="ai_voice"
                  rows={6}
                  placeholder="Rules Claude must follow every render."
                  className="font-mono text-[11px]"
                  {...register("ai_voice")}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai_example_title" className="text-xs">
                  Example title
                </Label>
                <Input
                  id="ai_example_title"
                  placeholder="The exact title structure to mimic"
                  {...register("ai_example_title")}
                  className="h-8 text-xs"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai_example_description" className="text-xs">
                  Example description
                </Label>
                <Textarea
                  id="ai_example_description"
                  rows={6}
                  placeholder="Reference description structure"
                  className="font-mono text-[11px]"
                  {...register("ai_example_description")}
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="ai_example_tags" className="text-xs">
                  Example tags (CSV)
                </Label>
                <Textarea
                  id="ai_example_tags"
                  rows={2}
                  placeholder="tag1, tag2, tag3…"
                  className="font-mono text-[11px]"
                  {...register("ai_example_tags")}
                />
              </div>

              <Separator />

              <div className="space-y-1.5">
                <Label htmlFor="notes" className="text-xs">
                  Operator notes (soft context, weighed less than voice rules)
                </Label>
                <Textarea
                  id="notes"
                  rows={3}
                  placeholder="What's working / what's not — Claude weighs these but never overrides the voice rules above."
                  className="text-xs"
                  {...register("notes")}
                />
              </div>
            </form>
          </CardContent>
        </Card>

        {/* RIGHT — live preview */}
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center justify-between gap-2 text-sm">
              <span className="flex items-center gap-2">
                <Sparkles className="size-4 text-primary" />
                Live sample
              </span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={generateLivePreview}
                disabled={sampleLoading}
              >
                {sampleLoading ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" />
                    Generating…
                  </>
                ) : (
                  <>
                    <Wand2 className="size-3.5" />
                    {sample ? "Re-generate" : "Generate sample"}
                  </>
                )}
              </Button>
            </CardTitle>
            <p className="text-[11px] text-muted-foreground">
              Uses the values in the form on the left — including unsaved
              edits. Takes ~30–60s for the Claude call.
            </p>
          </CardHeader>
          <CardContent>
            {!sample && !sampleLoading && (
              <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-md border border-dashed border-border bg-muted/20 text-center text-xs text-muted-foreground">
                <Wand2 className="size-6 opacity-30" />
                <p>Click "Generate sample" to preview metadata.</p>
                <p className="text-[10px] opacity-70">
                  Uses your current edits, no save required.
                </p>
              </div>
            )}
            {sampleLoading && !sample && (
              <div className="flex h-64 flex-col items-center justify-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-6 animate-spin" />
                <p>Calling Claude with current voice…</p>
              </div>
            )}
            {sample && (
              <div className="space-y-3 text-xs">
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Title
                  </Label>
                  <p className="mt-1 font-medium leading-snug break-words">
                    {sample.title}
                  </p>
                </div>
                <Separator />
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Description ({sample.description.length} chars)
                  </Label>
                  <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap break-words rounded-md border bg-muted/30 p-2 font-sans text-[11px] leading-relaxed">
                    {sample.description}
                  </pre>
                </div>
                <Separator />
                <div>
                  <Label className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Tags ({sample.tags.length})
                  </Label>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {sample.tags.map((t, i) => (
                      <Badge key={i} variant="outline" className="text-[10px] py-0">
                        {t}
                      </Badge>
                    ))}
                  </div>
                </div>
                {isDirty && (
                  <div className="flex items-center gap-1.5 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[10px] text-amber-200/90">
                    <AlertCircle className="size-3 shrink-0" />
                    This sample uses your current EDITS. Save to make them
                    permanent for real renders.
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      {/* ── System prompt audit panel (kept from legacy tab) ─────── */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            <Eye className="size-4 text-primary" />
            Audit: what Claude actually sees
          </CardTitle>
          <p className="text-xs text-muted-foreground">
            Renders the FULL system + user prompt for this channel. Read-
            only, no Claude call. Useful for debugging voice rules that
            don&apos;t produce the expected output.
          </p>
        </CardHeader>
        <CardContent className="space-y-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={showPreview}
            disabled={previewLoading}
          >
            {previewLoading ? (
              <>
                <Loader2 className="size-3.5 animate-spin" />
                Loading…
              </>
            ) : (
              <>
                <Eye className="size-3.5" />
                Show full prompt
              </>
            )}
          </Button>

          {preview && (
            <div className="space-y-2">
              <div className="flex flex-wrap gap-1.5">
                {preview.based_on_project_title ? (
                  <Badge variant="secondary" className="text-[10px]">
                    Based on: {preview.based_on_project_title}
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    No projects yet
                  </Badge>
                )}
                {preview.research_available && (
                  <Badge variant="secondary" className="text-[10px]">
                    Research included
                  </Badge>
                )}
                {preview.channel_has_examples ? (
                  <Badge className="bg-green-500/20 text-green-200 text-[10px]">
                    Channel voice
                  </Badge>
                ) : (
                  <Badge className="bg-amber-500/20 text-amber-200 text-[10px]">
                    Generic fallback
                  </Badge>
                )}
              </div>
              <details className="rounded-md border border-border bg-muted/20 p-3" open>
                <summary className="cursor-pointer text-xs font-medium">
                  System prompt
                </summary>
                <pre className="mt-2 max-h-[400px] overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                  {preview.system_prompt}
                </pre>
              </details>
              <details className="rounded-md border border-border bg-muted/20 p-3">
                <summary className="cursor-pointer text-xs font-medium">
                  User prompt
                </summary>
                <pre className="mt-2 max-h-[400px] overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
                  {preview.user_prompt}
                </pre>
              </details>
            </div>
          )}
        </CardContent>
      </Card>

      <VoiceHistoryDrawer
        open={historyOpen}
        onOpenChange={setHistoryOpen}
        channel={channel}
      />
      <LearnFromUrlDialog
        open={learnOpen}
        onOpenChange={setLearnOpen}
        channel={channel}
        currentAiVoice={aiVoiceVal}
        currentExampleTitle={aiExampleTitleVal}
        currentNiche={nicheVal}
        onApplyRule={applyProposedRule}
        onApplyExampleTitle={applyProposedTitle}
      />
    </div>
  );
}
