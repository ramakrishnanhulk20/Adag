"use client";

import { motion } from "motion/react";
import { formatApy, formatMoney, formatWadPercent } from "@/lib/arc/present";
import type { LiveSnapshot } from "@/lib/arc/types";
import { useLive } from "./LiveData";

type Shown =
  | { kind: "loading"; slow: boolean }
  | { kind: "unavailable" }
  | { kind: "ready"; number: string; suffix?: string; detail: React.ReactNode };

type CellSpec = { label: string; read: (s: LiveSnapshot) => Shown };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "S"}`;

const CELLS: CellSpec[] = [
  {
    label: "Ready to lend on Morpho",
    read: ({ liquidity }) =>
      liquidity.ok
        ? {
            kind: "ready",
            number: formatMoney(liquidity.value.usdcBaseUnits, "USD"),
            detail:
              liquidity.value.eurcBaseUnits === null
                ? "EURC market unavailable"
                : `${formatMoney(liquidity.value.eurcBaseUnits, "EUR")} in the EURC market`,
          }
        : { kind: "unavailable" },
  },
  {
    label: "Borrow rate",
    read: ({ borrowRate }) =>
      borrowRate.ok
        ? { kind: "ready", number: formatApy(borrowRate.value.apy), suffix: "a year", detail: "Morpho Blue, live" }
        : { kind: "unavailable" },
  },
  {
    label: "Loan cap",
    read: ({ loanCap }) =>
      loanCap.ok
        ? {
            kind: "ready",
            number: formatWadPercent(loanCap.value.maxLtvWad),
            detail:
              loanCap.value.morphoLltvWad === null
                ? "Morpho's line unavailable"
                : `Morpho liquidates at ${formatWadPercent(loanCap.value.morphoLltvWad)}`,
          }
        : { kind: "unavailable" },
  },
  {
    label: "Paid through Adag",
    read: ({ paid }) => {
      if (!paid.ok) return { kind: "unavailable" };
      const v = paid.value;
      const eurc = v.eurcBaseUnits !== "0" ? `+ ${formatMoney(v.eurcBaseUnits, "EUR")} · ` : "";
      const count = plural(v.billsPaid, "bill");
      let tail: React.ReactNode = null;
      if (v.latestPayment) {
        tail = (
          <>
            {" · "}
            <a
              href={v.latestPayment.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="link-draw text-gold"
              aria-label={`View the latest Adag payment, bill ${v.latestPayment.billId}, on the Arc explorer`}
            >
              View on explorer
            </a>
          </>
        );
      } else if (v.latestPaymentNote === "unavailable") tail = " · link unavailable";
      else if (v.latestPaymentNote === "not-found") tail = " · transaction outside the search window";
      return {
        kind: "ready",
        number: formatMoney(v.usdcBaseUnits, "USD"),
        detail: (
          <>
            {eurc}
            {count} paid{tail}
          </>
        ),
      };
    },
  },
];

function Value({ shown }: { shown: Shown }) {
  if (shown.kind === "loading") {
    return (
      <div className="flex h-[clamp(2.25rem,1.5rem+1.8vw,3.125rem)] flex-col justify-center gap-2" aria-label="Reading Arc">
        <span aria-hidden="true" className="live-shimmer block h-px w-3/5" />
        <span className={`type-micro text-muted transition-opacity duration-300 ${shown.slow ? "opacity-100" : "opacity-0"}`}>Reading Arc</span>
      </div>
    );
  }
  if (shown.kind === "unavailable") {
    return (
      <p className="flex h-[clamp(2.25rem,1.5rem+1.8vw,3.125rem)] items-center font-display text-[clamp(1.25rem,1rem+0.8vw,1.625rem)] italic text-muted">
        unavailable
      </p>
    );
  }
  return (
    <motion.p
      key={shown.number}
      className="type-number whitespace-nowrap text-text"
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
    >
      {shown.number}
      {shown.suffix && <span className="type-micro ml-2 align-middle text-muted">{shown.suffix}</span>}
    </motion.p>
  );
}

export function LiveCells() {
  const live = useLive();
  return (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-8 border-t border-rule pt-5 md:grid-cols-4 md:gap-0 md:pt-4">
      {CELLS.map((cell, i) => {
        const shown: Shown =
          live.status === "loading"
            ? { kind: "loading", slow: live.slow }
            : live.status === "failed"
              ? { kind: "unavailable" }
              : cell.read(live.snapshot);
        return (
          <div
            key={cell.label}
            data-live-cell={i + 1}
            data-state={shown.kind}
            className={`flex min-w-0 flex-col gap-1.5 md:px-6 ${i === 0 ? "md:pl-0" : "md:border-l md:border-rule"}`}
          >
            <dt className="type-label text-muted">{cell.label}</dt>
            <dd className="min-w-0">
              <Value shown={shown} />
            </dd>
            <dd className="type-micro min-h-[1.3em] text-muted">
              {shown.kind === "ready" ? shown.detail : shown.kind === "unavailable" ? "Could not read this from Arc" : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
