"use client";

import { useTranslations } from "next-intl";
import { Hallmark } from "@/components/Hallmark";
import { formatMoney } from "@/lib/arc/present";
import { useLive } from "./LiveData";

// The phone's eyebrow leads with the market's depth, the biggest honest number on screen one.
// Until that read lands, or if it fails, it falls back to the plain label rather than a guess.
export function LiveTicker({ className = "" }: { className?: string }) {
  const live = useLive();
  const t = useTranslations("hero");
  const tc = useTranslations("common");
  const liquidity = live.status === "ready" && live.snapshot.liquidity.ok ? live.snapshot.liquidity.value.usdcBaseUnits : null;
  return (
    <Hallmark className={`max-w-full max-sm:flex max-sm:w-full max-sm:justify-center ${className}`}>
      <span aria-live="polite" className="min-w-0 truncate max-sm:tracking-[0.07em]">
        {liquidity === null ? tc("liveOnArc") : t("ticker", { amount: formatMoney(liquidity, "USD") })}
      </span>
    </Hallmark>
  );
}
