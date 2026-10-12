// Plain TypeScript with no imports, so the unit tests and lib/alerts can load it under bare Node.
export const LOCALES = ["en", "zh-CN", "ko", "ja", "es"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";
export const LOCALE_COOKIE = "adag-lang";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

// I1: the only way a value from a cookie, a header or a store becomes a locale. Anything else is English.
export function isLocale(value: unknown): value is Locale {
  return typeof value === "string" && (LOCALES as readonly string[]).includes(value);
}

export function localeOf(value: unknown): Locale {
  return isLocale(value) ? value : DEFAULT_LOCALE;
}

// Each language named in its own script, for the switcher.
export const LOCALE_NAMES: Record<Locale, string> = { en: "English", "zh-CN": "中文", ko: "한국어", ja: "日本語", es: "Español" };
// The compact form on the nav button.
export const LOCALE_SHORT: Record<Locale, string> = { en: "EN", "zh-CN": "中文", ko: "한국어", ja: "日本語", es: "ES" };
// Open Graph wants an underscore form; "en" stays as it was before the switcher existed.
export const OG_LOCALE: Record<Locale, string> = { en: "en", "zh-CN": "zh_CN", ko: "ko_KR", ja: "ja_JP", es: "es_LA" };
// What Intl receives for dates and words; numbers keep the English formatters everywhere (Ram's decision).
export const INTL_TAG: Record<Locale, string> = { en: "en-GB", "zh-CN": "zh-CN", ko: "ko-KR", ja: "ja-JP", es: "es-419" };

export function localeCookieString(locale: Locale): string {
  return `${LOCALE_COOKIE}=${locale}; Path=/; Max-Age=${ONE_YEAR_SECONDS}; SameSite=Lax`;
}
