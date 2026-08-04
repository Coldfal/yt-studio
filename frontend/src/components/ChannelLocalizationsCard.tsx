import { useEffect, useState } from "react";
import { CheckCircle2, Globe, Languages, Loader2, Save, UploadCloud } from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { TRANSLATION_LANGS } from "@/lib/translation-langs";
import { useUpdateChannel, useSyncChannelBranding } from "@/hooks/use-channels";
import type { Channel } from "@/types/index";

/**
 * Channel-level localizations editor — localized channel title +
 * description per language, the channel's "About" page in each locale.
 *
 * Distinct from TranslationsPanel (which does per-VIDEO translations).
 * This is the channel itself. Two actions:
 *  1. **Save** — PATCHes ``channel.channel_localizations`` (+ the
 *     country saved on the Brand Profile form) into the DB.
 *  2. **Push to YouTube** — fires ``channels().update()`` via the
 *     sync-youtube-branding endpoint, applying the saved country +
 *     localizations to the live channel.
 *
 * The Push button reads PERSISTED DB values, so unsaved edits are
 * saved first (TranslationsPanel's save-then-push pattern).
 */

type LocEntry = { title: string; description: string };

function normalize(
  raw: Channel["channel_localizations"],
): Record<string, LocEntry> {
  const out: Record<string, LocEntry> = {};
  for (const { code } of TRANSLATION_LANGS) {
    const entry = raw?.[code];
    out[code] = {
      title: entry?.title ?? "",
      description: entry?.description ?? "",
    };
  }
  return out;
}

export function ChannelLocalizationsCard({ channel }: { channel: Channel }) {
  const [draft, setDraft] = useState<Record<string, LocEntry>>(() =>
    normalize(channel.channel_localizations),
  );
  const [dirty, setDirty] = useState(false);

  // Which languages have an editor card shown. Default = languages
  // that already have content; operator toggles others on via chips.
  const [selected, setSelected] = useState<Set<string>>(() => {
    const withContent = TRANSLATION_LANGS.map((l) => l.code).filter(
      (c) =>
        channel.channel_localizations?.[c]?.title?.trim() ||
        channel.channel_localizations?.[c]?.description?.trim(),
    );
    return new Set(withContent);
  });

  // Re-seed when the channel changes from outside (post-save refetch),
  // unless the operator has unsaved edits.
  useEffect(() => {
    if (!dirty) setDraft(normalize(channel.channel_localizations));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.channel_localizations]);

  const update = useUpdateChannel();
  const syncBranding = useSyncChannelBranding();

  const toggleLanguage = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  const buildPayload = (): Record<string, LocEntry> | null => {
    const payload: Record<string, LocEntry> = {};
    for (const { code } of TRANSLATION_LANGS) {
      if (!selected.has(code)) continue;
      const e = draft[code];
      if (e && (e.title.trim() || e.description.trim())) {
        payload[code] = {
          title: e.title.trim(),
          description: e.description.trim(),
        };
      }
    }
    return Object.keys(payload).length > 0 ? payload : null;
  };

  const handleSave = async () => {
    try {
      await update.mutateAsync({
        id: channel.id,
        channel_localizations: buildPayload(),
      } as Partial<Channel> & { id: number });
      toast.success("Channel localizations saved");
      setDirty(false);
    } catch {
      toast.error("Failed to save channel localizations");
    }
  };

  const handlePush = async () => {
    // Save first so the endpoint (which reads persisted DB values)
    // pushes the latest edits, not stale ones.
    if (dirty) {
      try {
        await handleSave();
      } catch {
        return;
      }
    }
    try {
      const res = await syncBranding.mutateAsync(channel.id);
      const langs = res.localizations_pushed.length
        ? res.localizations_pushed.join(", ")
        : "none";
      toast.success(
        `Pushed to YouTube — country: ${res.country ?? "unchanged"}, ` +
          `localizations: ${langs}`,
      );
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Push failed";
      toast.error(typeof detail === "string" ? detail : "Push failed");
    }
  };

  const hasAny = TRANSLATION_LANGS.some(
    ({ code }) =>
      selected.has(code) &&
      (draft[code]?.title?.trim() || draft[code]?.description?.trim()),
  );

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Globe className="size-4 text-primary" />
          Channel localizations
          {!channel.youtube_channel_id && (
            <Badge variant="outline" className="ml-1 text-[10px]">
              Not connected to YouTube
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Localized channel title + description (the channel's About page
          in each language). Save here, then{" "}
          <strong>Push to YouTube</strong> to apply these plus the
          country from the Brand Profile form above. YouTube caps each
          description at ~1000 characters.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Language picker chips */}
        <div className="space-y-1.5">
          <Label className="text-xs">Languages</Label>
          <div className="flex flex-wrap gap-1.5">
            {TRANSLATION_LANGS.map(({ code, label, flag }) => {
              const on = selected.has(code);
              return (
                <button
                  key={code}
                  type="button"
                  onClick={() => toggleLanguage(code)}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs transition",
                    on
                      ? "border-primary/60 bg-primary/15 text-primary hover:bg-primary/25"
                      : "border-border/60 bg-background text-muted-foreground hover:bg-accent",
                  )}
                  aria-pressed={on}
                >
                  <span aria-hidden>{flag}</span>
                  <span>{label}</span>
                  <span className="text-[10px] opacity-60">{code}</span>
                </button>
              );
            })}
          </div>
        </div>

        {/* Per-language editors */}
        <div className="space-y-3">
          {TRANSLATION_LANGS.filter(({ code }) => selected.has(code)).map(
            ({ code, label, flag }) => {
              const entry = draft[code] ?? { title: "", description: "" };
              return (
                <div
                  key={code}
                  className="space-y-2 rounded-md border border-border/40 bg-background p-3"
                >
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span aria-hidden>{flag}</span>
                    <span>{label}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {code}
                    </Badge>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`cl-title-${code}`} className="text-xs">
                      Channel title
                    </Label>
                    <Input
                      id={`cl-title-${code}`}
                      value={entry.title}
                      onChange={(e) => {
                        setDraft((prev) => ({
                          ...prev,
                          [code]: { ...entry, title: e.target.value },
                        }));
                        setDirty(true);
                      }}
                      placeholder={`Channel name in ${label}`}
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`cl-desc-${code}`} className="text-xs">
                      Channel description (≤1000 chars)
                    </Label>
                    <Textarea
                      id={`cl-desc-${code}`}
                      value={entry.description}
                      onChange={(e) => {
                        setDraft((prev) => ({
                          ...prev,
                          [code]: { ...entry, description: e.target.value },
                        }));
                        setDirty(true);
                      }}
                      rows={5}
                      placeholder={`About-page copy in ${label}`}
                    />
                    <p className="text-[11px] text-muted-foreground">
                      {entry.description.length} / 1000 characters
                    </p>
                  </div>
                </div>
              );
            },
          )}
        </div>

        {/* Save + push row */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground">
            {dirty ? (
              <span className="flex items-center gap-1.5 text-amber-500">
                <Save className="size-3" /> Unsaved edits
              </span>
            ) : hasAny ? (
              <span className="flex items-center gap-1.5 text-emerald-500">
                <CheckCircle2 className="size-3" /> Saved
              </span>
            ) : (
              <span>No channel localizations yet</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {dirty && (
              <Button size="sm" onClick={handleSave} disabled={update.isPending}>
                {update.isPending ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> Saving…
                  </>
                ) : (
                  <>
                    <Save className="size-3.5" /> Save
                  </>
                )}
              </Button>
            )}
            <Button
              size="sm"
              variant={dirty ? "outline" : "default"}
              onClick={handlePush}
              disabled={
                !channel.youtube_channel_id ||
                syncBranding.isPending ||
                update.isPending
              }
              title={
                channel.youtube_channel_id
                  ? "Push country + localizations to the live YouTube channel"
                  : "Connect this channel to YouTube first"
              }
            >
              {syncBranding.isPending ? (
                <>
                  <Loader2 className="size-3.5 animate-spin" /> Pushing…
                </>
              ) : (
                <>
                  <UploadCloud className="size-3.5" /> Push to YouTube
                </>
              )}
            </Button>
          </div>
        </div>

        <div className="flex gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
          <Languages className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Push also applies the channel <strong>country</strong> and{" "}
            <strong>master language</strong> (set on the Brand Profile form
            above — save that first). It's a manual action: YouTube's
            channel update is quota-heavy, so it never runs automatically.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
