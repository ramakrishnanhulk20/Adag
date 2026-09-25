"use client";

import { useId } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useTheme } from "@/components/ThemeProvider";
import { THEME_CHOICES, type ThemeChoice } from "@/lib/theme";

const LABEL: Record<ThemeChoice, string> = { system: "System", light: "Light", dark: "Dark" };

function nextChoice(choice: ThemeChoice): ThemeChoice {
  const i = THEME_CHOICES.indexOf(choice);
  return THEME_CHOICES[(i + 1) % THEME_CHOICES.length] ?? "system";
}

function ThemeIcon({ choice }: { choice: ThemeChoice }) {
  const common = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.5, "aria-hidden": true } as const;
  if (choice === "light") {
    return (
      <svg {...common}>
        <circle cx="12" cy="12" r="4.25" />
        {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
          <line key={a} x1="12" y1="2.75" x2="12" y2="5.25" strokeLinecap="round" transform={`rotate(${a} 12 12)`} />
        ))}
      </svg>
    );
  }
  if (choice === "dark") {
    return (
      <svg {...common}>
        <path d="M19.5 14.6A8 8 0 0 1 9.4 4.5a8 8 0 1 0 10.1 10.1Z" strokeLinejoin="round" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16Z" fill="currentColor" stroke="none" />
    </svg>
  );
}

function CycleControl({ tipAlign }: { tipAlign: "start" | "end" }) {
  const { choice, resolved, setChoice } = useTheme();
  const tipId = useId();
  const upcoming = nextChoice(choice);
  const state = choice === "system" && resolved ? `System, now ${LABEL[resolved].toLowerCase()}` : LABEL[choice];

  return (
    <span className="group relative inline-flex">
      <button
        type="button"
        onClick={() => setChoice(upcoming)}
        aria-label={`Theme: ${state}. Switch to ${LABEL[upcoming]}`}
        aria-describedby={tipId}
        className="inline-flex h-10 w-10 items-center justify-center overflow-hidden rounded-[8px] border border-rule-strong text-text transition-colors duration-200 hover:border-gold hover:text-gold"
      >
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={choice}
            className="inline-flex"
            initial={{ opacity: 0, rotate: -60, y: 6 }}
            animate={{ opacity: 1, rotate: 0, y: 0 }}
            exit={{ opacity: 0, rotate: 60, y: -6 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            <ThemeIcon choice={choice} />
          </motion.span>
        </AnimatePresence>
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={`type-micro pointer-events-none absolute top-full ${tipAlign === "end" ? "right-0" : "left-0"} z-20 mt-2 translate-y-1 whitespace-nowrap rounded-[4px] border border-rule bg-raised px-2.5 py-1.5 text-muted opacity-0 transition duration-200 group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100`}
      >
        Theme: {state}
      </span>
    </span>
  );
}

function SegmentedControl() {
  const { choice, setChoice } = useTheme();
  const pillId = useId();

  return (
    <div role="radiogroup" aria-label="Theme" className="inline-flex gap-1 rounded-[8px] border border-rule p-1">
      {THEME_CHOICES.map((option) => {
        const selected = option === choice;
        return (
          <button
            key={option}
            type="button"
            role="radio"
            aria-checked={selected}
            aria-label={`${LABEL[option]} theme`}
            onClick={() => setChoice(option)}
            className={`relative inline-flex h-9 items-center gap-2 rounded-[6px] px-3 type-micro transition-colors duration-200 ${
              selected ? "text-gold" : "text-muted hover:text-text"
            }`}
          >
            {selected && (
              <motion.span
                layoutId={pillId}
                aria-hidden="true"
                className="absolute inset-0 rounded-[6px] border border-rule-strong bg-raised"
                transition={{ type: "spring", stiffness: 500, damping: 38 }}
              />
            )}
            <span className="relative inline-flex">
              <ThemeIcon choice={option} />
            </span>
            <span className="relative">{LABEL[option]}</span>
          </button>
        );
      })}
    </div>
  );
}

type ThemeControlProps = {
  variant?: "cycle" | "segmented";
  // Which edge of the button the tooltip lines up with, so it always opens toward the page, never off it.
  tipAlign?: "start" | "end";
};

export function ThemeControl({ variant = "cycle", tipAlign = "end" }: ThemeControlProps) {
  return variant === "cycle" ? <CycleControl tipAlign={tipAlign} /> : <SegmentedControl />;
}
