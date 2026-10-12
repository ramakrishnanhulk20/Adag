"use client";

import { useEffect, useId, useRef, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/Button";

type MorphoDisclaimerProps = {
  open: boolean;
  onAccept: () => void;
  onCancel: () => void;
};

// Morpho's borrow guide asks for this exact text, with a checkbox, before the first borrow through an app (ARCHITECTURE.md section 8).
export function MorphoDisclaimer({ open, onAccept, onCancel }: MorphoDisclaimerProps) {
  const t = useTranslations("disclaimer");
  const titleId = useId();
  const checkId = useId();
  const [checked, setChecked] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  // Held in a ref so a parent re-render with a new callback never re-runs the effect below, which would untick the
  // box and move focus while the dialog is open.
  const cancel = useRef(onCancel);
  useEffect(() => {
    cancel.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    if (!open) return;
    setChecked(false);
    const previous = document.activeElement as HTMLElement | null;
    box.current?.querySelector<HTMLElement>("input")?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") cancel.current();
      if (e.key !== "Tab" || !box.current) return;
      const focusable = [...box.current.querySelectorAll<HTMLElement>("a, button:not(:disabled), input")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last?.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      previous?.focus();
    };
  }, [open]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="disclaimer"
          className="fixed inset-0 z-[80] flex items-end justify-center p-4 md:items-center"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.25 }}
        >
          <button type="button" aria-label={t("close")} onClick={onCancel} className="absolute inset-0 cursor-default bg-[rgb(var(--shade-rgb)/0.62)] backdrop-blur-[3px]" />
          <motion.div
            ref={box}
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            className="app-panel relative w-full max-w-[34rem] bg-raised p-6 md:p-9"
            initial={{ opacity: 0, y: 32, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16 }}
            transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
          >
            <p className="type-label text-gold">{t("label")}</p>
            <h2 id={titleId} className="type-h3 mt-3 text-text">
              {t("title")}
            </h2>
            <p className="type-body mt-5 text-text">
              {t.rich("body", {
                terms: (chunks) => (
                  <Link href="/terms" target="_blank" className="link-draw text-gold">
                    {chunks}
                  </Link>
                ),
                morpho: (chunks) => (
                  <a href="https://morpho.org/disclaimers/" target="_blank" rel="noopener noreferrer" className="link-draw text-gold">
                    {chunks}
                  </a>
                ),
              })}
            </p>
            <label htmlFor={checkId} className="mt-7 flex cursor-pointer items-start gap-3 rounded-[8px] border border-rule p-4 transition-colors duration-200 hover:border-gold">
              <input
                id={checkId}
                type="checkbox"
                checked={checked}
                onChange={(e) => setChecked(e.target.checked)}
                className="mt-1 h-4 w-4 shrink-0 accent-[var(--gold-fill)]"
              />
              <span className="type-body text-text">{t("checkbox")}</span>
            </label>
            <div className="mt-7 flex flex-col-reverse gap-3 md:flex-row md:justify-end">
              <Button variant="secondary" onClick={onCancel} className="w-full md:w-auto">
                {t("notNow")}
              </Button>
              <Button variant="primary" disabled={!checked} onClick={onAccept} className="w-full md:w-auto">
                {t("continue")}
              </Button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
