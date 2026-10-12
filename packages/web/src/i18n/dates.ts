// Dates and words follow the language; every number keeps the English formatters (Ram's decision). English keeps
// the exact en-GB formats the app has always used, so its output is byte for byte what it was (I6).
import { INTL_TAG, type Locale } from "./locales";

const cache = new Map<string, Intl.DateTimeFormat>();

function formatter(locale: Locale, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${locale}:${JSON.stringify(options)}`;
  let f = cache.get(key);
  if (!f) {
    f = new Intl.DateTimeFormat(INTL_TAG[locale], options);
    cache.set(key, f);
  }
  return f;
}

const DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" };
const DATE_TIME: Intl.DateTimeFormatOptions = { ...DATE, hour: "2-digit", minute: "2-digit", timeZoneName: "short" };
const DAY_MONTH: Intl.DateTimeFormatOptions = { day: "numeric", month: "short" };
const LOCAL_DATE: Intl.DateTimeFormatOptions = { day: "numeric", month: "short", year: "numeric" };

const toDate = (seconds: bigint | number) => new Date(Number(seconds) * 1000);

// A calendar day in UTC, as bill(id) stores it: "11 Oct 2026" in English.
export const dateIn = (locale: Locale, seconds: bigint | number) => formatter(locale, DATE).format(toDate(seconds));
export const dateTimeIn = (locale: Locale, seconds: bigint | number) => formatter(locale, DATE_TIME).format(toDate(seconds));
// Browser-side dates in the visitor's own time zone, as the alerts panel and the guard summary show them.
export const localDateIn = (locale: Locale, ms: number) => formatter(locale, LOCAL_DATE).format(new Date(ms));
export const localDayMonthIn = (locale: Locale, ms: number) => formatter(locale, DAY_MONTH).format(new Date(ms));
