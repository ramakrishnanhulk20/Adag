"use client";

import { useState } from "react";
import type { Address, Hex } from "viem";
import { Button } from "@/components/Button";
import { CIRBTC_DECIMALS, EXPLORER, MAX_LTV_WAD, type Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact, shortAddress } from "@/lib/pay/format";
import { keepText } from "../fee";
import { usdHint, useUsdPrice } from "../usdPrice";
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
  const usd = useUsdPrice();
  const loan = e.loan.symbol;
  const bill = e.bill.symbol;
  return (
    <span className="mt-3 block space-y-2" data-convert-estimate={`${loan}-for-${bill}`}>
      <span className="block">
        You borrow <Num data-convert-x={e.amountIn.toString()}>{money(e.amountIn, loan)}</Num> (about ${formatUnitsExact(e.usd, 6)}) and Circle converts it into {bill} for the bill.
      </span>
      <span className="block" data-convert-rate>
        Worst case, {rateText(e.total, e.amountIn, loan, bill)}. The swap must return at least {money(e.total, bill)}, or the whole payment is undone and nothing moves. Whatever it does not
        need stays in your wallet.
      </span>
      <span className="block">
        Circle&apos;s fee is 0.02%, about {money(e.fee, loan)}. The amount borrowed includes a {cushion} cushion over today&apos;s euro price.
      </span>
      <span className="block" data-convert-pledge={e.pledge.toString()}>
        {e.pledge === 0n ? (
          <>You pledge no extra cirBTC: what you already pledged covers this.</>
        ) : (
          <>
            You pledge <Num>{formatUnitsExact(e.pledge, CIRBTC_DECIMALS)} cirBTC</Num>
            {usdHint(e.pledge, usd)} and keep it.
          </>
        )}
      </span>
      {e.sharedBorrow > 0n && (
        <span className="block" data-convert-shared>
          This includes the {money(e.sharedBorrow, loan)} loan for your {loan} bills paid from bitcoin: both borrow in the same Morpho market, so one pledge covers them.
        </span>
      )}
      <span className="block" data-convert-ltv>
        Loan-to-value after: <Num>{formatPercentWad(e.ltvAfter)}</Num> in Morpho&apos;s {loan} market (Adag refuses anything over {formatPercentWad(MAX_LTV_WAD)}). Bitcoin can fall{" "}
        {formatPercentWad(e.drop)} before Morpho may liquidate.
      </span>
      <span className="block">Network fee: {keepText(e.keepUpTo)}. Arc refunds what it does not use.</span>
      <span className="block space-y-1 border-t border-rule pt-2 text-text" data-convert-plain>
        <span className="block">Your debt will be in {loan}. Its dollar cost moves with the euro.</span>
        <span className="block">Adag checks the 40% limit only now, when you pay.</span>
        <span className="block">The loan guard can only repay this loan from {loan} in your wallet.</span>
      </span>
      <span className="type-micro block normal-case tracking-[0.04em]" data-convert-block>
        Read together at Arc block {e.blockNumber.toString()}.
      </span>
    </span>
  );
}

// The same for closing a loan with the other currency (C75).
export function CloseConvertEstimate({ e }: { e: CloseEstimate }) {
  const sold = e.sold.symbol;
  const loan = e.loan.symbol;
  return (
    <span className="mt-3 block space-y-2" data-close-estimate={`${sold}-for-${loan}`}>
      <span className="block">
        You sell <Num data-close-x={e.amountIn.toString()}>{money(e.amountIn, sold)}</Num> (about ${formatUnitsExact(e.usd, 6)}) through Circle for at least {money(e.approval, loan)}, the
        amount this close needs.
      </span>
      <span className="block" data-close-rate>
        Worst case, {rateText(e.approval, e.amountIn, sold, loan)}. If the swap returns less, the whole close is undone and nothing moves. Whatever the loan does not need stays in
        your wallet.
      </span>
      <span className="block">
        Circle&apos;s fee is 0.02%, about {money(e.fee, sold)}. The amount sold includes a {cushion} cushion over today&apos;s euro price.
      </span>
      <span className="block">Then Adag repays your loan by its exact shares and takes all your cirBTC back, in the same signature.</span>
      <span className="block">Network fee: {keepText(e.keepUpTo)}. Arc refunds what it does not use.</span>
      <span className="type-micro block normal-case tracking-[0.04em]" data-convert-block>
        Read together at Arc block {e.blockNumber.toString()}.
      </span>
    </span>
  );
}

// Shown when Circle's adapter already holds access to the wallet: one signature takes it back, then the option opens.
export function ConvertReset({ account, loanToken, canSign, onDone, className = "" }: { account: Address; loanToken: Address; canSign: boolean; onDone: () => void; className?: string }) {
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
        {state.kind === "busy" ? "Confirm in your wallet" : "Set Circle's adapter access to 0"}
      </Button>
      {state.kind === "busy" && <p className="type-body mt-2 text-muted">Nothing else changes: this only takes access away.</p>}
      {state.kind === "failed" && (
        <p className="type-body mt-2 text-danger" data-convert-reset-failed>
          {state.message}
        </p>
      )}
      {state.kind === "done" && (
        <p className="type-body mt-2 text-text" data-convert-reset-done>
          Circle&apos;s adapter has no access to your wallet now.{" "}
          {state.hash && (
            <a href={`${EXPLORER}/tx/${state.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold hover:text-text">
              {shortAddress(state.hash)} on the explorer
            </a>
          )}
        </p>
      )}
    </div>
  );
}

export const convertTitle = (loan: Currency) => `From bitcoin, borrowing ${loan.symbol}`;
