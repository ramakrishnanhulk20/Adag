"use client";

import { Hallmark } from "@/components/Hallmark";
import { formatMoney } from "@/lib/arc/present";
import { useLive } from "./LiveData";

// The phone's eyebrow leads with the market's depth, the biggest honest number on screen one.
// Until that read lands, or if it fails, it falls back to the plain label rather than a guess.
export function LiveTicker({ className = "" }: { className?: string }) {
  const live = useLive();
  const liquidity = live.status === "ready" && live.snapshot.liquidity.ok ? live.snapshot.liquidity.value.usdcBaseUnits : null;
  return (
    <Hallmark className={className}>
      <span aria-live="polite">{liquidity === null ? "Live on Arc mainnet" : `Live on Arc · ${formatMoney(liquidity, "USD")} ready to lend`}</span>
    </Hallmark>
  );
}
