"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import type { Address, Hex } from "viem";
import { Button } from "@/components/Button";
import { useLibText } from "@/i18n/useLibText";
import { CIRBTC_DECIMALS, EXPLORER, MAX_LTV_WAD, type Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact, shortAddress } from "@/lib/pay/format";
import { useFeeWords } from "../fee";
import { useUsdHint, useUsdPrice } from "../usdPrice";
import { CONVERT_BUFFER_BPS, rateText, type CloseEstimate, type Estimate } from "./figures";
import { resetAdapterAccess } from "./press";

const money = (v: bigint, symbol: string) => `${formatUnitsExact(v, 6)} ${symbol}`;
const cushion = `${Number(CONVERT_BUFFER_BPS) / 100}%`;
const Num = ({ children, ...rest }: React.ComponentProps<"span">) => (
  <span className="font-semibold text-text" {...rest}>
    {children}
  </span>
);

// The figures a payment from a loan in the other currency would run on (C70). Spans only, so it can sit inside the
// option card, which is a button. Every number here is the one the press freezes and the batch carries.
export function ConvertEstimate({ e }: { e: Estimate }) {
  const t = useTranslations("convert");
  const tl = useLibText();
  const { keepText } = useFeeWords();
  const usd = useUsdPrice();
  const usdHint = useUsdHint();
  const loan = e.loan.symbol;
  const bill = e.bill.symbol;
  return (
    <span className="mt-3 block space-y-2" data-convert-estimate={`${loan}-for-${bill}`}>
      <span className="block">
        {t.rich("youBorrow", { amount: money(e.amountIn, loan), usd: formatUnitsExact(e.usd, 6), bill, num: (chunks) => <Num data-convert-x={e.amountIn.toString()}>{chunks}</Num> })}
      </span>
      <span className="block" data-convert-rate>
        {t("worstCase", { rate: tl(rateText(e.total, e.amountIn, loan, bill)), min: money(e.total, bill) })}
      </span>
      <span className="block">{t("circleFee", { fee: money(e.fee, loan), cushion, what: t("amountBorrowed") })}</span>
      <span className="block" data-convert-pledge={e.pledge.toString()}>
        {e.pledge === 0n
          ? t("pledgeNothingExtra")
          : t.rich("pledgeAndKeep", { amount: `${formatUnitsExact(e.pledge, CIRBTC_DECIMALS)} cirBTC`, usd: usdHint(e.pledge, usd), num: (chunks) => <Num>{chunks}</Num> })}
      </span>
      {e.sharedBorrow > 0n && (
        <span className="block" data-convert-shared>
          {t("sharedBorrow", { amount: money(e.sharedBorrow, loan), loan })}
        </span>
      )}
      <span className="block" data-convert-ltv>
        {t.rich("ltvAfter", { ltv: formatPercentWad(e.ltvAfter), loan, cap: formatPercentWad(MAX_LTV_WAD), drop: formatPercentWad(e.drop), num: (chunks) => <Num>{chunks}</Num> })}
      </span>
      <span className="block">{t("networkFee", { keep: keepText(e.keepUpTo) })}</span>
      <span className="block space-y-1 border-t border-rule pt-2 text-text" data-convert-plain>
        <span className="block">{t("debtWillBeIn", { loan })}</span>
        <span className="block">{t("checksOnlyNow")}</span>
        <span className="block">{t("guardRepaysFrom", { loan })}</span>
      </span>
      <span className="type-micro block normal-case tracking-[0.04em]" data-convert-block>
        {t("readAtBlock", { block: e.blockNumber.toString() })}
      </span>
    </span>
  );
}

// The same for closing a loan with the other currency (C75).
export function CloseConvertEstimate({ e }: { e: CloseEstimate }) {
  const t = useTranslations("convert");
  const tl = useLibText();
  const { keepText } = useFeeWords();
  const sold = e.sold.symbol;
  const loan = e.loan.symbol;
  return (
    <span className="mt-3 block space-y-2" data-close-estimate={`${sold}-for-${loan}`}>
      <span className="block">
        {t.rich("youSell", { amount: money(e.amountIn, sold), usd: formatUnitsExact(e.usd, 6), min: money(e.approval, loan), num: (chunks) => <Num data-close-x={e.amountIn.toString()}>{chunks}</Num> })}
      </span>
      <span className="block" data-close-rate>
        {t("worstCaseClose", { rate: tl(rateText(e.approval, e.amountIn, sold, loan)) })}
      </span>
      <span className="block">{t("circleFee", { fee: money(e.fee, sold), cushion, what: t("amountSold") })}</span>
      <span className="block">{t("thenRepays")}</span>
      <span className="block">{t("networkFee", { keep: keepText(e.keepUpTo) })}</span>
      <span className="type-micro block normal-case tracking-[0.04em]" data-convert-block>
        {t("readAtBlock", { block: e.blockNumber.toString() })}
      </span>
    </span>
  );
}

// Shown when Circle's adapter already holds access to the wallet: one signature takes it back, then the option opens.
export function ConvertReset({ account, loanToken, canSign, onDone, className = "" }: { account: Address; loanToken: Address; canSign: boolean; onDone: () => void; className?: string }) {
  const t = useTranslations("convert.reset");
  const tc = useTranslations("common");
  const tl = useLibText();
  const [state, setState] = useState<{ kind: "idle" } | { kind: "busy" } | { kind: "failed"; message: string } | { kind: "done"; hash: Hex | null }>({ kind: "idle" });
  const run = async () => {
    setState({ kind: "busy" });
    const out = await resetAdapterAccess({ account, loanToken });
    if (!out.ok) return setState({ kind: "failed", message: out.message });
    setState({ kind: "done", hash: out.hash });
    onDone();
  };
  return (
    <div className={className} data-convert-reset-box>
      <Button variant="secondary" size="sm" disabled={!canSign || state.kind === "busy"} onClick={() => void run()} data-action="convert-reset">
        {state.kind === "busy" ? tc("confirmInWallet") : t("button")}
      </Button>
      {state.kind === "busy" && <p className="type-body mt-2 text-muted">{t("onlyTakesAway")}</p>}
      {state.kind === "failed" && (
        <p className="type-body mt-2 text-danger" data-convert-reset-failed>
          {tl(state.message)}
        </p>
      )}
      {state.kind === "done" && (
        <p className="type-body mt-2 text-text" data-convert-reset-done>
          {t("done")}{" "}
          {state.hash && (
            <a href={`${EXPLORER}/tx/${state.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold hover:text-text">
              {tc("hashOnExplorer", { hash: shortAddress(state.hash) })}
            </a>
          )}
        </p>
      )}
    </div>
  );
}

export function useConvertTitle(): (loan: Currency) => string {
  const t = useTranslations("convert");
  return (loan) => t("title", { symbol: loan.symbol });
}
