import { cookies, headers } from "next/headers";
import { getRequestConfig } from "next-intl/server";
import { LOCALE_COOKIE } from "./locales";
import { englishString, loadMessages } from "./messages";
import { resolveLocale } from "./negotiate";

// Without i18n routing: the locale comes from the adag-lang cookie, else the browser's Accept-Language, else English
// (I1). URLs never change, so a shared /bill/12 opens in the reader's own language.
export default getRequestConfig(async () => {
  const [cookieStore, headerStore] = await Promise.all([cookies(), headers()]);
  const locale = resolveLocale(cookieStore.get(LOCALE_COOKIE)?.value, headerStore.get("accept-language"));
  return {
    locale,
    messages: await loadMessages(locale),
    timeZone: "UTC",
    // A missing key or a bad format shows the English string, never a raw key (I7). The error itself is not logged:
    // the catalog test is where a missing key is caught.
    onError: () => {},
    getMessageFallback: ({ namespace, key }) => englishString(namespace ? `${namespace}.${key}` : key) ?? "",
  };
});
