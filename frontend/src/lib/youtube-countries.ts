/**
 * YouTube channel country pool (ISO 3166-1 alpha-2).
 *
 * Used by the channel Brand Profile tab's country picker. A fixed
 * Select list (vs. a free-text input) prevents invalid-code 400s from
 * YouTube's `channels().update()`.
 *
 * The list is the practical subset that matters for our channels'
 * markets — Japan / Korea / US / etc. Adding more is fine; YouTube
 * accepts any valid ISO 3166-1 alpha-2 code.
 */
export interface YoutubeCountry {
  readonly code: string;
  readonly label: string;
  readonly flag: string;
}

export const YOUTUBE_COUNTRIES: readonly YoutubeCountry[] = [
  { code: "JP", label: "Japan", flag: "🇯🇵" },
  { code: "KR", label: "South Korea", flag: "🇰🇷" },
  { code: "US", label: "United States", flag: "🇺🇸" },
  { code: "GB", label: "United Kingdom", flag: "🇬🇧" },
  { code: "CA", label: "Canada", flag: "🇨🇦" },
  { code: "AU", label: "Australia", flag: "🇦🇺" },
  { code: "DE", label: "Germany", flag: "🇩🇪" },
  { code: "FR", label: "France", flag: "🇫🇷" },
  { code: "ES", label: "Spain", flag: "🇪🇸" },
  { code: "BR", label: "Brazil", flag: "🇧🇷" },
  { code: "ID", label: "Indonesia", flag: "🇮🇩" },
  { code: "VN", label: "Vietnam", flag: "🇻🇳" },
  { code: "TW", label: "Taiwan", flag: "🇹🇼" },
] as const;
