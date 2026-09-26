"use client";

import { useCallback, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { isAddressEqual, type Address, type Hex } from "viem";
import { arc } from "viem/chains";
import { useBlock, useReadContract, useReadContracts } from "wagmi";
import { Hallmark } from "@/components/Hallmark";
import { adagAbi, erc20Abi, irmAbi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { billFromJson, type BillJson } from "@/lib/pay/billJson";
import type { Bill } from "@/lib/pay/build";
import { blockers, type Blocker, type MarketInput } from "@/lib/pay/enrol";
import {
  ADAG_BILLS,
  deploymentOf,
  BILL_STATUS,
  CIRBTC,
  CIRBTC_DECIMALS,
  CURRENCIES,
  EURC,
  EURC_MARKET_ORACLE,
  MARKET_EURC,
  MARKET_USDC,
  MORPHO,
  USDC,
  USDC_MARKET_ORACLE,
  type Currency,
} from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";
import { debtFromShares, liquidationDropWad } from "@/lib/pay/loan";
import { currencyOf } from "@/lib/pay/market";
import { readyToSign, useWallet, type WalletState } from "@/lib/wallet/useWallet";
import { RetryContext, Value, rise, type Cell } from "./cells";
import { ConnectButton } from "./ConnectButton";
import { GetSetUp } from "./GetSetUp";
import { PayActions } from "./PayActions";
import { FirstContractSafeNote, PayAsSwitch, usePayAsMode } from "./PayAs";
import { SafePay } from "./SafePay";
import { VoidAction } from "./VoidAction";
import { SMART_ACCOUNT_SENTENCE } from "./WalletNotice";

type Read = { status: "success"; result: unknown } | { status: "failure"; error: Error };
type Position = readonly [bigint, bigint, bigint];
type MarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];

const SECONDS_PER_YEAR = 31_536_000;

// Why this wallet cannot sign right now, in words. null means it can (C4 and the plain-wallet rule).
function blockedReason(wallet: WalletState): string | null {
  if (readyToSign(wallet)) return null;
  if (wallet.status !== "connected") return "Connect a wallet to continue.";
  if (!wallet.onArc) return "Your wallet is on another network. Switch it to Arc to continue; nothing is built until then.";
  if (wallet.kind === "smart") return SMART_ACCOUNT_SENTENCE;
  if (wallet.kind === "unavailable") return "Could not check this wallet's type on Arc. Reload to try again.";
  return "Checking your wallet on Arc.";
}

export function BillWallet({ bill: json, paidTxUrl = null }: { bill: BillJson; paidTxUrl?: string | null }) {
  const bill = useMemo(() => billFromJson(json), [json]);
  const wallet = useWallet();
  const open = bill.status === BILL_STATUS.Open;
  // Whether this page opened on an open bill, so a payment that lands while it is on screen reads as "just now".
  const openAtLoad = useRef(open);

  if (wallet.status !== "connected") {
    if (!open) return null;
    return (
      <section className="px-5 pb-20 md:px-[6vw] md:pb-28" aria-label="Pay this bill">
        <motion.div {...rise(0)} className="app-panel p-6 md:p-8">
          <div className="flex flex-col gap-6 md:flex-row md:items-center md:justify-between">
            <p className="type-lead max-w-[36rem] text-text">
              Connect a wallet to pay this bill from your balance, or from a loan against your cirBTC, in one signature.
            </p>
            <ConnectButton />
          </div>
          <GetSetUp needs={["arc", "cirbtc", "usdc"]} className="mt-6" />
        </motion.div>
      </section>
    );
  }

  return <ConnectedWallet address={wallet.address} bill={bill} wallet={wallet} justPaid={openAtLoad.current && bill.status === BILL_STATUS.Paid} paidTxUrl={paidTxUrl} />;
}

type ConnectedProps = { address: Address; bill: Bill; wallet: WalletState; justPaid: boolean; paidTxUrl: string | null };

function ConnectedWallet({ address, bill, wallet, justPaid, paidTxUrl }: ConnectedProps) {
  const currency = currencyOf(bill.currency);
  const isPayee = isAddressEqual(address, bill.payee);
  const open = bill.status === BILL_STATUS.Open;
  const m = currency?.marketId ?? MARKET_USDC;
  const reason = blockedReason(wallet);

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
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "loanToValue", args: [address, MARKET_USDC] },
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "loanToValue", args: [address, MARKET_EURC] },
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "priceStatus", args: [m] },
      { chainId: arc.id, address: USDC_MARKET_ORACLE, abi: oracleAbi, functionName: "price" },
      { chainId: arc.id, address: EURC_MARKET_ORACLE, abi: oracleAbi, functionName: "price" },
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "collateralNeeded", args: [address, m, bill.amount] },
      // What the bill's own contract last saw of each loan, and both markets' price status: together they say whether
      // this payment would run the 40% check on a loan the payer already had (the enrol card).
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "seenPosition", args: [address, MARKET_USDC] },
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "seenPosition", args: [address, MARKET_EURC] },
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "priceStatus", args: [MARKET_USDC] },
      { chainId: arc.id, address: bill.contract, abi: adagAbi, functionName: "priceStatus", args: [MARKET_EURC] },
      // Only the current contract has enrol, so this is read from it whatever the bill's contract.
      { chainId: arc.id, address: ADAG_BILLS, abi: adagAbi, functionName: "enrolledAt", args: [address] },
    ],
    query: { refetchInterval: 30_000 },
  });
  // Price age is measured on the chain's own clock, which a test fork can move forward.
  const head = useBlock({ chainId: arc.id, query: { refetchInterval: 30_000 } });

  function cell<T>(i: number): Cell<T> {
    if (reads.isPending) return { state: "loading" };
    const r = reads.data?.[i] as Read | undefined;
    if (reads.isError || !r || r.status !== "success") return { state: "unavailable" };
    return { state: "ok", value: r.result as T };
  }

  const balances = [cell<bigint>(0), cell<bigint>(1), cell<bigint>(2)] as const;
  const markets = [
    { currency: CURRENCIES[0]!, position: cell<Position>(3), market: cell<MarketState>(4), ltv: cell<bigint>(7), price: cell<bigint>(10) },
    { currency: CURRENCIES[1]!, position: cell<Position>(5), market: cell<MarketState>(6), ltv: cell<bigint>(8), price: cell<bigint>(11) },
  ];
  const priceStatus = cell<readonly [boolean, bigint, bigint]>(9);
  const needed = cell<bigint>(12);
  const seen = [cell<readonly [bigint, bigint]>(13), cell<readonly [bigint, bigint]>(14)] as const;
  const statusOf = [cell<readonly [boolean, bigint, bigint]>(15), cell<readonly [boolean, bigint, bigint]>(16)] as const;
  const enrolledAt = cell<bigint>(17);

  // The markets whose 40% check this payment would run on debt the payer already had, and fail. null until every
  // figure is read; the simulation before signing still has the last word.
  function blockersFor(borrowsIn: Hex | null): Blocker[] | null {
    const inputs: MarketInput[] = [];
    for (let i = 0; i < 2; i++) {
      const x = markets[i]!;
      const s = seen[i]!;
      const st = statusOf[i]!;
      if (x.position.state !== "ok" || x.market.state !== "ok" || x.price.state !== "ok" || s.state !== "ok" || st.state !== "ok") return null;
      inputs.push({
        market: x.currency.marketId,
        symbol: x.currency.symbol,
        live: { shares: x.position.value[1], collateral: x.position.value[2] },
        seen: { shares: s.value[0], collateral: s.value[1] },
        totalBorrowAssets: x.market.value[2],
        totalBorrowShares: x.market.value[3],
        price: x.price.value,
        fresh: st.value[0],
      });
    }
    return blockers({ markets: inputs, borrowsIn });
  }
  const enrol = {
    balance: blockersFor(null),
    bitcoin: blockersFor(m),
    // AdagBills refuses a payment in the block the loan was recorded in.
    sameBlock: enrolledAt.state === "ok" && enrolledAt.value > 0n && head.data?.number !== undefined && enrolledAt.value >= head.data.number,
  };
  const billMarket = markets.find((x) => x.currency.marketId === m)!;
  const billBalance = currency?.symbol === "EURC" ? balances[1] : balances[0];

  // Display only (C18): the fixed params and the live market state, through Morpho's own rate model.
  const marketNow = billMarket.market.state === "ok" ? billMarket.market.value : null;
  const rate = useReadContract({
    chainId: arc.id,
    address: currency?.params.irm,
    abi: irmAbi,
    functionName: "borrowRateView",
    args:
      currency && marketNow
        ? [
            currency.params,
            {
              totalSupplyAssets: marketNow[0],
              totalSupplyShares: marketNow[1],
              totalBorrowAssets: marketNow[2],
              totalBorrowShares: marketNow[3],
              lastUpdate: marketNow[4],
              fee: marketNow[5],
            },
          ]
        : undefined,
    query: { enabled: Boolean(currency && marketNow) },
  });
  const apy = rate.data !== undefined ? Math.expm1((Number(rate.data) * SECONDS_PER_YEAR) / 1e18) : null;
  const borrowApy: Cell<number> =
    rate.isError || (rate.data !== undefined && (apy === null || !Number.isFinite(apy) || apy < 0))
      ? { state: "unavailable" }
      : apy === null
        ? billMarket.market.state === "unavailable"
          ? { state: "unavailable" }
          : { state: "loading" }
        : { state: "ok", value: apy };

  // Once this wallet pays here, its receipt card stays on screen after the page refresh reports the bill as paid.
  const [actedHere, setActedHere] = useState(false);
  // F3: who pays, this wallet or a Safe. A Safe cannot pay bills on the first contract, so those get no switch.
  const firstContract = deploymentOf(bill.contract)?.label === "first";
  const payAs = usePayAsMode(address, bill.contract, [bill.id]);
  const safeMode = !firstContract && payAs.mode === "safe";
  // A Safe proposal stays on screen after the bill turns paid, so the owner sees it land.
  const [safeProposed, setSafeProposed] = useState(false);
  const refetch = reads.refetch;
  const retry = useCallback(() => void refetch(), [refetch]);
  const onSettled = useCallback(() => {
    setActedHere(true);
    void refetch();
  }, [refetch]);

  const noPositions = markets.every((x) => x.position.state === "ok" && x.position.value[1] === 0n && x.position.value[2] === 0n);

  return (
    <RetryContext.Provider value={retry}>
    <section className="px-5 pb-20 md:px-[6vw] md:pb-28" aria-labelledby="wallet-title">
      <motion.div {...rise(0)} className="flex flex-wrap items-center gap-4 border-t border-rule pt-10">
        <Hallmark tone="quiet">Your wallet</Hallmark>
        <span className="type-address break-all text-muted">{address}</span>
        <h2 id="wallet-title" className="type-h2 mt-2 w-full text-text">
          {open && !isPayee ? "Pay it in one signature." : "Your position on Arc."}
        </h2>
      </motion.div>

      <div className="mt-10 grid gap-5 md:grid-cols-12 md:gap-6">
        <motion.div {...rise(1)} className="md:col-span-6">
          {isPayee && justPaid ? (
            <PaidJustNow bill={bill} currencySymbol={currency?.symbol ?? ""} decimals={currency?.decimals ?? 6} txUrl={paidTxUrl} />
          ) : isPayee ? (
            <VoidAction bill={bill} address={address} canSign={reason === null} blockedReason={reason} />
          ) : (open || actedHere || safeProposed) && currency ? (
            reason === null || actedHere || safeProposed ? (
              <div className="flex h-full flex-col">
                {open && !actedHere && !firstContract && <PayAsSwitch mode={payAs.mode} onChoose={payAs.choose} className="mb-4" />}
                <div className="min-h-0 flex-1">
                  {safeMode ? (
                    <SafePay bills={[bill]} onProposed={() => setSafeProposed(true)} />
                  ) : (
                    <PayActions
                      bill={bill}
                      address={address}
                      currency={currency}
                      balance={billBalance}
                      cirBtc={balances[2]}
                      position={billMarket.position}
                      market={billMarket.market}
                      price={billMarket.price}
                      priceStatus={priceStatus}
                      needed={needed}
                      borrowApy={borrowApy}
                      onSettled={onSettled}
                      enrol={enrol}
                      onRecorded={retry}
                    />
                  )}
                </div>
              </div>
            ) : (
              <div className="app-panel p-6 md:p-8" data-blocked="true">
                <p className="type-label text-muted">Pay this bill</p>
                <p className="type-lead mt-4 text-text">{reason}</p>
                {wallet.status === "connected" && !wallet.onArc && (
                  <>
                    <div className="mt-6">
                      <ConnectButton />
                    </div>
                    <GetSetUp needs={["arc"]} className="mt-6" />
                  </>
                )}
              </div>
            )
          ) : (
            <div className="app-panel p-6 md:p-8">
              <p className="type-label text-muted">This bill</p>
              <p className="type-lead mt-4 text-text">
                {bill.status === BILL_STATUS.Paid ? "Already paid. Nothing to pay here." : "Cancelled. It can never be paid."}
              </p>
            </div>
          )}
        </motion.div>

        <div className="grid content-start gap-5 md:col-span-6 md:gap-6">
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

          {/* Nothing to show when this wallet has no loan in either market. */}
          {!noPositions && (
            <motion.div {...rise(3)} className="app-panel p-6 md:p-8" data-positions>
              <p className="type-label text-muted">Morpho positions</p>
              <div className="mt-5 grid gap-6 sm:grid-cols-2">
                {markets.map((x) => (
                  <MarketCard key={x.currency.symbol} {...x} />
                ))}
              </div>
            </motion.div>
          )}
        </div>
      </div>

      {/* Outside the grid: the pay panel above fills its row's full height, so anything stacked under it would overflow. */}
      {firstContract && !isPayee && open && !actedHere && reason === null && currency && <FirstContractSafeNote ids={[bill.id]} className="mt-6" />}

      <motion.div {...rise(4)} className="mt-6">
        <PriceLine priceStatus={priceStatus} symbol={currency?.symbol ?? "USDC"} chainNow={head.data?.timestamp ?? null} />
      </motion.div>
    </section>
    </RetryContext.Provider>
  );
}

// The supplier had this page open when someone paid: the stamp above has just landed, and this says so in words.
function PaidJustNow({ bill, currencySymbol, decimals, txUrl }: { bill: Bill; currencySymbol: string; decimals: number; txUrl: string | null }) {
  return (
    <motion.div initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }} className="app-panel p-6 md:p-8" data-paid-just-now>
      <p className="type-label text-success">Paid just now</p>
      <p className="type-h3 mt-3 text-text">
        You received {formatUnitsExact(bill.amount, decimals)} {currencySymbol}.
      </p>
      <p className="type-body mt-3 text-muted">
        Paid by <span className="type-address break-all text-text">{bill.payer}</span>
      </p>
      {txUrl ? (
        <a href={txUrl} target="_blank" rel="noopener noreferrer" className="link-draw type-address mt-4 inline-block text-text hover:text-gold">
          The transaction on the explorer
        </a>
      ) : (
        <p className="type-body mt-4 text-muted">The transaction link appears once Adag&apos;s payment log is read.</p>
      )}
    </motion.div>
  );
}

type MarketCardProps = {
  currency: Currency;
  position: Cell<Position>;
  market: Cell<MarketState>;
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

  const rows: [string, React.ReactNode][] = [
    ["Pledged", <Value key="p" cell={pledged} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC`} />],
    ["Loan", <Value key="l" cell={debt} render={(v) => `${formatUnitsExact(v, currency.decimals)} ${currency.symbol}`} />],
    ["Loan-to-value", <Value key="v" cell={ltv} render={(v) => formatPercentWad(v)} />],
    ["BTC can fall", <Value key="f" cell={drop} render={(v) => (ltv.state === "ok" && ltv.value === 0n ? "no loan" : formatPercentWad(v))} />],
  ];
  return (
    <div className="border-l border-rule pl-4">
      <p className="type-micro text-text">{currency.symbol} against cirBTC</p>
      <dl className="mt-3 space-y-2">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-baseline justify-between gap-3">
            <dt className="type-body text-muted">{label}</dt>
            <dd className="type-body tabular-nums text-text">{value}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

function PriceLine({ priceStatus, symbol, chainNow }: { priceStatus: Cell<readonly [boolean, bigint, bigint]>; symbol: string; chainNow: bigint | null }) {
  if (priceStatus.state !== "ok") {
    return (
      <p className="type-body flex items-center gap-3 text-muted">
        <span aria-hidden="true" className="diamond !bg-rule-strong" />
        Bitcoin price status: <Value cell={priceStatus} render={() => null} />
      </p>
    );
  }
  const [fresh, btcAt] = priceStatus.value;
  const now = chainNow !== null ? Number(chainNow) : Date.now() / 1000;
  const hours = Math.max(0, (now - Number(btcAt)) / 3600);
  return (
    <p className="type-body flex flex-wrap items-center gap-x-3 gap-y-1 text-text" data-price={fresh ? "fresh" : "stale"}>
      <span aria-hidden="true" className={`diamond ${fresh ? "!bg-success" : "!bg-danger"}`} />
      {fresh ? `Bitcoin price fresh for the ${symbol} market.` : "Bitcoin price paused: new loans wait for the next update."}
      <span className={fresh ? "text-text" : "text-muted"}>Chainlink BTC/USD updated {hours.toFixed(1)} hours ago.</span>
    </p>
  );
}
