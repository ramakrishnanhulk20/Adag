"use client";

import { useId } from "react";
import { useTranslations } from "next-intl";
import { motion, useReducedMotion } from "motion/react";
import type { Verdict } from "@/lib/break/catalogue";

export type StampKind = Verdict | "armed" | "running";

// The same double-ruled, ink-rough stamp as BillStamp, with the attack verdicts as its words.
const LOOK: Record<StampKind, { ink: string; tilt: number }> = {
  refused: { ink: "stamp-paid", tilt: -7 },
  held: { ink: "stamp-paid", tilt: -6 },
  allowed: { ink: "stamp-paid", tilt: -5 },
  "by-design": { ink: "stamp-open", tilt: -6 },
  broken: { ink: "stamp-void", tilt: -9 },
  error: { ink: "bk-stamp-quiet", tilt: -4 },
  armed: { ink: "bk-stamp-quiet", tilt: 0 },
  running: { ink: "bk-stamp-quiet", tilt: 0 },
};

// Catalog keys cannot carry a hyphen in their path, so "by-design" is spelled byDesign there.
const KEY: Record<StampKind, string> = { refused: "refused", held: "held", allowed: "allowed", "by-design": "byDesign", broken: "broken", error: "error", armed: "armed", running: "running" };

export function VerdictStamp({ kind }: { kind: StampKind }) {
  const t = useTranslations("break.stamps");
  const filterId = `bk-ink-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const reduce = useReducedMotion();
  const look = LOOK[kind];
  const word = t(KEY[kind]);
  const landed = kind !== "armed" && kind !== "running";

  return (
    <motion.span
      key={kind}
      className="inline-block"
      initial={landed ? { opacity: 0, scale: 1.35, rotate: look.tilt + 5 } : { opacity: 0 }}
      animate={{ opacity: landed ? 1 : 0.7, scale: 1, rotate: look.tilt }}
      transition={reduce || !landed ? { duration: 0.2 } : { type: "spring", stiffness: 700, damping: 24 }}
    >
      <svg aria-hidden="true" width="0" height="0" className="absolute">
        <filter id={filterId} x="-5%" y="-10%" width="110%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={7} result="ink" />
          <feDisplacementMap in="SourceGraphic" in2="ink" scale="1.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <span className={`stamp bk-stamp ${look.ink}`} style={landed ? { filter: `url(#${filterId})` } : undefined} role="img" aria-label={t("verdict", { word })}>
        <span className="stamp-inner">{word}</span>
      </span>
    </motion.span>
  );
}
