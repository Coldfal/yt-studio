/**
 * Learn-from-URL dialog. The operator pastes a competitor channel or
 * video URL plus the visible titles (and optionally descriptions); the
 * backend runs Claude with a "propose voice rule additions" prompt and
 * returns structured proposals. The operator reviews each one with
 * Apply / Skip / Edit & apply controls.
 *
 * NOTE: when this app is used inside a Claude Code session with the
 * Claude in Chrome MCP loaded, the operator can ask Claude to scrape
 * the URL into the titles textarea automatically. For the standalone
 * app, the operator pastes titles manually.
 */
import { useState } from "react";
import { toast } from "sonner";
import {
  Library,
  Loader2,
  Sparkles,
  Wand2,
  AlertCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  useLearnFromUrl,
  type LearnFromUrlProposals,
} from "@/hooks/use-voice-profiles";
import type { Channel } from "@/types/index";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  channel: Channel;
  currentAiVoice: string;
  currentExampleTitle: string;
  currentNiche: string;
  /** Append a proposed rule into the parent's ai_voice draft. */
  onApplyRule: (ruleText: string) => void;
  /** Replace the parent's ai_example_title with a proposed one. */
  onApplyExampleTitle: (titleText: string) => void;
}

export function LearnFromUrlDialog({
  open,
  onOpenChange,
  channel,
  onApplyRule,
  onApplyExampleTitle,
}: Props) {
  const [url, setUrl] = useState("");
  const [kind, setKind] = useState<"channel" | "video">("channel");
  const [titlesText, setTitlesText] = useState("");
  const [descsText, setDescsText] = useState("");
  const learn = useLearnFromUrl();
  const [proposals, setProposals] = useState<LearnFromUrlProposals | null>(null);
  const [appliedRules, setAppliedRules] = useState<Set<number>>(new Set());

  const reset = () => {
    setUrl("");
    setKind("channel");
    setTitlesText("");
    setDescsText("");
    setProposals(null);
    setAppliedRules(new Set());
  };

  const handleSubmit = async () => {
    const titles = titlesText
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
    if (titles.length < 3) {
      toast.error("Paste at least 3 titles to learn from");
      return;
    }
    if (!url.trim()) {
      toast.error("URL required (just for reference)");
      return;
    }
    const descs = descsText.trim()
      ? descsText.split(/\n---\n/).map((s) => s.trim()).filter(Boolean)
      : [];

    try {
      const result = await learn.mutateAsync({
        channelId: channel.id,
        url: url.trim(),
        kind,
        scraped_titles: titles,
        scraped_descriptions: descs,
      });
      setProposals(result);
      setAppliedRules(new Set());
      toast.success(
        `${result.proposed_rule_additions.length} rule proposals + ${result.proposed_example_titles.length} example titles`,
      );
    } catch (err: unknown) {
      const detail = (err as { response?: { data?: { detail?: string } } })
        ?.response?.data?.detail;
      toast.error(
        typeof detail === "string" ? detail : "Couldn't analyse the input",
      );
    }
  };

  const handleApplyRule = (idx: number, ruleText: string) => {
    onApplyRule(ruleText);
    setAppliedRules(new Set([...appliedRules, idx]));
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) reset();
        onOpenChange(o);
      }}
    >
      <DialogContent className="sm:max-w-[920px] max-h-[90vh] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b p-4">
          <DialogTitle className="flex items-center gap-2">
            <Library className="size-4 text-primary" />
            Learn voice rules from a competitor
          </DialogTitle>
          <DialogDescription>
            Paste a competitor channel/video URL plus the top visible
            titles. Claude proposes voice rules + example titles you can
            apply one at a time.
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[72vh]">
          <div className="space-y-4 p-4">
            {!proposals && (
              <>
                <div className="grid gap-3 sm:grid-cols-[2fr_1fr]">
                  <div className="space-y-1.5">
                    <Label className="text-xs" htmlFor="competitor-url">
                      Competitor URL
                    </Label>
                    <Input
                      id="competitor-url"
                      placeholder="https://youtube.com/@channel or /watch?v=..."
                      value={url}
                      onChange={(e) => setUrl(e.target.value)}
                      className="h-8"
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label className="text-xs">Kind</Label>
                    <select
                      value={kind}
                      onChange={(e) =>
                        setKind(e.target.value as "channel" | "video")
                      }
                      className="h-8 w-full rounded border border-border bg-background px-2 text-xs"
                    >
                      <option value="channel">Channel</option>
                      <option value="video">Single video</option>
                    </select>
                  </div>
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="titles" className="text-xs">
                    Top video titles — TEXT, one per line (need 3+, 6–12 ideal)
                  </Label>
                  <Textarea
                    id="titles"
                    rows={8}
                    placeholder={
                      "Open the competitor channel in YouTube, copy what you see in each video tile, paste here. Example:\n" +
                      "\n" +
                      "Lofi Hip Hop · Late Night Tokyo Study Session\n" +
                      "Rainy Cafe Ambience for Focus and Sleep\n" +
                      "Japanese Chillhop Beats · 1 Hour Mix\n" +
                      "..."
                    }
                    value={titlesText}
                    onChange={(e) => setTitlesText(e.target.value)}
                    className="font-mono text-[11px]"
                  />
                  {(() => {
                    const titleCount = titlesText
                      .split("\n")
                      .filter((s) => s.trim()).length;
                    const looksLikeUrls = titlesText
                      .split("\n")
                      .filter((s) => s.trim())
                      .some((s) =>
                        s.trim().match(/^https?:\/\/|^www\.|youtube\.com|youtu\.be/i),
                      );
                    if (looksLikeUrls) {
                      return (
                        <p className="text-[10px] text-amber-500">
                          ⚠ Looks like URLs. Paste the title TEXT
                          (e.g. "Lofi Hip Hop · Late Night Tokyo"), not
                          the URL.
                        </p>
                      );
                    }
                    if (titleCount === 0) {
                      return (
                        <p className="text-[10px] text-muted-foreground">
                          0 titles — paste at least 3 to enable
                          analysis.
                        </p>
                      );
                    }
                    if (titleCount < 3) {
                      return (
                        <p className="text-[10px] text-amber-500">
                          {titleCount} title{titleCount === 1 ? "" : "s"}{" "}
                          — need {3 - titleCount} more to enable analysis.
                        </p>
                      );
                    }
                    return (
                      <p className="text-[10px] text-green-500">
                        {titleCount} titles — ready to analyse.
                      </p>
                    );
                  })()}
                </div>

                <div className="space-y-1.5">
                  <Label htmlFor="descs" className="text-xs">
                    Sample descriptions (optional, separate with{" "}
                    <code className="rounded bg-muted px-1">---</code> on
                    its own line)
                  </Label>
                  <Textarea
                    id="descs"
                    rows={5}
                    placeholder="Paste 1–4 video descriptions. Improves the rule quality but optional."
                    value={descsText}
                    onChange={(e) => setDescsText(e.target.value)}
                    className="font-mono text-[10px]"
                  />
                </div>

                <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-[11px] text-amber-200/90">
                  <AlertCircle className="mt-0.5 size-3.5 shrink-0" />
                  <p>
                    Nothing is auto-applied. You&apos;ll review each
                    proposed rule one at a time on the next screen and
                    only save when you click Save in the Studio.
                  </p>
                </div>
              </>
            )}

            {proposals && (
              <div className="space-y-4">
                <div className="rounded-md border bg-muted/20 p-3 text-xs">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                    Observations
                  </p>
                  <p className="mt-1">{proposals.observations}</p>
                </div>

                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Wand2 className="size-3.5 text-primary" />
                    Proposed rule additions (
                    {proposals.proposed_rule_additions.length})
                  </h3>
                  {proposals.proposed_rule_additions.map((p, idx) => {
                    const applied = appliedRules.has(idx);
                    return (
                      <div
                        key={idx}
                        className={`rounded-md border p-3 text-xs ${
                          applied
                            ? "border-green-500/40 bg-green-500/5"
                            : "border-border bg-muted/10"
                        }`}
                      >
                        <pre className="whitespace-pre-wrap break-words font-mono text-[11px]">
                          {p.rule_text}
                        </pre>
                        <p className="mt-1 text-[10px] italic text-muted-foreground">
                          {p.rationale}
                        </p>
                        <div className="mt-2 flex justify-end gap-1">
                          <Button
                            size="xs"
                            variant={applied ? "ghost" : "default"}
                            disabled={applied}
                            onClick={() => handleApplyRule(idx, p.rule_text)}
                          >
                            {applied ? "Applied" : "Apply"}
                          </Button>
                        </div>
                      </div>
                    );
                  })}
                </div>

                <Separator />

                <div className="space-y-2">
                  <h3 className="flex items-center gap-2 text-sm font-medium">
                    <Sparkles className="size-3.5 text-primary" />
                    Proposed example titles (
                    {proposals.proposed_example_titles.length})
                  </h3>
                  {proposals.proposed_example_titles.map((t, idx) => (
                    <div
                      key={idx}
                      className="flex items-center gap-2 rounded-md border bg-muted/10 p-2 text-xs"
                    >
                      <p className="flex-1 break-words">{t}</p>
                      <Button
                        size="xs"
                        variant="outline"
                        onClick={() => onApplyExampleTitle(t)}
                      >
                        Use as example title
                      </Button>
                    </div>
                  ))}
                </div>

                {proposals.proposed_keyword_pool.length > 0 && (
                  <>
                    <Separator />
                    <div className="space-y-2">
                      <h3 className="text-sm font-medium">
                        Keyword pool ({proposals.proposed_keyword_pool.length})
                      </h3>
                      <div className="flex flex-wrap gap-1">
                        {proposals.proposed_keyword_pool.map((k, idx) => (
                          <Badge
                            key={idx}
                            variant="secondary"
                            className="text-[10px]"
                          >
                            {k}
                          </Badge>
                        ))}
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        These are seen in the competitor&apos;s titles. Copy
                        any you want to weave into the voice instructions
                        manually.
                      </p>
                    </div>
                  </>
                )}
              </div>
            )}
          </div>
        </ScrollArea>

        <DialogFooter className="border-t bg-muted/40 p-3">
          {!proposals ? (
            <>
              <Button
                variant="ghost"
                onClick={() => onOpenChange(false)}
                disabled={learn.isPending}
              >
                Cancel
              </Button>
              {(() => {
                const titleCount = titlesText
                  .split("\n")
                  .filter((s) => s.trim()).length;
                const urlEmpty = !url.trim();
                const titlesShort = titleCount < 3;
                const tip = urlEmpty
                  ? "Paste the competitor URL first"
                  : titlesShort
                    ? `Paste ${3 - titleCount} more title${titleCount === 2 ? "" : "s"} to enable`
                    : "Run Claude to propose voice rules";
                return (
                  <Button
                    onClick={handleSubmit}
                    disabled={learn.isPending || titlesShort || urlEmpty}
                    title={tip}
                  >
                    {learn.isPending ? (
                      <>
                        <Loader2 className="size-4 animate-spin" />
                        Analysing…
                      </>
                    ) : (
                      <>
                        <Wand2 className="size-4" />
                        Analyse &amp; propose rules
                      </>
                    )}
                  </Button>
                );
              })()}
            </>
          ) : (
            <>
              <Button variant="ghost" onClick={reset}>
                Analyse another URL
              </Button>
              <Button onClick={() => onOpenChange(false)}>
                Done
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
