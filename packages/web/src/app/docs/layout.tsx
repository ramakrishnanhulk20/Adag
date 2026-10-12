import "./docs.css";
import { DocsLayout } from "fumadocs-ui/layouts/docs";
import { RootProvider } from "fumadocs-ui/provider/next";
import { getTranslations } from "next-intl/server";
import { ThemeControl } from "@/components/ThemeControl";
import { getLocale } from "@/i18n/server";
import { source } from "@/lib/source";

// The docs are written in English and stay so; the chrome around them follows the visitor's language, and a visitor
// reading in another language is told, once, at the top of the page.
export default async function Layout({ children }: { children: React.ReactNode }) {
  const [t, locale] = await Promise.all([getTranslations("docs"), getLocale()]);
  return (
    // next-themes stays off: Adag's own head script and ThemeControl already set data-theme, and docs.css follows it.
    <RootProvider theme={{ enabled: false }} search={{ options: { api: "/docs/api/search" } }}>
      <DocsLayout
        tree={source.getPageTree()}
        nav={{
          title: <span className="font-display text-[20px] font-semibold tracking-[0.08em]">ADAG</span>,
          url: "/",
        }}
        themeSwitch={{ enabled: false }}
        sidebar={{
          // Fumadocs places the footer in a list of sidebar parts, so it needs its own key.
          footer: (
            <div key="adag-theme" className="flex items-center gap-3 pt-3">
              <ThemeControl variant="cycle" tipAlign="start" />
              <span className="type-micro text-muted">{t("theme")}</span>
            </div>
          ),
        }}
      >
        <div lang="en" className="contents">
          {locale !== "en" && (
            <p lang={locale} className="docs-language-note type-body mx-auto mt-6 w-full max-w-[860px] px-6 text-muted" data-docs-english>
              {t("englishOnly")}
            </p>
          )}
          {children}
        </div>
      </DocsLayout>
    </RootProvider>
  );
}
