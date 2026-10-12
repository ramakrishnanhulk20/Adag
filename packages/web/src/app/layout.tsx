import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { getMessages, getTranslations } from "next-intl/server";
import "lenis/dist/lenis.css";
import "./globals.css";
import { body, cjkFontClass, display, mono } from "./fonts";
import { Grain } from "@/components/Grain";
import { MotionPreferences } from "@/components/MotionPreferences";
import { SmoothScroll } from "@/components/SmoothScroll";
import { ThemeProvider } from "@/components/ThemeProvider";
import { OG_LOCALE } from "@/i18n/locales";
import type { Messages } from "@/i18n/messages";
import { IntlProvider } from "@/i18n/Provider";
import { getLocale } from "@/i18n/server";
import { Providers } from "@/lib/wallet/Providers";
import { THEME_COOKIE, parseThemeChoice, serverResolvedTheme, themeHeadScript } from "@/lib/theme";

// Absolute links in shared cards need the real origin: set explicitly, else Vercel's production domain, else local dev.
function siteUrl(): URL {
  if (process.env.NEXT_PUBLIC_SITE_URL) return new URL(process.env.NEXT_PUBLIC_SITE_URL);
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return new URL(`https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`);
  return new URL("http://localhost:3000");
}

// Titles and descriptions follow the visitor's language; the Open Graph and Twitter images stay English.
export async function generateMetadata(): Promise<Metadata> {
  const [t, locale] = await Promise.all([getTranslations("meta"), getLocale()]);
  const title = t("site.title");
  const description = t("site.description");
  return {
    metadataBase: siteUrl(),
    title: { default: title, template: t("site.template") },
    description,
    applicationName: "Adag",
    openGraph: {
      type: "website",
      siteName: "Adag",
      locale: OG_LOCALE[locale],
      title,
      description,
      url: "/",
    },
    twitter: {
      card: "summary_large_image",
      title,
      description,
    },
  };
}

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const [cookieStore, locale, messages] = await Promise.all([cookies(), getLocale(), getMessages()]);
  const choice = parseThemeChoice(cookieStore.get(THEME_COOKIE)?.value);

  return (
    <html
      lang={locale}
      data-theme={serverResolvedTheme(choice)}
      data-theme-choice={choice}
      className={`${display.variable} ${body.variable} ${mono.variable} ${cjkFontClass}`}
      // The head script may change data-theme before React hydrates, which is the whole point of it.
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeHeadScript }} />
      </head>
      <body className="bg-bg text-text type-body">
        <IntlProvider locale={locale} messages={messages as Messages}>
          <ThemeProvider initialChoice={choice}>
            <MotionPreferences>
              <SmoothScroll />
              <Providers>{children}</Providers>
              <Grain />
            </MotionPreferences>
          </ThemeProvider>
        </IntlProvider>
      </body>
    </html>
  );
}
