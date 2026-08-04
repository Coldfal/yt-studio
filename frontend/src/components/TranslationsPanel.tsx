import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Globe,
  Info,
  Languages,
  Loader2,
  RefreshCw,
  Save,
  UploadCloud,
} from "lucide-react";
import { toast } from "sonner";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  useGenerateTranslations,
  usePushTranslationsToYoutube,
  useUpdateProject,
} from "@/hooks/use-projects";
import type { VideoProject } from "@/types/index";

/**
 * Per-language localised title + description editor for a project.
 *
 * Languages: Japanese, Simplified Chinese, Korean, Spanish — matched
 * to the YouTube ``localizations`` API codes the backend writes.
 *
 * Two flows:
 * 1. **Generate** — Claude translates the project's English
 *    ``youtube_title`` + the "top" of ``youtube_description`` (only
 *    the human-facing copy before the TRACKLIST). The tracklist +
 *    hashtags are NOT translated; they get re-attached server-side
 *    at upload time so timestamps + hashtag SEO stay consistent.
 * 2. **Edit + Save** — once generated, every field is editable. Save
 *    PATCHes the project with the merged ``youtube_translations``
 *    object.
 *
 * On upload, the task runner reads ``project.youtube_translations``
 * and ships it as the YouTube ``localizations`` field — non-English
 * viewers see the localised title + description automatically.
 */

import { availableTargetLangs, TRANSLATION_LANGS } from "@/lib/translation-langs";
import { cn } from "@/lib/utils";

type LangEntry = { title: string; description: string };

export function TranslationsPanel({
  project,
  masterLanguage,
}: {
  project: VideoProject;
  /** The channel's master_language. Filters out same-language
   *  translations from the picker (no point translating ko→ko). */
  masterLanguage?: string | null;
}) {
  // Languages this panel offers — pool minus master_language.
  const LANGS = availableTargetLangs(masterLanguage);
  // Local draft state — keeps inputs snappy while the user types and
  // only PATCHes on Save.
  const [draft, setDraft] = useState<Record<string, LangEntry>>(
    () => normalize(project.youtube_translations),
  );
  const [dirty, setDirty] = useState(false);

  // Per-language include/exclude. Persisted per-channel so the
  // operator's pick sticks across projects on the same channel.
  // Default for a brand-new channel = the legacy generation set
  // ({ja, ko, zh-Hans, es} minus master); when the project already
  // has saved translations we treat those codes as "selected" so the
  // operator can immediately see what's there.
  const channelId = project.channel_id;
  const storageKey = channelId
    ? `translations-selected:${channelId}`
    : `translations-selected:no-channel`;
  const defaultSelected: string[] = (() => {
    // If the project already has saved translations, prefer that set
    // — it's what the operator most recently committed to.
    const saved = project.youtube_translations
      ? Object.keys(project.youtube_translations).filter(
          (c) => LANGS.some((l) => l.code === c),
        )
      : [];
    if (saved.length > 0) return saved;
    // Otherwise the legacy four (filtered by master).
    const legacy = ["ja", "ko", "zh-Hans", "es"];
    return LANGS.map((l) => l.code).filter((c) => legacy.includes(c));
  })();
  const [selected, setSelected] = useState<Set<string>>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const arr = JSON.parse(raw) as string[];
        // Keep only codes that are still valid targets (master can change)
        const valid = arr.filter((c) => LANGS.some((l) => l.code === c));
        if (valid.length > 0) return new Set(valid);
      }
    } catch {
      // ignore corrupt localStorage
    }
    return new Set(defaultSelected);
  });
  // Persist whenever the selection changes.
  useEffect(() => {
    try {
      localStorage.setItem(
        storageKey,
        JSON.stringify(Array.from(selected)),
      );
    } catch {
      // ignore quota errors
    }
  }, [selected, storageKey]);

  const toggleLanguage = (code: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  };

  // When the project's translations change from outside (e.g. after
  // Generate completes and the cache invalidates) re-seed the draft —
  // unless the user has unsaved local edits, in which case keep theirs.
  useEffect(() => {
    if (!dirty) {
      setDraft(normalize(project.youtube_translations));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.youtube_translations]);

  const generate = useGenerateTranslations();
  const update = useUpdateProject();
  const pushToYoutube = usePushTranslationsToYoutube();

  const hasAnyTranslation = LANGS.some(
    ({ code }) =>
      selected.has(code) &&
      (draft[code]?.title?.trim() || draft[code]?.description?.trim()),
  );
  const hasEnglishMetadata = !!project.youtube_title;
  const isUploaded = !!project.youtube_video_id;
  const hasSavedTranslations = !!project.youtube_translations
    && Object.keys(project.youtube_translations).length > 0;

  const handleGenerate = async () => {
    const languages = Array.from(selected);
    if (languages.length === 0) {
      toast.error("Pick at least one language to translate to");
      return;
    }
    try {
      await generate.mutateAsync({ id: project.id, languages });
      toast.success(`Translated into ${languages.length} language${languages.length === 1 ? "" : "s"}`);
      setDirty(false);
    } catch (err: unknown) {
      const detail =
        (err as { response?: { data?: { detail?: string } } })?.response?.data
          ?.detail ?? "Translation failed";
      toast.error(typeof detail === "string" ? detail : "Translation failed");
    }
  };

  const handleSave = async () => {
    // Strip empty entries so we don't store junk in the JSON column.
    // Also honour the per-language include set: codes the operator
    // unselected are dropped from the saved payload even if they
    // already had text — gives them a way to "remove" a translation.
    const payload: Record<string, LangEntry> = {};
    for (const { code } of LANGS) {
      if (!selected.has(code)) continue;
      const e = draft[code];
      if (e && (e.title.trim() || e.description.trim())) {
        payload[code] = { title: e.title.trim(), description: e.description.trim() };
      }
    }
    try {
      await update.mutateAsync({
        id: project.id,
        // backend accepts null to clear, but our UI just sends an
        // empty object when everything's been deleted.
        youtube_translations:
          Object.keys(payload).length > 0 ? payload : null,
      } as Partial<VideoProject> & { id: number });
      toast.success("Translations saved");
      setDirty(false);
    } catch {
      toast.error("Failed to save translations");
    }
  };

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Languages className="size-4 text-primary" />
          Translations
          {hasAnyTranslation && (
            <Badge variant="outline" className="ml-1 text-[10px]">
              {Object.keys(draft).filter(
                (k) =>
                  selected.has(k) &&
                  (draft[k]?.title?.trim() || draft[k]?.description?.trim()),
              ).length}{" "}
              languages
            </Badge>
          )}
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Localised title + description sent to YouTube's{" "}
          <code className="rounded bg-muted px-1 py-0.5 text-[10px]">
            localizations
          </code>{" "}
          API on upload. Only the copy above the tracklist gets
          translated — the tracklist + hashtags are re-attached
          unchanged from the English version.
        </p>
      </CardHeader>

      <CardContent className="space-y-4">
        {/* Language picker — chip toggles. Click to include/exclude.
            Selection persists per-channel in localStorage so the
            operator's typical lane (e.g. KR+JP for yomii) sticks. */}
        <div className="space-y-1.5">
          <Label className="text-xs">Translate to</Label>
          <div className="flex flex-wrap gap-1.5">
            {LANGS.map(({ code, label, flag }) => {
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
                  title={on ? `Excludes ${label} from translation` : `Includes ${label} in translation`}
                  aria-pressed={on}
                >
                  <span aria-hidden>{flag}</span>
                  <span>{label}</span>
                  <span className="text-[10px] opacity-60">{code}</span>
                </button>
              );
            })}
          </div>
          {selected.size === 0 && (
            <p className="text-[11px] text-amber-500">
              No languages selected — pick at least one to generate.
            </p>
          )}
        </div>

        {/* Generate / regenerate row */}
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2">
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <Globe className="size-3.5" />
            {hasAnyTranslation ? (
              <span>Already generated. Re-run to refresh from the current copy.</span>
            ) : hasEnglishMetadata ? (
              <span>
                Click Generate to translate into{" "}
                {selected.size === 0
                  ? "the selected"
                  : `${selected.size} language${selected.size === 1 ? "" : "s"}`}{" "}
                with Claude.
              </span>
            ) : (
              <span>Set the title + description first, then come back.</span>
            )}
          </div>
          <Button
            size="sm"
            variant={hasAnyTranslation ? "outline" : "default"}
            onClick={handleGenerate}
            disabled={!hasEnglishMetadata || generate.isPending || selected.size === 0}
          >
            {generate.isPending ? (
              <>
                <Loader2 className="size-3.5 animate-spin" /> Translating…
              </>
            ) : hasAnyTranslation ? (
              <>
                <RefreshCw className="size-3.5" /> Regenerate
              </>
            ) : (
              <>
                <Languages className="size-3.5" /> Generate
              </>
            )}
          </Button>
        </div>

        {/* Per-language editors — only render selected langs. Excluded
            ones stay in draft but are hidden until re-toggled, so the
            operator can flip a lang off and back on without losing
            text mid-edit. */}
        <div className="space-y-3">
          {LANGS.filter(({ code }) => selected.has(code)).map(({ code, label, flag }) => {
            const entry = draft[code] ?? { title: "", description: "" };
            return (
              <div
                key={code}
                className="space-y-2 rounded-md border border-border/40 bg-background p-3"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2 text-sm font-medium">
                    <span aria-hidden>{flag}</span>
                    <span>{label}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {code}
                    </Badge>
                  </div>
                  {(entry.title || entry.description) && (
                    <Button
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        setDraft((prev) => ({
                          ...prev,
                          [code]: { title: "", description: "" },
                        }));
                        setDirty(true);
                      }}
                      title="Clear this language"
                    >
                      Clear
                    </Button>
                  )}
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`tr-title-${code}`} className="text-xs">
                    Title
                  </Label>
                  <Input
                    id={`tr-title-${code}`}
                    value={entry.title}
                    onChange={(e) => {
                      setDraft((prev) => ({
                        ...prev,
                        [code]: {
                          ...(prev[code] ?? { title: "", description: "" }),
                          title: e.target.value,
                        },
                      }));
                      setDirty(true);
                    }}
                    placeholder={
                      project.youtube_title
                        ? `Localised title for ${label}`
                        : "Generate metadata first"
                    }
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor={`tr-desc-${code}`} className="text-xs">
                    Description (top portion only — no tracklist or hashtags)
                  </Label>
                  <Textarea
                    id={`tr-desc-${code}`}
                    value={entry.description}
                    onChange={(e) => {
                      setDraft((prev) => ({
                        ...prev,
                        [code]: {
                          ...(prev[code] ?? { title: "", description: "" }),
                          description: e.target.value,
                        },
                      }));
                      setDirty(true);
                    }}
                    rows={5}
                    placeholder={`Hook + playlist pitch in ${label}`}
                  />
                </div>
              </div>
            );
          })}
        </div>

        {/* Helper note: explain that the tracklist + hashtags get
            stitched on at upload time so the user doesn't think the
            translation is incomplete. */}
        {hasAnyTranslation && (
          <div className="flex gap-2 rounded-md border border-border/40 bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            <Info className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Only the top of the description is translated. At upload time
              we stitch on the same English tracklist + hashtags so timestamps
              + hashtag SEO carry across locales — non-English viewers see
              the localised hook on top, then the same English tracklist
              underneath.
            </span>
          </div>
        )}

        {/* Save / saved-state row + Push-to-YouTube for uploaded videos.
            When nothing is dirty we deliberately do NOT show a disabled
            "Save" button — translations are auto-saved by the Generate
            endpoint, so a disabled button just looks broken. Show a
            clear "Saved" pill instead. */}
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="text-[11px] text-muted-foreground">
            {dirty ? (
              <span className="flex items-center gap-1.5 text-amber-500">
                <Save className="size-3" /> You have unsaved edits
              </span>
            ) : hasSavedTranslations ? (
              <span className="flex items-center gap-1.5 text-emerald-500">
                <CheckCircle2 className="size-3" />
                Saved on this project
                {!isUploaded && " — applied automatically on next upload"}
              </span>
            ) : (
              <span>No translations saved yet</span>
            )}
          </div>

          <div className="flex items-center gap-2">
            {dirty && (
              <Button
                size="sm"
                onClick={handleSave}
                disabled={update.isPending}
              >
                {update.isPending ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> Saving…
                  </>
                ) : (
                  <>
                    <Save className="size-3.5" /> Save translations
                  </>
                )}
              </Button>
            )}
            {/* Push to YouTube — only meaningful for already-uploaded
                videos. For drafts the upload pipeline applies them
                automatically, so showing this button there would be
                misleading. */}
            {isUploaded && hasSavedTranslations && (
              <Button
                size="sm"
                variant={dirty ? "outline" : "default"}
                onClick={async () => {
                  // If the user has unsaved edits, save first so the
                  // push uses the latest text — otherwise we'd push
                  // stale translations.
                  if (dirty) {
                    try {
                      await handleSave();
                    } catch {
                      return;
                    }
                  }
                  try {
                    await pushToYoutube.mutateAsync(project.id);
                    toast.success("Translations pushed to YouTube");
                  } catch (err: unknown) {
                    const detail =
                      (err as { response?: { data?: { detail?: string } } })
                        ?.response?.data?.detail ?? "Push failed";
                    toast.error(
                      typeof detail === "string" ? detail : "Push failed",
                    );
                  }
                }}
                disabled={pushToYoutube.isPending}
                title="Update the existing YouTube video with these translations"
              >
                {pushToYoutube.isPending ? (
                  <>
                    <Loader2 className="size-3.5 animate-spin" /> Pushing…
                  </>
                ) : (
                  <>
                    <UploadCloud className="size-3.5" />
                    Push to YouTube
                  </>
                )}
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

/** Build a record keyed by every supported language code, even when
 *  the server hasn't filled it in — keeps the editors stable so React
 *  doesn't have to mount/unmount when generation completes. */
function normalize(
  raw: VideoProject["youtube_translations"],
): Record<string, LangEntry> {
  const out: Record<string, LangEntry> = {};
  // Iterate the full pool (not the master-filtered set) so the draft
  // shape is stable when master_language changes and so legacy rows
  // with codes outside the current target list still surface.
  for (const { code } of TRANSLATION_LANGS) {
    const entry = (raw as Record<string, LangEntry> | null | undefined)?.[code];
    out[code] = {
      title: entry?.title ?? "",
      description: entry?.description ?? "",
    };
  }
  return out;
}
