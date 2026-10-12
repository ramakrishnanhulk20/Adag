"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useLocale, useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { LOCALES, LOCALE_NAMES, LOCALE_SHORT, localeCookieString, localeOf, type Locale } from "@/i18n/locales";

type Props = {
  // "nav": the compact button in a header, opening a small menu. "row": the five names in a line, for footers and menus.
  variant: "nav" | "row";
  className?: string;
  // Runs after a choice, so a phone menu can close itself.
  onChosen?: () => void;
};

export function LanguageSwitcher({ variant, className = "", onChosen }: Props) {
  const t = useTranslations("switcher");
  const current = localeOf(useLocale());
  const router = useRouter();

  // The cookie is the one record of the choice (I1); the refresh re-renders the same URL in the new language and
  // keeps the scroll position, so a shared link never changes.
  const choose = (next: Locale) => {
    if (next !== current) {
      document.cookie = localeCookieString(next);
      router.refresh();
    }
    onChosen?.();
  };

  if (variant === "row") {
    return (
      <ul role="list" aria-label={t("label")} className={`flex flex-wrap gap-x-6 gap-y-1 ${className}`}>
        {LOCALES.map((locale) => (
          <li key={locale}>
            <button
              type="button"
              lang={locale}
              aria-current={locale === current ? "true" : undefined}
              onClick={() => choose(locale)}
              className={`link-draw tap-target type-label transition-colors duration-200 hover:text-gold ${locale === current ? "text-gold" : "text-text/88"}`}
              data-lang={locale}
            >
              {LOCALE_NAMES[locale]}
            </button>
          </li>
        ))}
      </ul>
    );
  }
  return <NavMenu current={current} onChoose={choose} label={t("label")} className={className} />;
}

function NavMenu({ current, onChoose, label, className }: { current: Locale; onChoose: (l: Locale) => void; label: string; className: string }) {
  const [open, setOpen] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const items = useRef<(HTMLButtonElement | null)[]>([]);

  useEffect(() => {
    if (!open) return;
    // Focus lands on the current language, so one Escape or Enter leaves everything as it was.
    items.current[LOCALES.indexOf(current)]?.focus();
    const onDown = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        button.current?.focus();
      }
    };
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, current]);

  const move = (e: React.KeyboardEvent, index: number) => {
    const last = LOCALES.length - 1;
    const to = e.key === "ArrowDown" ? (index === last ? 0 : index + 1) : e.key === "ArrowUp" ? (index === 0 ? last : index - 1) : e.key === "Home" ? 0 : e.key === "End" ? last : null;
    if (to === null) return;
    e.preventDefault();
    items.current[to]?.focus();
  };

  return (
    <div ref={root} className={`relative ${className}`}>
      <button
        ref={button}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={menuId}
        aria-label={label}
        lang={current}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            setOpen(true);
          }
        }}
        className="link-draw type-ui inline-flex min-h-11 items-center px-1 text-text/88 transition-colors duration-200 hover:text-text md:min-h-0 md:px-0"
        data-lang-switcher
      >
        {LOCALE_SHORT[current]}
      </button>
      <AnimatePresence>
        {open && (
          <motion.ul
            id={menuId}
            role="menu"
            aria-label={label}
            className="absolute right-0 top-full z-50 mt-2 min-w-[11rem] rounded-[8px] border border-rule bg-raised p-1 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.5)]"
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.16, ease: [0.16, 1, 0.3, 1] }}
          >
            {LOCALES.map((locale, i) => (
              <li key={locale} role="none">
                <button
                  ref={(el) => {
                    items.current[i] = el;
                  }}
                  type="button"
                  role="menuitemradio"
                  aria-checked={locale === current}
                  lang={locale}
                  tabIndex={-1}
                  onClick={() => {
                    setOpen(false);
                    onChoose(locale);
                  }}
                  onKeyDown={(e) => move(e, i)}
                  className={`type-ui flex min-h-11 w-full items-center rounded-[6px] px-3 text-left transition-colors duration-200 md:min-h-10 ${
                    locale === current ? "text-gold" : "text-text/88 hover:bg-surface hover:text-text"
                  }`}
                  data-lang={locale}
                >
                  {LOCALE_NAMES[locale]}
                </button>
              </li>
            ))}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
