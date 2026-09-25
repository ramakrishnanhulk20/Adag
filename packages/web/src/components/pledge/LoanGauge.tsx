import type { CSSProperties } from "react";
import { formatPercentWad, wadRatio } from "./format";

type LoanGaugeProps = { ltvWad: string; maxLtvWad: string; lltvWad: string };

// The fill is scaled by --fill (driven by the timeline, 0 to 1) times --ltv (the live figure), so a refresh never rebuilds the motion.
export function LoanGauge({ ltvWad, maxLtvWad, lltvWad }: LoanGaugeProps) {
  const ltv = Math.min(1, wadRatio(ltvWad));
  const cap = wadRatio(maxLtvWad);
  const line = wadRatio(lltvWad);
  return (
    <div data-pl="gauge" className="pl-gauge" style={{ "--ltv": ltv } as CSSProperties}>
      <div className="flex items-baseline justify-between gap-3">
        <span className="type-label text-muted">Loan to value</span>
        <span className="pl-gauge-value">{formatPercentWad(ltvWad)}</span>
      </div>
      <div className="pl-gauge-track" role="img" aria-label={`Loan at ${formatPercentWad(ltvWad)}. Adag's cap is ${formatPercentWad(maxLtvWad)}, Morpho liquidates at ${formatPercentWad(lltvWad)}.`}>
        <div data-pl="gauge-fill" className="pl-gauge-fill" />
        <span className="pl-gauge-tick pl-gauge-cap" style={{ left: `${cap * 100}%` }} />
        <span className="pl-gauge-tick pl-gauge-line" style={{ left: `${line * 100}%` }} />
      </div>
      <div className="pl-gauge-legend type-micro" aria-hidden="true">
        <span className="text-gold" style={{ left: `${cap * 100}%` }}>
          {formatPercentWad(maxLtvWad)} Adag cap
        </span>
        <span className="text-muted" style={{ left: `${line * 100}%` }}>
          {formatPercentWad(lltvWad)} Morpho
        </span>
      </div>
    </div>
  );
}
