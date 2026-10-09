"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ThemeControl } from "@/components/ThemeControl";
import { ConnectButton } from "./ConnectButton";
import { WalletNotice } from "./WalletNotice";

const SOLID_AFTER_PX = 24;

const LINKS = [
  { label: "Pay a bill", href: "/pay" },
  { label: "Write a bill", href: "/bill/new" },
  { label: "Your wallet", href: "/app" },
  { label: "Loan guard", href: "/app/protect" },
  { label: "Docs", href: "/docs" },
];

export function AppNav() {
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const pathname = usePathname();
  const sheetId = useId();
  const sheet = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setSolid(window.scrollY > SOLID_AFTER_PX);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  // Navigating closes the sheet.
  useEffect(() => setOpen(false), [pathname]);

  // While open: Escape closes, Tab stays inside the sheet and its toggle, and the page underneath does not scroll.
  useEffect(() => {
    if (!open) return;
    const toggleButton = toggle.current;
    const focusables = () => [toggleButton, ...(sheet.current?.querySelectorAll<HTMLElement>("a, button") ?? [])].filter(Boolean) as HTMLElement[];
    focusables()[1]?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setOpen(false);
        toggleButton?.focus();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    const overflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = overflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // "/bill/new" and "/app" have pages under them with their own links, so those two match exactly.
  const current = (href: string) => (href === "/bill/new" || href === "/app" ? pathname === href : pathname === href || pathname.startsWith(`${href}/`));

  return (
    <>
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-[background-color,border-color,backdrop-filter] duration-300 ${
        solid || open ? "border-rule bg-bg/92 backdrop-blur-[12px]" : "border-transparent bg-bg/60 backdrop-blur-[6px]"
      }`}
    >
      <div className="flex h-14 items-center justify-between gap-3 px-5 max-[359px]:px-4 md:h-[72px] md:px-[6vw]">
        <div className="flex items-center gap-10">
          <Link href="/" className="inline-flex min-h-10 items-center font-display text-[22px] font-semibold tracking-[0.08em] text-text transition-colors duration-200 hover:text-gold">
            ADAG
          </Link>
          <nav aria-label="App" className="hidden items-center gap-8 lg:flex">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                aria-current={current(l.href) ? "page" : undefined}
                className={`link-draw type-ui transition-colors duration-200 hover:text-text ${current(l.href) ? "text-gold" : "text-text/88"}`}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2.5 max-[359px]:gap-2 md:gap-3">
          <ThemeControl variant="cycle" tipAlign="end" />
          <div className="hidden sm:block">
            <ConnectButton />
          </div>
          <button
            ref={toggle}
            type="button"
            aria-expanded={open}
            aria-controls={sheetId}
            onClick={() => setOpen((o) => !o)}
            className="type-label inline-flex h-10 items-center rounded-[8px] border border-rule-strong px-4 text-text transition-colors duration-200 hover:border-gold hover:text-gold lg:hidden"
            data-action="menu"
          >
            {open ? "Close" : "Menu"}
          </button>
        </div>
      </div>
      <WalletNotice />
    </header>

    {/* Outside the header on purpose: the header's backdrop blur would otherwise trap this fixed sheet inside its own box. */}
    <AnimatePresence>
      {open && (
        <motion.div
          ref={sheet}
          id={sheetId}
          role="dialog"
          aria-modal="true"
          aria-label="Menu"
          className="fixed inset-x-0 top-14 bottom-0 z-40 flex flex-col overflow-y-auto border-t border-rule bg-bg px-5 pt-10 pb-10 md:top-[72px] md:px-[6vw] lg:hidden"
          initial={{ opacity: 0, y: -12 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -12 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
        >
          <nav aria-label="App" className="flex flex-col gap-3">
            {LINKS.map((l, i) => (
              <motion.div key={l.href} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, delay: 0.05 + i * 0.06, ease: [0.16, 1, 0.3, 1] }}>
                <Link
                  href={l.href}
                  onClick={() => setOpen(false)}
                  aria-current={current(l.href) ? "page" : undefined}
                  className={`block py-2 font-display text-[clamp(2.75rem,12vw,4.5rem)] leading-[1] font-semibold tracking-[-0.02em] transition-colors duration-200 hover:text-gold ${current(l.href) ? "text-gold italic" : "text-text"}`}
                >
                  {l.label}
                </Link>
              </motion.div>
            ))}
          </nav>
          <div className="mt-auto pt-10 sm:hidden">
            <ConnectButton beforeOpen={() => setOpen(false)} />
          </div>
        </motion.div>
      )}
    </AnimatePresence>
    </>
  );
}
