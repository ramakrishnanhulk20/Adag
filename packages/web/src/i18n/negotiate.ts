import { match } from "@formatjs/intl-localematcher";
import { DEFAULT_LOCALE, LOCALES, isLocale, type Locale } from "./locales";

// A language tag as RFC 5646 spells it. Anything else in an Accept-Language header is dropped before the matcher
// sees it, so a malformed header can neither throw nor be reflected anywhere (I1).
const TAG = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/;
const MAX_TAGS = 20;

export function parseAcceptLanguage(header: string | null | undefined): string[] {
  if (!header || header.length > 2_000) return [];
  const ranked: { tag: string; q: number; at: number }[] = [];
  header.split(",").forEach((part, at) => {
    const [rawTag, ...params] = part.trim().split(";");
    const tag = rawTag?.trim() ?? "";
    if (!TAG.test(tag)) return;
    let q = 1;
    for (const p of params) {
      const m = /^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(p);
      if (m) q = Number(m[1]);
    }
    if (q > 0) ranked.push({ tag, q, at });
  });
  return ranked
    .sort((a, b) => b.q - a.q || a.at - b.at)
    .slice(0, MAX_TAGS)
    .map((r) => r.tag);
}

// Every Chinese variant is served the one Chinese catalog (Ram's decision), whatever script or region it names.
const unifyChinese = (tag: string) => (tag.split("-")[0]!.toLowerCase() === "zh" ? "zh-CN" : tag);

// The cookie wins when it names one of the five. Otherwise the best match of Accept-Language, then English.
export function resolveLocale(cookie: string | null | undefined, acceptLanguage: string | null | undefined): Locale {
  if (isLocale(cookie)) return cookie;
  const requested = parseAcceptLanguage(acceptLanguage).map(unifyChinese);
  if (requested.length === 0) return DEFAULT_LOCALE;
  try {
    const found = match(requested, LOCALES, DEFAULT_LOCALE);
    return isLocale(found) ? found : DEFAULT_LOCALE;
  } catch {
    return DEFAULT_LOCALE;
  }
}
