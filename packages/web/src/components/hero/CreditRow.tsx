"use client";

import { useEffect, useState } from "react";
import { DiamondSeparator } from "@/components/DiamondSeparator";
import { formatAge } from "@/lib/arc/present";
import { useLive } from "./LiveData";

const FIXED = ["Arc mainnet", "USDC or EURC", "Morpho Blue", "40% cap", "One signature", "No owner"];

function PriceItem() {
  const live = useLive();
  const [now, setNow] = useState<number | null>(null);

  // The age keeps ticking between refreshes, counted from when this answer arrived.
  useEffect(() => {
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(t);
  }, []);

  if (live.status === "loading") {
    return (
      <span className="inline-flex items-center gap-2">
        BTC price <span aria-hidden="true" className="live-shimmer inline-block h-px w-16" />
        {live.slow && <span>Reading Arc</span>}
      </span>
    );
  }
  if (live.status === "failed" || !live.snapshot.price.ok) return <span>BTC price unavailable</span>;

  const price = live.snapshot.price.value;
  if (!price.fresh) return <span className="text-pending">New loans paused · waiting for a fresh BTC price</span>;
  const elapsed = now === null ? 0 : Math.max(0, (now - live.receivedAt) / 1000);
  return (
    <span>
      <span className="text-success">BTC price fresh</span> · Updated {formatAge(price.ageSeconds + elapsed)}
    </span>
  );
}

export function CreditRow({ className = "" }: { className?: string }) {
  return (
    <p data-credit-row className={`type-micro flex flex-wrap items-center gap-x-3 gap-y-2 text-muted ${className}`}>
      {FIXED.map((item, i) => (
        <span key={item} className="flex items-center gap-3">
          {i > 0 && <DiamondSeparator />}
          {item}
        </span>
      ))}
      <span className="flex items-center gap-3">
        <DiamondSeparator />
        <PriceItem />
      </span>
    </p>
  );
}
