"use client";

import { NextIntlClientProvider } from "next-intl";
import { englishString, type Messages } from "./messages";
import type { Locale } from "./locales";

// The browser side of I7: the same English fallback the server uses, so a key the catalog lacks never shows raw.
export function IntlProvider({ locale, messages, children }: { locale: Locale; messages: Messages; children: React.ReactNode }) {
  return (
    <NextIntlClientProvider
      locale={locale}
      messages={messages}
      timeZone="UTC"
      onError={() => {}}
      getMessageFallback={({ namespace, key }) => englishString(namespace ? `${namespace}.${key}` : key) ?? ""}
    >
      {children}
    </NextIntlClientProvider>
  );
}
