"use client";

import { motion } from "motion/react";
import { useLive } from "@/components/hero/LiveData";
import { formatUsdPrice } from "@/lib/arc/present";

const pct = (wad: string) => Number(BigInt(wad) / 10n ** 12n) / 1e6;

function Unavailable({ what }: { what: string }) {
  return <p className="type-micro text-muted">{what} unavailable · could not read this from Arc</p>;
}

// The 40% cap and Morpho's 86% line on one scale, with what they mean today for one cirBTC at the oracle's live price.
export function FortyGauge() {
  const live = useLive();
  if (live.status === "loading") {
    return (
      <div className="flex flex-col gap-3" aria-label="Reading Arc">
        <span aria-hidden="true" className="live-shimmer block h-px w-full" />
        {live.slow && <span className="type-micro text-muted">Reading Arc</span>}
      </div>
    );
  }
  if (live.status === "failed" || !live.snapshot.loanCap.ok) return <Unavailable what="The loan cap" />;

  const cap = pct(live.snapshot.loanCap.value.maxLtvWad);
  const lltvWad = live.snapshot.loanCap.value.morphoLltvWad;
  const lltv = lltvWad === null ? null : pct(lltvWad);
  const price = live.snapshot.btcPrice.ok ? live.snapshot.btcPrice.value.usdPerCirbtc : null;

  return (
    <div className="flex flex-col gap-8">
      <div className="pt-3 pb-9">
        <div className="gauge-track" role="img" aria-label={`Adag stops at ${Math.round(cap * 100)}%${lltv === null ? "" : `; Morpho liquidates at ${Math.round(lltv * 100)}%`}`}>
          <motion.div
            className="gauge-fill origin-left"
            style={{ "--v": cap } as React.CSSProperties}
            initial={{ scaleX: 0 }}
            whileInView={{ scaleX: 1 }}
            viewport={{ once: true, amount: 0.6 }}
            transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1] }}
          />
          <span className="gauge-mark bg-gold" style={{ "--v": cap } as React.CSSProperties} />
          {lltv !== null && <span className="gauge-mark bg-rule-strong" style={{ "--v": lltv } as React.CSSProperties} />}
        </div>
        <div className="relative mt-4 h-4">
          <span className="type-micro absolute -translate-x-1/2 whitespace-nowrap text-gold" style={{ left: `${cap * 100}%` }}>
            Adag {Math.round(cap * 100)}%
          </span>
          {lltv !== null && (
            <span className="type-micro absolute -translate-x-1/2 whitespace-nowrap text-muted" style={{ left: `${lltv * 100}%` }}>
              Morpho {Math.round(lltv * 100)}%
            </span>
          )}
        </div>
      </div>

      {price === null ? (
        <Unavailable what="The BTC price" />
      ) : (
        <dl className="grid grid-cols-2 gap-x-6 gap-y-6 border-t border-rule pt-6">
          <div className="flex flex-col gap-1.5">
            <dt className="type-label text-muted">1 cirBTC now</dt>
            <dd className="type-number">{formatUsdPrice(price)}</dd>
          </div>
          <div className="flex flex-col gap-1.5">
            <dt className="type-label text-muted">Adag pays up to</dt>
            <dd className="type-number text-gold">{formatUsdPrice(price * cap)}</dd>
          </div>
          {lltv !== null && (
            <div className="col-span-2 flex flex-col gap-1.5 border-t border-rule pt-6">
              <dt className="type-label max-w-[40ch] text-muted">Morpho liquidates a loan at Adag&apos;s cap if bitcoin falls to</dt>
              {/* A loan at the cap owes price x cap; Morpho acts once that debt reaches its own line, at price x cap / lltv. */}
              <dd className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
                <span className="type-number text-text/88">{formatUsdPrice((price * cap) / lltv)}</span>
                <span className="type-label text-gold">a {((1 - cap / lltv) * 100).toFixed(1)}% fall</span>
              </dd>
            </div>
          )}
          <p className="type-micro col-span-2 text-muted">Per 1 cirBTC, at the live price from the USDC market&apos;s oracle on Arc</p>
        </dl>
      )}
    </div>
  );
}
