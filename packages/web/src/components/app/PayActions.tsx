"use client";

import { useCallback, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { Button } from "@/components/Button";
import { adagAbi, erc20Abi, morphoAbi } from "@/lib/pay/abi";
import { buildPayFromBalance, buildPayFromBitcoin, suggestPledge, type Bill } from "@/lib/pay/build";
import { BILL_STATUS, CIRBTC, CIRBTC_DECIMALS, EXPLORER, MAX_LTV_WAD, MORPHO, ADAG_BILLS, type Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";
import { debtFromShares, liquidationDropWad, ltvWad } from "@/lib/pay/loan";
import { paramsFromTuple } from "@/lib/pay/market";
import { billPaidIn } from "@/lib/pay/receipt";
import { hasAcceptedMorphoDisclaimer, rememberMorphoDisclaimer } from "@/lib/wallet/consent";
import { feesNow, publicArc, simulateAndSend } from "@/lib/wallet/send";
import { Value, type Cell } from "./cells";
import { e2ePledge } from "./e2eHook";
import { MorphoDisclaimer } from "./MorphoDisclaimer";
import { SuccessCard } from "./SuccessCard";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";

type Position = readonly [bigint, bigint, bigint];
type MarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

export type PayActionsProps = {
  bill: Bill;
  address: Address;
  currency: Currency;
  balance: Cell<bigint>;
  cirBtc: Cell<bigint>;
  position: Cell<Position>;
  market: Cell<MarketState>;
  price: Cell<bigint>;
  priceStatus: Cell<readonly [boolean, bigint, bigint]>;
  needed: Cell<bigint>;
  borrowApy: Cell<number>;
  onSettled: () => void;
};

type Paid = { method: "balance" | "bitcoin"; hash: Hex; loanChecked: boolean; ltvAfter?: bigint; sold?: bigint; pledged?: bigint };

// Rounded up to four decimals: it is an estimate, and it should never read cheaper than it is.
const feeText = (wei: bigint) => {
  const step = 10n ** 14n;
  return `about ${formatUnitsExact(((wei + step - 1n) / step) * step, 18)} USDC`;
};

export function PayActions(props: PayActionsProps) {
  const { bill, address, currency, balance, cirBtc, position, market, price, priceStatus, needed, borrowApy, onSettled } = props;
  const router = useRouter();
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [paid, setPaid] = useState<Paid | null>(null);
  const [asking, setAsking] = useState(false);
  const [active, setActive] = useState<"balance" | "bitcoin" | null>(null);
  const busy = tx.kind === "busy";
  const step = (s: Parameters<typeof simulateAndSend>[0]["onStep"] extends (x: infer T) => void ? T : never) =>
    setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));

  const fresh = priceStatus.state === "ok" ? priceStatus.value[0] : null;
  const pledge: Cell<bigint> = needed.state === "ok" ? { state: "ok", value: suggestPledge(needed.value) } : needed;
  const enough = balance.state === "ok" ? balance.value >= bill.amount : null;
  const shortOfBtc = pledge.state === "ok" && cirBtc.state === "ok" && cirBtc.value < pledge.value;

  let after: Cell<{ ltv: bigint; drop: bigint }> = { state: "loading" };
  if (pledge.state === "ok" && position.state === "ok" && market.state === "ok" && price.state === "ok") {
    // Same rounding as the contract; the contract's own check at payment is what decides (C13).
    const debt = debtFromShares(position.value[1], market.value[2], market.value[3]) + bill.amount;
    const ltv = ltvWad(debt, position.value[2] + pledge.value, price.value);
    after = { state: "ok", value: { ltv, drop: liquidationDropWad(ltv, currency.params.lltv) } };
  } else if ([pledge, position, market, price].some((c) => c.state === "unavailable")) {
    after = { state: "unavailable" };
  }

  const pledgeValue = pledge.state === "ok" ? pledge.value : null;
  const feeQuery = useQuery({
    queryKey: ["adag-fee", bill.id.toString(), address, pledgeValue?.toString()],
    enabled: fresh === true && pledgeValue !== null && !shortOfBtc && !paid,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      // The fixed params go in here; the real payment re-reads Morpho's and proves them by hash before building.
      const built = buildPayFromBitcoin(bill, address, pledgeValue!, currency.params);
      const client = publicArc();
      const [gas, fees] = await Promise.all([client.estimateGas({ account: address, to: built.to, data: built.data }), feesNow()]);
      return gas * fees.expected;
    },
  });
  const fee: Cell<bigint> = feeQuery.isPending ? { state: "loading" } : feeQuery.isError || feeQuery.data === undefined ? { state: "unavailable" } : { state: "ok", value: feeQuery.data };

  const finish = useCallback(
    async (method: Paid["method"], hash: Hex, logs: Parameters<typeof billPaidIn>[0], extra: () => Promise<Partial<Paid>>) => {
      const client = publicArc();
      const record = await client.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [bill.id] });
      const proof = billPaidIn(logs, bill.id);
      if (record.status !== BILL_STATUS.Paid || !proof) {
        setTx({ kind: "failed", message: "Arc confirmed the transaction, but Adag has no payment record for this bill in it. Check the link before trying again.", href: `${EXPLORER}/tx/${hash}` });
        return;
      }
      const more = await extra().catch(() => ({}));
      setPaid({ method, hash, loanChecked: proof.loanChecked, ...more });
      setTx({ kind: "idle" });
      onSettled();
      router.refresh();
    },
    [bill.id, onSettled, router],
  );

  const payFromBalance = async () => {
    setActive("balance");
    let built;
    try {
      built = buildPayFromBalance(bill, address);
    } catch (error) {
      setTx({ kind: "failed", message: (error as Error).message });
      return;
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step });
    if (!out.ok) {
      setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    await finish("balance", out.hash, out.receipt.logs, async () => ({}));
  };

  const payFromBitcoin = async () => {
    setActive("bitcoin");
    step("checking");
    const client = publicArc();
    const m = currency.marketId;
    let status: readonly [boolean, bigint, bigint];
    let freshNeeded: bigint;
    let tuple: readonly [Hex, Hex, Hex, Hex, bigint];
    let held: bigint;
    let before: Position;
    try {
      // Read again at the moment of paying: the page's figures may be a minute old.
      [status, freshNeeded, tuple, held, before] = await Promise.all([
        client.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [m] }),
        client.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "collateralNeeded", args: [address, m, bill.amount] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m] }),
        client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
      ]);
    } catch {
      setTx({ kind: "failed", message: "Arc did not answer, so the payment was not built. Nothing was sent. Try again." });
      return;
    }
    if (!status[0]) {
      setTx({ kind: "failed", message: "New loans are paused until the bitcoin price updates. Paying from your balance still works." });
      return;
    }
    const chosen = e2ePledge(suggestPledge(freshNeeded));
    if (held < chosen) {
      setTx({ kind: "failed", message: `This payment pledges ${formatUnitsExact(chosen, CIRBTC_DECIMALS)} cirBTC and your wallet holds ${formatUnitsExact(held, CIRBTC_DECIMALS)}. Nothing was sent.` });
      return;
    }
    let built;
    try {
      // Morpho's answer is proven by hash against the fixed market id inside the builder (C3).
      built = buildPayFromBitcoin(bill, address, chosen, paramsFromTuple(tuple));
    } catch (error) {
      setTx({ kind: "failed", message: `${(error as Error).message} Nothing was sent.` });
      return;
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step });
    if (!out.ok) {
      setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    await finish("bitcoin", out.hash, out.receipt.logs, async () => {
      const [heldAfter, afterPos, ltv] = await Promise.all([
        client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
        client.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "loanToValue", args: [address, m] }),
      ]);
      // Bitcoin sold is what left the wallet and the pledge together. Pledging moves it; it does not sell it.
      return { ltvAfter: ltv, sold: held + before[2] - (heldAfter + afterPos[2]), pledged: chosen };
    });
  };

  const onBitcoin = () => {
    setTx({ kind: "idle" });
    if (hasAcceptedMorphoDisclaimer(address)) void payFromBitcoin();
    else setAsking(true);
  };

  if (paid) {
    const amount = `${formatUnitsExact(bill.amount, currency.decimals)} ${currency.symbol}`;
    return (
      <SuccessCard
        status="paid"
        hash={paid.hash}
        title={`Bill #${bill.id} is paid.`}
        rows={[
          { label: "Supplier received", value: amount },
          { label: "Paid from", value: paid.method === "balance" ? `Your ${currency.symbol} balance` : "A loan against your cirBTC" },
          ...(paid.method === "bitcoin"
            ? [
                { label: "Bitcoin sold", value: paid.sold !== undefined ? `${paid.sold === 0n ? "0" : formatUnitsExact(paid.sold, CIRBTC_DECIMALS)} cirBTC` : "unavailable" },
                { label: "Pledged now", value: paid.pledged !== undefined ? `${formatUnitsExact(paid.pledged, CIRBTC_DECIMALS)} cirBTC more` : "unavailable" },
                { label: "Loan-to-value after", value: paid.ltvAfter !== undefined ? formatPercentWad(paid.ltvAfter) : "unavailable" },
                { label: "40% check", value: paid.loanChecked ? "Ran and passed" : "Not needed" },
              ]
            : []),
        ]}
      />
    );
  }

  const busyStep = tx.kind === "busy" ? tx : null;
  return (
    <div className="app-panel flex h-full flex-col p-6 md:p-8">
      <p className="type-label text-muted">Pay this bill</p>

      <div className="mt-5 border-b border-rule pb-6">
        <p className="type-h4 text-text">From your balance</p>
        <p className="type-body mt-2 text-muted">
          {enough === null
            ? `Your ${currency.symbol} balance is unavailable right now.`
            : enough
              ? `You hold ${formatUnitsExact((balance as { value: bigint }).value, currency.decimals)} ${currency.symbol}. One signature approves exactly this amount and pays.`
              : `You hold less ${currency.symbol} than this bill, so paying from balance is not offered.`}
        </p>
        {enough && (
          <Button variant={fresh ? "secondary" : "primary"} disabled={busy} onClick={() => void payFromBalance()} className="mt-5 w-full md:w-auto" data-action="pay-balance">
            {busyStep && active === "balance" ? <BusyLabel step={busyStep.step} since={busyStep.since} /> : `Pay ${formatUnitsExact(bill.amount, currency.decimals)} ${currency.symbol} from balance`}
          </Button>
        )}
      </div>

      <div className="pt-6">
        <p className="type-h4 text-text">From bitcoin</p>
        {fresh === false ? (
          // C24: no bitcoin path while the price is stale.
          <p className="type-body mt-2 text-text" data-price="stale">
            New loans are paused until the bitcoin price updates. Paying from your balance still works.
          </p>
        ) : (
          <>
            <p className="type-body mt-2 text-muted">Pledge cirBTC on Morpho, borrow exactly the bill, pay it. One signature, and no bitcoin is sold.</p>
            <dl className="mt-5 grid grid-cols-2 gap-x-6 gap-y-5">
              <Figure label="Suggested pledge" cell={pledge} render={(v) => (v === 0n ? "Nothing more" : `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC`)} note="Adag's figure plus 5%, plus 1 satoshi" />
              <Figure label="cirBTC in your wallet" cell={cirBtc} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC`} />
              <Figure label="Loan-to-value after" cell={after} render={(v) => formatPercentWad(v.ltv)} note={`Adag's line is ${formatPercentWad(MAX_LTV_WAD)}`} />
              <Figure label="BTC can then fall" cell={after} render={(v) => formatPercentWad(v.drop)} note={`before Morpho may liquidate at ${formatPercentWad(currency.params.lltv)}`} />
              <Figure label="Morpho borrow rate" cell={borrowApy} render={(v) => `${(v * 100).toFixed(2)}% a year`} note="live, variable" />
              <Figure label="Network fee" cell={fee} render={feeText} note="estimated, paid in USDC" />
            </dl>
            {shortOfBtc && <p className="type-body mt-5 text-danger">Your wallet holds less cirBTC than this pledge.</p>}
            <Button variant="primary" disabled={busy || fresh !== true || shortOfBtc || pledge.state !== "ok"} onClick={onBitcoin} className="mt-6 w-full md:w-auto" data-action="pay-bitcoin">
              {busyStep && active === "bitcoin" ? <BusyLabel step={busyStep.step} since={busyStep.since} /> : "Pay from bitcoin"}
            </Button>
          </>
        )}
      </div>

      <div className="mt-5">
        <TxMessage state={tx} />
      </div>

      <MorphoDisclaimer
        open={asking}
        onCancel={() => setAsking(false)}
        onAccept={() => {
          rememberMorphoDisclaimer(address);
          setAsking(false);
          void payFromBitcoin();
        }}
      />
    </div>
  );
}

function Figure<T>({ label, cell, render, note }: { label: string; cell: Cell<T>; render: (v: T) => React.ReactNode; note?: string }) {
  return (
    <div>
      <dt className="type-micro text-muted">{label}</dt>
      <dd className="mt-2 font-display text-[1.5rem] leading-none font-medium tabular-nums text-text">
        <Value cell={cell} render={render} />
      </dd>
      {note && <dd className="type-micro mt-2 text-muted normal-case tracking-[0.04em]">{note}</dd>}
    </div>
  );
}
