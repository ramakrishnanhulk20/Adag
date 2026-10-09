"use client";

import { useEffect, useId, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { ThemeControl } from "@/components/ThemeControl";
import { HeroAction } from "./HeroAction";

const LINKS = [
  { label: "How it works", href: "#how" },
  { label: "Safety", href: "#safety" },
  { label: "Proof", href: "#proof" },
  { label: "Docs", href: "/docs" },
];

const SOLID_AFTER_PX = 80;

export function HeroNav() {
  const [solid, setSolid] = useState(false);
  const [open, setOpen] = useState(false);
  const menuId = useId();

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

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  const filled = solid || open;

  return (
    <header
      data-solid={filled}
      className={`fixed inset-x-0 top-0 z-50 border-b transition-[background-color,border-color,backdrop-filter] duration-300 ${
        filled ? "border-rule bg-bg/92 backdrop-blur-[12px]" : "border-transparent bg-transparent"
      }`}
    >
      <div className="flex h-14 items-center justify-between px-5 max-[359px]:px-4 md:h-[72px] md:px-[6vw]">
        <div className="flex items-center gap-12">
          <a href="#top" className="inline-flex min-h-10 items-center font-display text-[22px] font-semibold tracking-[0.08em] text-text transition-colors duration-200 hover:text-gold">
            ADAG
          </a>
          <nav aria-label="Main" className="hidden items-center gap-9 md:flex">
            {LINKS.map((link) => (
              <a key={link.label} href={link.href} className="link-draw type-ui text-text/88 transition-colors duration-200 hover:text-text">
                {link.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3 max-[359px]:gap-2">
          <ThemeControl variant="cycle" tipAlign="end" />
          <HeroAction href="/app" variant="secondary" size="sm" className="hidden md:inline-flex">
            Open app
          </HeroAction>
          <button
            type="button"
            aria-expanded={open}
            aria-controls={menuId}
            aria-label={open ? "Close menu" : "Open menu"}
            onClick={() => setOpen((o) => !o)}
            className="inline-flex h-10 w-10 items-center justify-center rounded-[8px] border border-rule-strong text-text transition-colors duration-200 hover:border-gold hover:text-gold md:hidden"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
              <line x1="4" x2="20" y1="8" y2="8" strokeLinecap="round" className="origin-center transition-transform duration-300" style={{ transform: open ? "translateY(4px) rotate(45deg)" : "none", transformBox: "fill-box" }} />
              <line x1="4" x2="20" y1="16" y2="16" strokeLinecap="round" className="origin-center transition-transform duration-300" style={{ transform: open ? "translateY(-4px) rotate(-45deg)" : "none", transformBox: "fill-box" }} />
            </svg>
          </button>
        </div>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            id={menuId}
            className="border-t border-rule px-5 pt-8 pb-10 md:hidden"
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
          >
            <nav aria-label="Main" className="flex flex-col gap-5">
              {LINKS.map((link, i) => (
                <motion.a
                  key={link.label}
                  href={link.href}
                  onClick={() => setOpen(false)}
                  className="type-h3 text-text transition-colors duration-200 hover:text-gold"
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.5, delay: 0.04 + i * 0.06, ease: [0.16, 1, 0.3, 1] }}
                >
                  {link.label}
                </motion.a>
              ))}
            </nav>
            <div className="mt-10 flex flex-col gap-3">
              <HeroAction href="/bill/new" variant="secondary" className="flex w-full">
                Write a bill
              </HeroAction>
              <HeroAction href="/app" variant="secondary" className="flex w-full">
                Open app
              </HeroAction>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </header>
  );
}
