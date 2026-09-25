"use client";

import { useId } from "react";
import { motion, useReducedMotion } from "motion/react";

export type BillStatus = "paid" | "open" | "void";

const WORD: Record<BillStatus, string> = { paid: "Paid", open: "Open", void: "Void" };
const DEFAULT_TILT: Record<BillStatus, number> = { paid: -8, open: -6, void: -9 };

type BillStampProps = {
  status: BillStatus;
  tilt?: number;
  // "in-view" springs the stamp down the first time it scrolls into view; "none" renders it already stamped.
  entrance?: "in-view" | "none";
  className?: string;
};

export function BillStamp({ status, tilt = DEFAULT_TILT[status], entrance = "none", className = "" }: BillStampProps) {
  const filterId = `stamp-ink-${useId().replace(/[^a-zA-Z0-9]/g, "")}`;
  const reduce = useReducedMotion();
  const seed = status === "paid" ? 3 : status === "open" ? 11 : 23;
  const animated = entrance === "in-view";

  return (
    <motion.span
      className={`inline-block ${className}`}
      style={animated ? undefined : { rotate: tilt }}
      // One starting pose for server and browser; under reduced motion MotionConfig makes the scale and turn instant, leaving a fade.
      initial={animated ? { opacity: 0, scale: 1.35, rotate: tilt + 5 } : false}
      whileInView={animated ? { opacity: 1, scale: 1, rotate: tilt } : undefined}
      viewport={{ once: true, amount: 0.6 }}
      transition={reduce ? { duration: 0.2 } : { type: "spring", stiffness: 700, damping: 24 }}
    >
      <svg aria-hidden="true" width="0" height="0" className="absolute">
        <filter id={filterId} x="-5%" y="-10%" width="110%" height="120%">
          <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} result="ink" />
          <feDisplacementMap in="SourceGraphic" in2="ink" scale="1.5" xChannelSelector="R" yChannelSelector="G" />
        </filter>
      </svg>
      <span className={`stamp stamp-${status}`} style={{ filter: `url(#${filterId})` }} role="img" aria-label={`Status: ${WORD[status]}`}>
        <span className="stamp-inner">{WORD[status]}</span>
      </span>
    </motion.span>
  );
}
