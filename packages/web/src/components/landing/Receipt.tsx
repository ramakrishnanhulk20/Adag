"use client";

import { useEffect, useRef } from "react";
import { useTranslations } from "next-intl";

// ARCHITECTURE.md section 6, "Pay from bitcoin", in its exact order. The code lines are the calls themselves and
// stay as written; the plain words beside them follow the language.
const CALLS = [
  { key: "approveBtc", code: "cirBTC.approve(Morpho, P)" },
  { key: "supply", code: "Morpho.supplyCollateral(params, P, payer, 0x)" },
  { key: "borrow", code: "Morpho.borrow(params, A, 0, payer, payer)" },
  { key: "approveCurrency", code: "C.approve(AdagBills, A)" },
  { key: "memo", code: "Memo.memo(AdagBills, payData(N), memoId(N), R)" },
] as const;

export function Receipt() {
  const t = useTranslations("landing.receipt");
  const list = useRef<HTMLOListElement>(null);

  useEffect(() => {
    const lines = list.current ? [...list.current.querySelectorAll<HTMLElement>("[data-receipt-line]")] : [];
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      lines.forEach((l) => (l.dataset.lit = "true"));
      return;
    }
    // A line lights when it crosses 55% of the screen height and stays lit, so the batch reads top to bottom.
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            (entry.target as HTMLElement).dataset.lit = "true";
            observer.unobserve(entry.target);
          }
        }
      },
      { rootMargin: "0px 0px -45% 0px" },
    );
    lines.forEach((l) => observer.observe(l));
    return () => observer.disconnect();
  }, []);

  return (
    <div className="border border-rule bg-surface px-5 py-7 font-mono md:px-9 md:py-10">
      <div className="type-micro flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1 text-muted">
        <span>{t("oneBatch")}</span>
        <span className="type-address">Multicall3From.aggregate3(calls)</span>
      </div>
      <div className="receipt-rule my-6" />
      <ol ref={list} className="flex flex-col gap-7">
        {CALLS.map((call, i) => (
          <li key={call.code} data-receipt-line data-lit="false" className="receipt-line grid grid-cols-[2.25rem_1fr] gap-x-3">
            <span className="receipt-step type-label pt-0.5 text-muted">{String(i + 1).padStart(2, "0")}</span>
            <span className="flex min-w-0 flex-col gap-1.5">
              <code className="type-address break-words text-[0.8125rem] text-text md:text-[0.9375rem]">{call.code}</code>
              <span className="type-body text-muted">{t(`calls.${call.key}`)}</span>
            </span>
          </li>
        ))}
      </ol>
      <div className="receipt-rule my-6" />
      <div className="type-micro flex flex-col gap-2 text-muted">
        <span>{t("signedOnce")}</span>
        <span className="normal-case tracking-normal">{t("legend")}</span>
      </div>
    </div>
  );
}
