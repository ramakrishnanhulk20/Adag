"use client";

import { useMemo } from "react";
import { motion } from "motion/react";
import { isAddressEqual, type Address } from "viem";
import { arc } from "viem/chains";
import { useReadContracts } from "wagmi";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { adagAbi, erc20Abi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { billFromJson, type BillJson } from "@/lib/pay/billJson";
import { suggestPledge } from "@/lib/pay/build";
import {
  ADAG_BILLS,
  BILL_STATUS,
  CIRBTC,
  CIRBTC_DECIMALS,
  CURRENCIES,
  EURC,
  EURC_MARKET_ORACLE,
  MARKET_EURC,
  MARKET_USDC,
  MAX_LTV_WAD,
  MORPHO,
  USDC,
  USDC_MARKET_ORACLE,
  type Currency,
} from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";
import { debtFromShares, liquidationDropWad, ltvWad } from "@/lib/pay/loan";
import { currencyOf } from "@/lib/pay/market";
import { useWallet } from "@/lib/wallet/useWallet";

const PENDING = "Wired in the next step";

type Read = { status: "success"; result: unknown } | { status: "failure"; error: Error };
type Cell<T> = { state: "loading" } | { state: "unavailable" } | { state: "ok"; value: T };

const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
};
const rise = (i: number) => ({ ...reveal, transition: { duration: 0.7, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] as const } });

function Value<T>({ cell, render, className = "" }: { cell: Cell<T>; render: (v: T) => React.ReactNode; className?: string }) {
  if (cell.state === "loading") return <span aria-label="Loading" className="live-shimmer inline-block h-[0.9em] w-24 rounded-[2px] align-middle" />;
  // C19: a failed read says so. It never falls back to zero.
  if (cell.state === "unavailable") return <span className="type-label text-muted">unavailable</span>;
  return <span className={className}>{render(cell.value)}</span>;
}

function PendingAction({ children, variant = "secondary" }: { children: React.ReactNode; variant?: "primary" | "secondary" }) {
  return (
    <span className="flex flex-col gap-2">
      <Button variant={variant} disabled className="w-full md:w-auto">
        {children}
      </Button>
      <span className="type-micro text-muted">{PENDING}</span>
    </span>
  );
}

export function BillWallet({ bill: json }: { bill: BillJson }) {
  const bill = useMemo(() => billFromJson(json), [json]);
  const wallet = useWallet();
  const open = bill.status === BILL_STATUS.Open;

  if (wallet.status !== "connected") {
    if (!open) return null;
    return (
      <section className="px-5 pb-20 md:px-[6vw] md:pb-28" aria-label="Pay this bill">
        <motion.div {...rise(0)} className="app-panel flex flex-col gap-6 p-6 md:flex-row md:items-center md:justify-between md:p-8">
          <p className="type-lead max-w-[36rem] text-text">
            Connect a wallet to see your balances and exactly what paying from bitcoin would do to your loan.
          </p>
          <div className="flex flex-col gap-3 md:flex-row">
            <PendingAction variant="primary">Pay from balance</PendingAction>
            <PendingAction>Pay from bitcoin</PendingAction>
          </div>
        </motion.div>
      </section>
    );
  }

  return <ConnectedWallet address={wallet.address} bill={bill} />;
}

function ConnectedWallet({ address, bill }: { address: Address; bill: ReturnType<typeof billFromJson> }) {
  const currency = currencyOf(bill.currency);
  const isPayee = isAddressEqual(address, bill.payee);
  const open = bill.status === BILL_STATUS.Open;
  const m = currency?.marketId ?? MARKET_USDC;

  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { chainId: arc.id, address: USDC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { chainId: arc.id, address: EURC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { chainId: arc.id, address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] },
      { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_USDC, address] },
      { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "market", args: [MARKET_USDC] },
      { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_EURC, address] },
      { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "market", args: [MARKET_EURC] },
      { chainId: arc.id, address: ADAG_BILLS, abi: adagAbi, functionName: "loanToValue", args: [address, MARKET_USDC] },
      { chainId: arc.id, address: ADAG_BILLS, abi: adagAbi, functionName: "loanToValue", args: [address, MARKET_EURC] },
      { chainId: arc.id, address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [m] },
      { chainId: arc.id, address: USDC_MARKET_ORACLE, abi: oracleAbi, functionName: "price" },
      { chainId: arc.id, address: EURC_MARKET_ORACLE, abi: oracleAbi, functionName: "price" },
      { chainId: arc.id, address: ADAG_BILLS, abi: adagAbi, functionName: "collateralNeeded", args: [address, m, bill.amount] },
    ],
    query: { refetchInterval: 30_000 },
  });

  function cell<T>(i: number): Cell<T> {
    if (reads.isPending) return { state: "loading" };
    const r = reads.data?.[i] as Read | undefined;
    if (reads.isError || !r || r.status !== "success") return { state: "unavailable" };
    return { state: "ok", value: r.result as T };
  }

  type Position = readonly [bigint, bigint, bigint];
  type MarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
  const balances = [cell<bigint>(0), cell<bigint>(1), cell<bigint>(2)] as const;
  const markets = [
    { currency: CURRENCIES[0]!, position: cell<Position>(3), market: cell<MarketState>(4), ltv: cell<bigint>(7), price: cell<bigint>(10) },
    { currency: CURRENCIES[1]!, position: cell<Position>(5), market: cell<MarketState>(6), ltv: cell<bigint>(8), price: cell<bigint>(11) },
  ];
  const priceStatus = cell<readonly [boolean, bigint, bigint]>(9);
  const needed = cell<bigint>(12);
  const billMarket = markets.find((x) => x.currency.marketId === m)!;
  const billBalance = currency?.symbol === "EURC" ? balances[1] : balances[0];

  return (
    <section className="px-5 pb-20 md:px-[6vw] md:pb-28" aria-labelledby="wallet-title">
      <motion.div {...rise(0)} className="flex flex-wrap items-center gap-4 border-t border-rule pt-10">
        <Hallmark tone="quiet">Your wallet</Hallmark>
        <span className="type-address break-all text-muted">{address}</span>
        <h2 id="wallet-title" className="type-h2 mt-2 w-full text-text">
          {open && !isPayee ? "What paying would do." : "Your position on Arc."}
        </h2>
      </motion.div>

      <div className="mt-10 grid gap-5 md:grid-cols-12 md:gap-6">
        <motion.div {...rise(1)} className="md:col-span-5">
          {isPayee ? (
            <PayeePanel open={open} />
          ) : open && currency ? (
            <PledgePanel
              currency={currency}
              amount={bill.amount}
              needed={needed}
              priceStatus={priceStatus}
              cirBtc={balances[2]}
              balance={billBalance}
              market={billMarket}
            />
          ) : (
            <div className="app-panel p-6 md:p-8">
              <p className="type-label text-muted">This bill</p>
              <p className="type-lead mt-4 text-text">
                {bill.status === BILL_STATUS.Paid ? "Already paid. Nothing to pay here." : "Cancelled. It can never be paid."}
              </p>
            </div>
          )}
        </motion.div>

        <div className="grid gap-5 md:col-span-7 md:gap-6">
          <motion.div {...rise(2)} className="app-panel p-6 md:p-8">
            <p className="type-label text-muted">In this wallet</p>
            <dl className="mt-5 grid grid-cols-1 gap-5 sm:grid-cols-3">
              {(["USDC", "EURC", "cirBTC"] as const).map((symbol, i) => (
                <div key={symbol}>
                  <dt className="type-micro text-muted">{symbol}</dt>
                  <dd className="mt-2 font-display text-[1.75rem] leading-none font-medium tabular-nums text-text">
                    <Value cell={balances[i]!} render={(v) => formatUnitsExact(v, symbol === "cirBTC" ? CIRBTC_DECIMALS : 6)} />
                  </dd>
                </div>
              ))}
            </dl>
          </motion.div>

          <motion.div {...rise(3)} className="app-panel p-6 md:p-8">
            <p className="type-label text-muted">Morpho positions</p>
            <div className="mt-5 grid gap-6 sm:grid-cols-2">
              {markets.map((x) => (
                <MarketCard key={x.currency.symbol} {...x} />
              ))}
            </div>
          </motion.div>
        </div>
      </div>

      <motion.div {...rise(4)} className="mt-6">
        <PriceLine priceStatus={priceStatus} symbol={currency?.symbol ?? "USDC"} />
      </motion.div>
    </section>
  );
}

function PayeePanel({ open }: { open: boolean }) {
  return (
    <div className="app-panel h-full p-6 md:p-8">
      <p className="type-label text-gold">You wrote this bill</p>
      <p className="type-lead mt-4 text-text">
        {open ? "Share this page's link with whoever owes it. You can cancel it until someone pays." : "It is closed. Nothing more to do here."}
      </p>
      {open && (
        <div className="mt-8">
          <PendingAction>Void this bill</PendingAction>
        </div>
      )}
    </div>
  );
}

type MarketCardProps = {
  currency: Currency;
  position: Cell<readonly [bigint, bigint, bigint]>;
  market: Cell<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>;
  ltv: Cell<bigint>;
};

function MarketCard({ currency, position, market, ltv }: MarketCardProps) {
  const debt: Cell<bigint> =
    position.state === "ok" && market.state === "ok"
      ? { state: "ok", value: debtFromShares(position.value[1], market.value[2], market.value[3]) }
      : position.state === "loading" || market.state === "loading"
        ? { state: "loading" }
        : { state: "unavailable" };
  const pledged: Cell<bigint> = position.state === "ok" ? { state: "ok", value: position.value[2] } : position;
  const drop: Cell<bigint> = ltv.state === "ok" ? { state: "ok", value: liquidationDropWad(ltv.value, currency.params.lltv) } : ltv;

  return (
    <div className="border-l border-rule pl-4">
      <p className="type-micro text-text">{currency.symbol} against cirBTC</p>
      <dl className="mt-3 space-y-2">
        <div className="flex items-baseline justify-between gap-3">
          <dt className="type-body text-muted">Pledged</dt>
          <dd className="type-body tabular-nums text-text">
            <Value cell={pledged} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC`} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="type-body text-muted">Loan</dt>
          <dd className="type-body tabular-nums text-text">
            <Value cell={debt} render={(v) => `${formatUnitsExact(v, currency.decimals)} ${currency.symbol}`} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="type-body text-muted">Loan-to-value</dt>
          <dd className="type-body tabular-nums text-text">
            <Value cell={ltv} render={(v) => formatPercentWad(v)} />
          </dd>
        </div>
        <div className="flex items-baseline justify-between gap-3">
          <dt className="type-body text-muted">BTC can fall</dt>
          <dd className="type-body tabular-nums text-text">
            <Value cell={drop} render={(v) => (ltv.state === "ok" && ltv.value === 0n ? "no loan" : formatPercentWad(v))} />
          </dd>
        </div>
      </dl>
    </div>
  );
}

type PledgePanelProps = {
  currency: Currency;
  amount: bigint;
  needed: Cell<bigint>;
  priceStatus: Cell<readonly [boolean, bigint, bigint]>;
  cirBtc: Cell<bigint>;
  balance: Cell<bigint>;
  market: { position: Cell<readonly [bigint, bigint, bigint]>; market: Cell<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>; price: Cell<bigint> };
};

function PledgePanel({ currency, amount, needed, priceStatus, cirBtc, balance, market }: PledgePanelProps) {
  const fresh = priceStatus.state === "ok" ? priceStatus.value[0] : null;
  const pledge: Cell<bigint> = needed.state === "ok" ? { state: "ok", value: suggestPledge(needed.value) } : needed;

  // The preview uses the contract's own rounding (loan.ts). It is a preview: the contract's check at payment decides.
  let after: Cell<{ ltv: bigint; drop: bigint }> = { state: "loading" };
  if (pledge.state === "ok" && market.position.state === "ok" && market.market.state === "ok" && market.price.state === "ok") {
    const debt = debtFromShares(market.position.value[1], market.market.value[2], market.market.value[3]) + amount;
    const ltv = ltvWad(debt, market.position.value[2] + pledge.value, market.price.value);
    after = { state: "ok", value: { ltv, drop: liquidationDropWad(ltv, currency.params.lltv) } };
  } else if ([pledge, market.position, market.market, market.price].some((c) => c.state === "unavailable")) {
    after = { state: "unavailable" };
  }

  const short = pledge.state === "ok" && cirBtc.state === "ok" && cirBtc.value < pledge.value;
  const enough = balance.state === "ok" ? balance.value >= amount : null;

  return (
    <div className="app-panel flex h-full flex-col p-6 md:p-8">
      <p className="type-label text-muted">Pay from bitcoin: suggested pledge</p>
      {fresh === false ? (
        <p className="type-lead mt-5 text-text">New loans are paused until the bitcoin price updates. Paying from your balance still works.</p>
      ) : (
        <>
          <p className="mt-5 font-display text-[clamp(2.25rem,4.2vw,3.5rem)] leading-none font-medium tabular-nums text-text">
            <Value cell={pledge} render={(v) => (v === 0n ? "Nothing more" : formatUnitsExact(v, CIRBTC_DECIMALS))} />
            {pledge.state === "ok" && pledge.value > 0n && <span className="ml-2 font-display text-[0.45em] italic text-gold">cirBTC</span>}
          </p>
          <p className="type-body mt-3 text-muted">
            {pledge.state === "ok" && pledge.value === 0n
              ? "The bitcoin you already pledged covers this loan at 40%."
              : "Adag's own figure, plus a 5% margin for price moves and one satoshi for rounding. The contract's 40% check at payment is the real guard."}
          </p>
          <dl className="mt-6 grid grid-cols-2 gap-4 border-t border-rule pt-5">
            <div>
              <dt className="type-micro text-muted">Loan-to-value after</dt>
              <dd className="mt-2 font-display text-[1.75rem] leading-none font-medium tabular-nums text-text">
                <Value cell={after} render={(v) => formatPercentWad(v.ltv)} />
              </dd>
              <dd className="type-micro mt-2 text-muted">Adag&apos;s line is {formatPercentWad(MAX_LTV_WAD)}</dd>
            </div>
            <div>
              <dt className="type-micro text-muted">BTC can then fall</dt>
              <dd className="mt-2 font-display text-[1.75rem] leading-none font-medium tabular-nums text-text">
                <Value cell={after} render={(v) => formatPercentWad(v.drop)} />
              </dd>
              <dd className="type-micro mt-2 text-muted">before Morpho may liquidate at {formatPercentWad(currency.params.lltv)}</dd>
            </div>
          </dl>
          {short && <p className="type-body mt-5 text-danger">Your wallet holds less cirBTC than this pledge.</p>}
        </>
      )}
      <p className="type-body mt-5 text-muted">
        {enough === null
          ? `Your ${currency.symbol} balance is unavailable right now.`
          : enough
            ? `You hold enough ${currency.symbol} to pay from balance.`
            : `You hold less ${currency.symbol} than this bill, so paying from balance would fail.`}
      </p>
      <div className="mt-auto flex flex-col gap-3 pt-8 md:flex-row">
        {/* C24: the bitcoin path is only offered while the price is fresh. */}
        {fresh !== false && <PendingAction variant="primary">Pay from bitcoin</PendingAction>}
        <PendingAction variant={fresh === false ? "primary" : "secondary"}>Pay from balance</PendingAction>
      </div>
    </div>
  );
}

function PriceLine({ priceStatus, symbol }: { priceStatus: Cell<readonly [boolean, bigint, bigint]>; symbol: string }) {
  if (priceStatus.state !== "ok") {
    return (
      <p className="type-body flex items-center gap-3 text-muted">
        <span aria-hidden="true" className="diamond !bg-rule-strong" />
        Bitcoin price status: <Value cell={priceStatus} render={() => null} />
      </p>
    );
  }
  const [fresh, btcAt] = priceStatus.value;
  const hours = Math.max(0, (Date.now() / 1000 - Number(btcAt)) / 3600);
  return (
    <p className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 text-text">
      <span aria-hidden="true" className={`diamond ${fresh ? "!bg-success" : "!bg-danger"}`} />
      {fresh ? `Bitcoin price live for the ${symbol} market.` : "Bitcoin price paused: new loans wait for the next update."}
      <span className="text-muted">Chainlink BTC/USD updated {hours < 1 ? `${Math.round(hours * 60)} minutes` : `${hours.toFixed(1)} hours`} ago.</span>
    </p>
  );
}
