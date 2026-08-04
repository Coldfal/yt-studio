/**
 * Shared YouTube localization language pool.
 *
 * Used by:
 *  - DashboardPage's Quick Generate "Auto-translate" chips
 *  - TranslationsPanel's per-project picker
 *
 * The list is the practical subset of YouTube's supported codes that
 * actually matters for our lofi / chillrap / korean-RnB lanes. Adding
 * more codes is fine — YouTube's localizations API accepts any
 * BCP-47-ish code it recognises.
 *
 * Order is rough audience priority: en first (biggest pool), then
 * East Asia (ja/ko/zh), then Latin/Iberian, then high-growth SE Asia.
 */
export interface TranslationLang {
  readonly code: string;
  readonly label: string;
  readonly flag: string;
}

export const TRANSLATION_LANGS: readonly TranslationLang[] = [
  { code: "en", label: "English", flag: "🇬🇧" },
  { code: "ja", label: "Japanese", flag: "🇯🇵" },
  { code: "ko", label: "Korean", flag: "🇰🇷" },
  { code: "zh-Hans", label: "Simplified Chinese", flag: "🇨🇳" },
  { code: "es", label: "Spanish", flag: "🇪🇸" },
  { code: "pt", label: "Portuguese", flag: "🇵🇹" },
  { code: "id", label: "Indonesian", flag: "🇮🇩" },
  { code: "vi", label: "Vietnamese", flag: "🇻🇳" },
] as const;

/**
 * Filter out a channel's master language from the available targets —
 * translating ko→ko is a no-op + clutters the picker. Pass the
 * channel's ``master_language`` (default ``"en"``).
 */
export function availableTargetLangs(
  masterLanguage: string | null | undefined,
): readonly TranslationLang[] {
  const master = (masterLanguage || "en").trim();
  return TRANSLATION_LANGS.filter((l) => l.code !== master);
}
