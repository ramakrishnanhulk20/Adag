"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";
import type { Verdict } from "@/lib/break/catalogue";

export type StampKind = Verdict | "armed" | "running";

// The same double-ruled, ink-rough stamp as BillStamp, with the attack verdicts as its words.
const LOOK: Record<StampKind, { word: string; ink: string; tilt: number }> = {
  refused: { word: "Refused", ink: "stamp-paid", tilt: -7 },
  held: { word: "Held", ink: "stamp-paid", tilt: -6 },
  allowed: { word: "Allowed", ink: "stamp-paid", tilt: -5 },
  "by-design": { word: "By design", ink: "stamp-open", tilt: -6 },
  broken: { word: "Broken", ink: "stamp-void", tilt: -9 },
  error: { word: "Not run", ink: "bk-stamp-quiet", tilt: -4 },
  armed: { word: "Armed", ink: "bk-stamp-quiet", tilt: 0 },
  running: { word: "Running", ink: "bk-stamp-quiet", tilt: 0 },
};

export function VerdictStamp({ kind }: { kind: StampKind }) {
  const filterId = `bk-ink-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const reduce = useReducedMotion();
  const look = LOOK[kind];
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
      <span className={`stamp bk-stamp ${look.ink}`} style={landed ? { filter: `url(#${filterId})` } : undefined} role="img" aria-label={`Verdict: ${look.word}`}>
        <span className="stamp-inner">{look.word}</span>
      </span>
    </motion.span>
  );
}
