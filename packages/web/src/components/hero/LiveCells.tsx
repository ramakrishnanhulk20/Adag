"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { formatApy, formatMoney, formatWadPercent } from "@/lib/arc/present";
import type { LiveSnapshot } from "@/lib/arc/types";
import { billHref } from "@/lib/pay/billId";
import { ADAG_BILLS } from "@/lib/pay/constants";
import { useLive } from "./LiveData";

const BILL_ONE = billHref(ADAG_BILLS, 1n);

type Shown =
  | { kind: "loading"; slow: boolean }
  | { kind: "unavailable" }
  | { kind: "ready"; number: string; suffix?: string; detail: React.ReactNode };

type T = ReturnType<typeof useTranslations<"hero.cells">>;
type CellSpec = { key: "ready" | "rate" | "cap" | "paid"; read: (s: LiveSnapshot, t: T) => Shown };

const CELLS: CellSpec[] = [
  {
    key: "ready",
    read: ({ liquidity }, t) =>
      liquidity.ok
        ? {
            kind: "ready",
            number: formatMoney(liquidity.value.usdcBaseUnits, "USD"),
            detail: liquidity.value.eurcBaseUnits === null ? t("eurcUnavailable") : t("eurcMarket", { amount: formatMoney(liquidity.value.eurcBaseUnits, "EUR") }),
          }
        : { kind: "unavailable" },
  },
  {
    key: "rate",
    read: ({ borrowRate }, t) =>
      borrowRate.ok ? { kind: "ready", number: formatApy(borrowRate.value.apy), suffix: t("aYear"), detail: t("morphoLive") } : { kind: "unavailable" },
  },
  {
    key: "cap",
    read: ({ loanCap }, t) =>
      loanCap.ok
        ? {
            kind: "ready",
            number: formatWadPercent(loanCap.value.maxLtvWad),
            detail: loanCap.value.morphoLltvWad === null ? t("lineUnavailable") : t("morphoLiquidatesAt", { pct: formatWadPercent(loanCap.value.morphoLltvWad) }),
          }
        : { kind: "unavailable" },
  },
  {
    key: "paid",
    read: ({ paid }, t) => {
      if (!paid.ok) return { kind: "unavailable" };
      const v = paid.value;
      const eurc = v.eurcBaseUnits !== "0" ? `+ ${formatMoney(v.eurcBaseUnits, "EUR")} · ` : "";
      // The shortest path from the headline number to a real payment: bill #1, the live proof on the current contract.
      const tail = (
        <>
          {" · "}
          <Link href={BILL_ONE} className="link-draw text-gold max-md:tap-target" aria-label={t("seeBillOneLabel")}>
            {t("seeBillOne")}
          </Link>
        </>
      );
      return {
        kind: "ready",
        number: formatMoney(v.usdcBaseUnits, "USD"),
        detail: (
          <>
            {eurc}
            {t("billsPaid", { count: v.billsPaid, n: String(v.billsPaid) })}
            {tail}
          </>
        ),
      };
    },
  },
];

function Value({ shown }: { shown: Shown }) {
  const tc = useTranslations("common");
  if (shown.kind === "loading") {
    return (
      <div className="flex h-[clamp(2.25rem,1.5rem+1.8vw,3.125rem)] flex-col justify-center gap-2" aria-label={tc("readingArc")}>
        <span aria-hidden="true" className="live-shimmer block h-px w-3/5" />
        <span className={`type-micro text-muted transition-opacity duration-300 ${shown.slow ? "opacity-100" : "opacity-0"}`}>{tc("readingArc")}</span>
      </div>
    );
  }
  if (shown.kind === "unavailable") {
    return (
      <p className="flex h-[clamp(2.25rem,1.5rem+1.8vw,3.125rem)] items-center font-display text-[clamp(1.25rem,1rem+0.8vw,1.625rem)] italic text-muted">
        {tc("unavailable")}
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
      {shown.suffix && <span className="type-micro mt-1.5 block text-muted lg:mt-0 lg:ml-2 lg:inline lg:align-middle">{shown.suffix}</span>}
    </motion.p>
  );
}

export function LiveCells() {
  const live = useLive();
  const t = useTranslations("hero.cells");
  return (
    <dl className="grid grid-cols-2 gap-x-5 gap-y-8 border-t border-rule pt-5 md:grid-cols-4 md:gap-0 md:pt-4">
      {CELLS.map((cell, i) => {
        const shown: Shown =
          live.status === "loading"
            ? { kind: "loading", slow: live.slow }
            : live.status === "failed"
              ? { kind: "unavailable" }
              : cell.read(live.snapshot, t);
        return (
          <div
            key={cell.key}
            data-live-cell={i + 1}
            data-state={shown.kind}
            className={`flex min-w-0 flex-col gap-1.5 md:px-6 ${i === 0 ? "md:pl-0" : "md:border-l md:border-rule"}`}
          >
            <dt className="type-label text-muted">{t(`labels.${cell.key}`)}</dt>
            <dd className="min-w-0">
              <Value shown={shown} />
            </dd>
            <dd className="type-micro min-h-[1.3em] text-muted">
              {shown.kind === "ready" ? shown.detail : shown.kind === "unavailable" ? t("couldNotRead") : null}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
