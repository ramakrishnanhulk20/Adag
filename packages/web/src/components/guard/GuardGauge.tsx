"use client";

import { motion } from "motion/react";
import { WAD } from "@/lib/pay/constants";
import { formatPercentWad } from "@/lib/pay/format";

// Whole percentages drop their ".00", so three labels fit on a phone's width.
const short = (wad: bigint) => formatPercentWad(wad).replace(/\.00%$/, "%");
const pct = (wad: bigint) => (wad >= 2n ** 255n ? 100 : Math.min(100, Number((wad * 10_000n) / WAD) / 100));

// One scale for the four numbers that matter: today's loan-to-value, where the guard steps in, where it repays down
// to, and where Morpho liquidates.
export function GuardGauge({ ltvWad, triggerWad, targetWad, lltv }: { ltvWad: bigint | null; triggerWad: bigint | null; targetWad: bigint | null; lltv: bigint }) {
  const now = ltvWad === null ? null : pct(ltvWad);
  const lines = [
    targetWad !== null && targetWad > 0n ? { at: pct(targetWad), label: `Target ${short(targetWad)}`, tone: "bg-gold", row: 0 } : null,
    triggerWad !== null && triggerWad > 0n ? { at: pct(triggerWad), label: `Trigger ${short(triggerWad)}`, tone: "bg-pending", row: 1 } : null,
    { at: pct(lltv), label: `Morpho ${Number((lltv * 100n) / WAD)}%`, tone: "bg-danger", row: 0 },
  ].filter((l): l is NonNullable<typeof l> => l !== null);
  const label = [
    now === null ? "Loan-to-value unavailable" : `Loan-to-value ${now.toFixed(2)}%`,
    ...lines.map((l) => l.label),
  ].join(", ");
  return (
    <div className="mt-10" data-guard-gauge>
      <div className="relative h-3 rounded-[2px] border border-rule bg-bg/40" role="img" aria-label={label}>
        {now !== null && (
          <motion.div
            className="absolute inset-y-0 left-0 rounded-[1px] bg-[var(--gold-fill)] opacity-80"
            initial={{ width: 0 }}
            animate={{ width: `${now}%` }}
            transition={{ duration: 0.8, ease: [0.16, 1, 0.3, 1] }}
          />
        )}
        {lines.map((line) => (
          <span key={line.label} className={`absolute -top-1.5 -bottom-1.5 w-[2px] ${line.tone}`} style={{ left: `${line.at}%` }}>
            <span
              // Labels near either end hang inward, so a phone never clips them.
              className={`type-micro absolute whitespace-nowrap text-muted normal-case tracking-[0.04em] ${line.at > 75 ? "right-0 translate-x-[1px]" : line.at < 15 ? "left-0" : "-translate-x-1/2"} ${line.row === 1 ? "bottom-full mb-2" : "top-full mt-2"}`}
            >
              {line.label}
            </span>
          </span>
        ))}
      </div>
      <div className="h-7" />
    </div>
  );
}
