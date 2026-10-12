import type { CSSProperties } from "react";
import { getTranslations } from "next-intl/server";
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
export async function HowPaid({ how, billSymbol }: { how: HowPaidData; billSymbol: "USDC" | "EURC" }) {
  const t = await getTranslations("bill.howPaid");
  const tc = await getTranslations("common");
  // Where a borrowed amount went. A conversion is proven from the transaction's own transfers; without one, a loan in the
  // bill's currency went to the supplier and a loan in the other currency paid the other bills in the same transaction.
  const borrowNote = (b: { symbol: "USDC" | "EURC"; converted: boolean }) =>
    b.converted ? t("convertedInto", { symbol: billSymbol }) : b.symbol === billSymbol ? t("straightToSupplier") : t("paidOtherBills");
  return (
    <section className="px-5 pb-16 md:px-[6vw] md:pb-24" aria-labelledby="how-paid-title" data-how-paid={how.kind}>
      <div className="app-rise border-t border-rule pt-10" style={d(0)}>
        <h2 id="how-paid-title" className="type-h3 text-text">
          {t.rich("title", { em: (chunks) => <em className="font-semibold text-gold italic">{chunks}</em> })}
        </h2>
        {how.kind === "bitcoin" ? (
          <dl className="mt-8 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
            <Figure label={t("pledged")} value={`${formatUnitsExact(how.pledged, CIRBTC_DECIMALS)} cirBTC`} note={t("keptNeverSold")} />
            {how.borrowed.map((b) => (
              <Figure key={`borrow-${b.symbol}`} label={t("borrowedOnMorpho")} value={`${formatUnitsExact(b.assets, 6)} ${b.symbol}`} note={borrowNote(b)} />
            ))}
            {how.borrowed.map((b) => (
              <Figure key={`ltv-${b.symbol}`} label={t("ltvAfter", { symbol: b.symbol })} value={b.ltvAfterWad === null ? tc("unavailable") : formatPercentWad(b.ltvAfterWad)} note={tc("refusesOver40")} />
            ))}
            <Figure label={t("bitcoinSold")} value="0 cirBTC" note={t("keepsEverySatoshi")} />
          </dl>
        ) : how.kind === "balance" ? (
          <p className="type-lead mt-6 max-w-[40rem] text-text">{t("fromBalance")}</p>
        ) : (
          <p className="type-body mt-6 text-muted">{t("unavailable")}</p>
        )}
        <div className="mt-10 flex flex-col gap-3 md:flex-row" data-visitor-links>
          <Button href="/break" variant="primary" className="w-full md:w-auto">
            {tc("tryToBreakIt")}
          </Button>
          <Button href="/bill/new" variant="secondary" className="w-full md:w-auto">
            {tc("writeABill")}
          </Button>
          <Button href="/docs/how-it-works" variant="secondary" className="w-full md:w-auto">
            {tc("howItWorks")}
          </Button>
        </div>
      </div>
    </section>
  );
}
