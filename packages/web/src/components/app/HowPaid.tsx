import type { CSSProperties } from "react";
import { Button } from "@/components/Button";
import { CIRBTC_DECIMALS } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";
import type { HowPaid as HowPaidData } from "@/lib/pay/howPaid";

const d = (n: number) => ({ "--d": n }) as CSSProperties;

function Figure({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="border-t border-rule pt-4">
      <dt className="type-micro text-muted">{label}</dt>
      <dd className="mt-2 font-display text-[clamp(1.75rem,3vw,2.5rem)] leading-none font-medium tabular-nums text-text">{value}</dd>
      {note && <dd className="type-micro mt-2 normal-case tracking-[0.04em] text-muted">{note}</dd>}
    </div>
  );
}

// For anyone who opens a paid bill, a judge included: how the payment was made, read from its own transaction, and
// where to go next.
export function HowPaid({ how }: { how: HowPaidData }) {
  return (
    <section className="px-5 pb-16 md:px-[6vw] md:pb-24" aria-labelledby="how-paid-title" data-how-paid={how.kind}>
      <div className="app-rise border-t border-rule pt-10" style={d(0)}>
        <h2 id="how-paid-title" className="type-h3 text-text">
          How it was <em className="font-semibold text-gold italic">paid</em>
        </h2>
        {how.kind === "bitcoin" ? (
          <dl className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label="Pledged" value={`${formatUnitsExact(how.pledged, CIRBTC_DECIMALS)} cirBTC`} note="kept, never sold" />
            {how.borrowed.map((b) => (
              <Figure key={`borrow-${b.symbol}`} label={`Borrowed on Morpho`} value={`${formatUnitsExact(b.assets, 6)} ${b.symbol}`} note="sent straight to the supplier" />
            ))}
            {how.borrowed.map((b) => (
              <Figure key={`ltv-${b.symbol}`} label={`Loan-to-value after (${b.symbol})`} value={b.ltvAfterWad === null ? "unavailable" : formatPercentWad(b.ltvAfterWad)} note="Adag refuses anything over 40%" />
            ))}
            <Figure label="Bitcoin sold" value="0 cirBTC" note="the payer keeps every satoshi" />
          </dl>
        ) : how.kind === "balance" ? (
          <p className="type-lead mt-6 max-w-[40rem] text-text">From the payer&apos;s balance: nothing borrowed, nothing pledged, nothing sold.</p>
        ) : (
          <p className="type-body mt-6 text-muted">The paying transaction could not be read right now. The bill is still paid: that comes from Adag&apos;s own record.</p>
        )}
        <div className="mt-10 flex flex-col gap-3 md:flex-row" data-visitor-links>
          <Button href="/break" variant="primary" className="w-full md:w-auto">
            Try to break it
          </Button>
          <Button href="/bill/new" variant="secondary" className="w-full md:w-auto">
            Write a bill
          </Button>
          <Button href="/docs/how-it-works" variant="secondary" className="w-full md:w-auto">
            How it works
          </Button>
        </div>
      </div>
    </section>
  );
}
