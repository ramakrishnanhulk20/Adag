"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { DiamondSeparator } from "@/components/DiamondSeparator";
import { useLive } from "./LiveData";

const FIXED = ["arcMainnet", "usdcOrEurc", "morphoBlue", "cap", "oneSignature", "noOwner"] as const;

// "UNDER A MIN AGO", "5 MIN AGO", "2 H 3 MIN AGO" in English; each language writes its own.
function Age({ seconds }: { seconds: number }) {
  const t = useTranslations("hero.credit");
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 1) return <>{t("ageUnderMinute")}</>;
  if (minutes < 60) return <>{t("ageMinutes", { minutes: String(minutes) })}</>;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return <>{rest === 0 ? t("ageHours", { hours: String(hours) }) : t("ageHoursMinutes", { hours: String(hours), minutes: String(rest) })}</>;
}

function PriceItem() {
  const live = useLive();
  const t = useTranslations("hero.credit");
  const tc = useTranslations("common");
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
        {t("btcPrice")} <span aria-hidden="true" className="live-shimmer inline-block h-px w-16" />
        {live.slow && <span>{tc("readingArc")}</span>}
      </span>
    );
  }
  if (live.status === "failed" || !live.snapshot.price.ok) return <span>{t("btcPriceUnavailable")}</span>;

  const price = live.snapshot.price.value;
  if (!price.fresh) return <span className="text-pending">{t("pausedWaiting")}</span>;
  const elapsed = now === null ? 0 : Math.max(0, (now - live.receivedAt) / 1000);
  return (
    <span>
      <span className="text-success">{t("btcPriceFresh")}</span> · {t("updated")} <Age seconds={price.ageSeconds + elapsed} />
    </span>
  );
}

export function CreditRow({ className = "" }: { className?: string }) {
  const t = useTranslations("hero.credit");
  return (
    <p data-credit-row className={`type-micro flex flex-wrap items-center gap-x-3 gap-y-2 text-muted ${className}`}>
      {FIXED.map((item, i) => (
        <span key={item} className="flex items-center gap-3">
          {i > 0 && <DiamondSeparator />}
          {t(item)}
        </span>
      ))}
      <span className="flex items-center gap-3">
        <DiamondSeparator />
        <PriceItem />
      </span>
    </p>
  );
}
