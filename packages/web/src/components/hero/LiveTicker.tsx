"use client";

import { Hallmark } from "@/components/Hallmark";
import { formatMoney } from "@/lib/arc/present";
import { useLive } from "./LiveData";

// The phone's eyebrow: the same hallmark, carrying Adag's own paid total instead of a fixed label.
export function LiveTicker({ className = "" }: { className?: string }) {
  const live = useLive();
  let tail: React.ReactNode;
  if (live.status === "loading") tail = live.slow ? "Reading Arc" : <span aria-hidden="true" className="live-shimmer inline-block h-px w-14" />;
  else if (live.status === "failed" || !live.snapshot.paid.ok) tail = "Paid total unavailable";
  else {
    const p = live.snapshot.paid.value;
    tail = `${formatMoney(p.usdcBaseUnits, "USD")} paid · ${p.billsPaid} ${p.billsPaid === 1 ? "bill" : "bills"}`;
  }
  return (
    <Hallmark className={className}>
      <span>Live on Arc</span>
      <span aria-hidden="true">·</span>
      <span aria-live="polite" className="inline-flex items-center">
        {tail}
      </span>
    </Hallmark>
  );
}
