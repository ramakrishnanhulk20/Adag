"use client";

import { useCallback, useState } from "react";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { arc } from "viem/chains";
import { useBlock, useReadContract, useReadContracts } from "wagmi";
import { Button } from "@/components/Button";
import { adagAbi, erc20Abi, irmAbi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { parseAmountInput } from "@/lib/pay/amount";
import { buildAddCollateral, buildCloseLoan } from "@/lib/pay/build";
import { ADAG_BILLS, CIRBTC, CIRBTC_DECIMALS, EXPLORER, MAX_LTV_WAD, MORPHO, USDC, WAD, type Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact, shortAddress, usdOfSats } from "@/lib/pay/format";
import { accrueBorrowAssets, closeApproval, debtFromShares, liquidationDropWad, ltvWad } from "@/lib/pay/loan";
import { paramsFromTuple } from "@/lib/pay/market";
import { morphoEventsIn } from "@/lib/pay/receipt";
import { hasAcceptedMorphoDisclaimer, rememberMorphoDisclaimer } from "@/lib/wallet/consent";
import { estimateFee, publicArc, simulateAndSend, type TxStep } from "@/lib/wallet/send";
import { RetryContext, Value, type Cell } from "./cells";
import { FeeLine } from "./FeeLine";
import { GetSetUp, type SetupNeed } from "./GetSetUp";
import { MorphoDisclaimer } from "./MorphoDisclaimer";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";
import { usdHint, useUsdPrice } from "./usdPrice";

type Position = readonly [bigint, bigint, bigint];
type MarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
type Read = { status: "success"; result: unknown } | { status: "failure"; error: Error };

// On Arc the fee is paid in USDC from the same balance, so a USDC repay keeps this much back for it.
const USDC_FEE_RESERVE = 10_000n;
const SECONDS_PER_YEAR = 31_536_000;

type LoanTicketProps = {
  address: Address;
  currency: Currency;
  position: Position;
  cirBtc: Cell<bigint>;
  loanTokenBalance: Cell<bigint>;
  usdcBalance: Cell<bigint>;
  canSign: boolean;
  blockedReason: string | null;
  onChanged: () => void;
};

type Done = { kind: "added" | "closed"; hash: Hex; text: string };

export function LoanTicket(props: LoanTicketProps) {
  const { address, currency, position, cirBtc, loanTokenBalance, usdcBalance, canSign, blockedReason, onChanged } = props;
  const m = currency.marketId;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: [
      { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "market", args: [m] },
      { chainId: arc.id, address: currency.params.oracle, abi: oracleAbi, functionName: "price" },
      { chainId: arc.id, address: ADAG_BILLS, abi: adagAbi, functionName: "loanToValue", args: [address, m] },
      { chainId: arc.id, address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [m] },
    ],
    query: { refetchInterval: 30_000 },
  });
  function cell<T>(i: number): Cell<T> {
    if (reads.isPending) return { state: "loading" };
    const r = reads.data?.[i] as Read | undefined;
    if (reads.isError || !r || r.status !== "success") return { state: "unavailable" };
    return { state: "ok", value: r.result as T };
  }
  const market = cell<MarketState>(0);
  const price = cell<bigint>(1);
  const ltv = cell<bigint>(2);
  const priceStatus = cell<readonly [boolean, bigint, bigint]>(3);
  const mv = market.state === "ok" ? market.value : null;
  const rate = useReadContract({
    chainId: arc.id,
    address: currency.params.irm,
    abi: irmAbi,
    functionName: "borrowRateView",
    args: mv
      ? [currency.params, { totalSupplyAssets: mv[0], totalSupplyShares: mv[1], totalBorrowAssets: mv[2], totalBorrowShares: mv[3], lastUpdate: mv[4], fee: mv[5] }]
      : undefined,
    query: { enabled: Boolean(mv) },
  });
  const apy = rate.data !== undefined ? Math.expm1((Number(rate.data) * SECONDS_PER_YEAR) / 1e18) : null;
  const apyCell: Cell<number> = rate.isError || market.state === "unavailable" ? { state: "unavailable" } : apy === null ? { state: "loading" } : { state: "ok", value: apy };

  // market() totals stop at lastUpdate. The debt shown and the close are sized from totals accrued to the chain's own
  // clock at Morpho's live rate; until the rate and block arrive, the debt reads as loading rather than low.
  const head = useBlock({ chainId: arc.id, query: { refetchInterval: 30_000 } });
  const accruedBorrow =
    mv && rate.data !== undefined && head.data ? accrueBorrowAssets(mv[2], rate.data, head.data.timestamp - mv[4]) : null;

  const [, shares, collateral] = position;
  const debt: Cell<bigint> =
    mv && accruedBorrow !== null
      ? { state: "ok", value: debtFromShares(shares, accruedBorrow, mv[3]) }
      : market.state === "unavailable" || rate.isError || head.isError
        ? { state: "unavailable" }
        : { state: "loading" };
  const drop: Cell<bigint> = ltv.state === "ok" ? { state: "ok", value: liquidationDropWad(ltv.value, currency.params.lltv) } : ltv;
  const approval = mv && accruedBorrow !== null && shares > 0n ? closeApproval(shares, accruedBorrow, mv[3]) : 0n;

  const [mode, setMode] = useState<"add" | "close">("add");
  const [addText, setAddText] = useState("");
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [done, setDone] = useState<Done | null>(null);
  const [asking, setAsking] = useState<null | "add" | "close">(null);
  const busy = tx.kind === "busy" ? tx : null;
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));

  const add = parseAmountInput(addText, CIRBTC_DECIMALS);
  const addError = !add.ok ? add.message : cirBtc.state === "ok" && add.value > cirBtc.value ? `Your wallet holds ${formatUnitsExact(cirBtc.value, CIRBTC_DECIMALS)} cirBTC.` : null;
  const ltvAfterAdd: Cell<bigint> =
    add.ok && debt.state === "ok" && price.state === "ok" ? { state: "ok", value: ltvWad(debt.value, collateral + add.value, price.value) } : { state: "unavailable" };

  const isUsdc = currency.address.toLowerCase() === USDC.toLowerCase();
  const need = shares > 0n ? approval + (isUsdc ? USDC_FEE_RESERVE : 0n) : 0n;
  const short =
    shares > 0n && loanTokenBalance.state === "ok" && accruedBorrow !== null ? (loanTokenBalance.value < need ? need - loanTokenBalance.value : 0n) : null;
  const gasShort = !isUsdc && usdcBalance.state === "ok" && usdcBalance.value < USDC_FEE_RESERVE;
  const usd = useUsdPrice();
  const setupNeeds: SetupNeed[] = [];
  if (mode === "add" && addText && addError && cirBtc.state === "ok" && add.ok && add.value > cirBtc.value) setupNeeds.push("cirbtc");
  if (mode === "close" && ((isUsdc && short !== null && short > 0n) || gasShort)) setupNeeds.push("usdc");

  // The close's fee, from the same helper every screen uses. The fixed params stand in; the real close re-reads Morpho's.
  const closeFee = useQuery({
    queryKey: ["adag-fee", "close", m, address, shares.toString(), collateral.toString(), approval.toString()],
    enabled: mode === "close" && canSign && !done && (shares === 0n ? collateral > 0n : approval > 0n && short === 0n),
    staleTime: 30_000,
    retry: false,
    queryFn: () => {
      const built = buildCloseLoan(address, currency, { shares, collateral }, approval, currency.params);
      return estimateFee({ account: address, to: built.to, data: built.data });
    },
  });
  const retryReads = useCallback(() => void reads.refetch(), [reads]);

  const fail = (message: string, hash?: Hex) => setTx({ kind: "failed", message, href: hash && `${EXPLORER}/tx/${hash}` });

  const runAdd = async () => {
    if (!add.ok || addError) return;
    step("checking");
    const client = publicArc();
    let tuple: readonly [Hex, Hex, Hex, Hex, bigint];
    let before: Position;
    try {
      [tuple, before] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
      ]);
    } catch {
      return fail("Arc did not answer, so nothing was built. Try again.");
    }
    let built;
    try {
      built = buildAddCollateral(address, currency, add.value, paramsFromTuple(tuple));
    } catch (error) {
      return fail(`${(error as Error).message} Nothing was sent.`);
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: 0n });
    if (!out.ok) return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
    const supplied = morphoEventsIn(out.receipt.logs).find((e) => e.name === "SupplyCollateral" && e.id.toLowerCase() === m.toLowerCase() && e.onBehalf.toLowerCase() === address.toLowerCase());
    const after = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }).catch(() => null);
    if (!supplied || supplied.assets !== add.value || !after || after[2] !== before[2] + add.value) {
      return fail("Arc confirmed the transaction, but Morpho's record does not show the pledge as expected. Check the transaction.", out.hash);
    }
    setDone({ kind: "added", hash: out.hash, text: `Added ${formatUnitsExact(add.value, CIRBTC_DECIMALS)} cirBTC. Now pledged: ${formatUnitsExact(after[2], CIRBTC_DECIMALS)} cirBTC.` });
    setAddText("");
    setTx({ kind: "idle" });
    onChanged();
  };

  const runClose = async () => {
    step("checking");
    const client = publicArc();
    let tuple: readonly [Hex, Hex, Hex, Hex, bigint];
    let live: Position;
    let mk: MarketState;
    let tokenHeld: bigint;
    let btcBefore: bigint;
    let now: bigint;
    let ratePerSecond: bigint;
    try {
      // Read again at the moment of closing: shares, totals and interest have moved since the page loaded.
      let block: { timestamp: bigint };
      [tuple, live, mk, tokenHeld, btcBefore, block] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m] }),
        client.readContract({ address: currency.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.getBlock(),
      ]);
      now = block.timestamp;
      ratePerSecond = await client.readContract({
        address: currency.params.irm,
        abi: irmAbi,
        functionName: "borrowRateView",
        args: [currency.params, { totalSupplyAssets: mk[0], totalSupplyShares: mk[1], totalBorrowAssets: mk[2], totalBorrowShares: mk[3], lastUpdate: mk[4], fee: mk[5] }],
      });
    } catch {
      return fail("Arc did not answer, so nothing was built. Try again.");
    }
    const [, liveShares, liveCollateral] = live;
    // Sized from the debt accrued to this block, as Morpho will count it; the 0.1% plus 1 covers the seconds until
    // the transaction lands, and the batch resets the approval to 0 whatever is left.
    const accrued = accrueBorrowAssets(mk[2], ratePerSecond, now - mk[4]);
    const liveApproval = liveShares > 0n ? closeApproval(liveShares, accrued, mk[3]) : 0n;
    const liveNeed = liveShares > 0n ? liveApproval + (isUsdc ? USDC_FEE_RESERVE : 0n) : 0n;
    if (tokenHeld < liveNeed) {
      return fail(`Closing needs ${formatUnitsExact(liveNeed, currency.decimals)} ${currency.symbol} and your wallet holds ${formatUnitsExact(tokenHeld, currency.decimals)}. Add ${formatUnitsExact(liveNeed - tokenHeld, currency.decimals)} ${currency.symbol}, then try again. Nothing was sent.`);
    }
    let built;
    try {
      built = buildCloseLoan(address, currency, { shares: liveShares, collateral: liveCollateral }, liveApproval, paramsFromTuple(tuple));
    } catch (error) {
      return fail(`${(error as Error).message} Nothing was sent.`);
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: isUsdc ? liveApproval : 0n });
    if (!out.ok) return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });

    const events = morphoEventsIn(out.receipt.logs).filter((e) => e.id.toLowerCase() === m.toLowerCase() && e.onBehalf.toLowerCase() === address.toLowerCase());
    const repaid = events.find((e) => e.name === "Repay");
    const withdrawn = events.find((e) => e.name === "WithdrawCollateral");
    const [after, allowance, btcAfter] = await Promise.all([
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
      client.readContract({ address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, MORPHO] }),
      client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
    ]).catch(() => [null, null, null] as const);
    const proven =
      (liveShares === 0n || (repaid?.name === "Repay" && repaid.shares === liveShares)) &&
      (liveCollateral === 0n || (withdrawn?.name === "WithdrawCollateral" && withdrawn.assets === liveCollateral && withdrawn.receiver.toLowerCase() === address.toLowerCase())) &&
      after !== null && after[1] === 0n && after[2] === 0n && (liveShares === 0n || allowance === 0n);
    if (!proven || btcAfter === null) return fail("Arc confirmed the transaction, but Morpho does not read the loan as closed. Check the transaction.", out.hash);
    const back = btcAfter - btcBefore;
    const returned = `${formatUnitsExact(back, CIRBTC_DECIMALS)} cirBTC is back in your wallet.`;
    setDone({
      kind: "closed",
      hash: out.hash,
      text: liveShares > 0n ? `Loan closed. 0 owed, 0 pledged. ${returned}` : `Done. 0 pledged in this market, and ${returned}`,
    });
    setTx({ kind: "idle" });
    onChanged();
  };

  const start = (which: "add" | "close") => {
    setTx({ kind: "idle" });
    setDone(null);
    if (!hasAcceptedMorphoDisclaimer(address)) return setAsking(which);
    void (which === "add" ? runAdd() : runClose());
  };

  const closed = done?.kind === "closed";
  const ltvPct = ltv.state === "ok" && ltv.value !== 2n ** 256n - 1n ? Number((ltv.value * 10_000n) / WAD) / 100 : null;
  const fresh = priceStatus.state === "ok" ? priceStatus.value[0] : null;

  return (
    <RetryContext.Provider value={retryReads}>
    <article className="app-panel p-6 md:p-8" data-loan={currency.symbol} data-ltv={ltvPct ?? ""}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="type-label text-text">
          {currency.symbol} <span className="text-muted">borrowed against</span> cirBTC
        </p>
        <p className="type-micro text-muted">Morpho market {shortAddress(m)}</p>
      </div>

      {closed ? (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-6" data-tx-result="closed">
          <p className="type-h3 text-text">{done.text}</p>
          <a href={`${EXPLORER}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address mt-4 inline-block text-muted hover:text-gold">
            Transaction {shortAddress(done.hash)} on the explorer
          </a>
        </motion.div>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-6">
            <Stat
              label="Pledged"
              cell={{ state: "ok", value: collateral }}
              render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC`}
              note={usd !== null ? `about ${usdOfSats(collateral, usd)}, estimated` : undefined}
            />
            <Stat label="You owe" cell={debt} render={(v) => `${formatUnitsExact(v, currency.decimals)} ${currency.symbol}`} note="exact, rounded up" />
            <Stat label="Bitcoin can fall" cell={drop} render={(v) => (shares === 0n ? "no loan" : formatPercentWad(v))} note={`before Morpho may liquidate`} />
            <Stat label="Borrow rate" cell={apyCell} render={(v) => `${(v * 100).toFixed(2)}% a year`} note="live, variable" />
          </dl>

          <Gauge ltv={ltv} lltv={currency.params.lltv} />

          <p className="type-body mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-text">
            <span aria-hidden="true" className={`diamond ${fresh === null ? "!bg-rule-strong" : fresh ? "!bg-success" : "!bg-danger"}`} />
            {fresh === null ? <Value cell={priceStatus} render={() => ""} /> : fresh ? "Bitcoin price fresh." : "Bitcoin price paused for new loans."}
            <span className="text-muted">Adag checks the 40% line only at the moment you pay. It does not watch this loan.</span>
          </p>

          <div className="mt-7 border-t border-rule pt-6">
            <div role="tablist" aria-label="Loan actions" className="flex gap-6">
              {(["add", "close"] as const).map((t) => (
                <button
                  key={t}
                  role="tab"
                  type="button"
                  aria-selected={mode === t}
                  onClick={() => setMode(t)}
                  className={`type-label border-b-2 pb-2 transition-colors duration-200 ${mode === t ? "border-gold text-gold" : "border-transparent text-muted hover:text-text"}`}
                >
                  {t === "add" ? "Add cirBTC" : shares > 0n ? "Close loan" : "Take your bitcoin back"}
                </button>
              ))}
            </div>

            {!canSign ? (
              <p className="type-body mt-5 text-muted">{blockedReason}</p>
            ) : mode === "add" ? (
              <div className="mt-5">
                <div className="flex flex-col gap-4 md:flex-row md:items-end">
                  <label className="flex-1">
                    <span className="type-micro text-muted">
                      cirBTC to add · you hold <Value cell={cirBtc} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)}${usdHint(v, usd)}`} />
                    </span>
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder="Amount in cirBTC"
                      value={addText}
                      onChange={(e) => setAddText(e.target.value)}
                      className="app-input mt-1 !text-[2rem]"
                      data-field="add-collateral"
                    />
                  </label>
                  <Button variant="primary" disabled={!add.ok || Boolean(addError) || Boolean(busy)} onClick={() => start("add")} data-action="add-collateral" className="w-full md:w-auto">
                    {busy ? <BusyLabel step={busy.step} since={busy.since} /> : "Add cirBTC"}
                  </Button>
                </div>
                <p className="type-body mt-3 text-muted">
                  {addText && addError ? (
                    <span className="text-danger">{addError}</span>
                  ) : (
                    <>
                      Loan-to-value after: <Value cell={add.ok ? ltvAfterAdd : { state: "ok", value: ltv.state === "ok" ? ltv.value : 0n }} render={(v) => formatPercentWad(v)} className="text-text" />. No new debt, so no price check is needed.
                    </>
                  )}
                </p>
              </div>
            ) : (
              <div className="mt-5">
                {shares > 0n ? (
                  <p className="type-body text-text">
                    Repay <Value cell={debt} render={(v) => `${formatUnitsExact(v, currency.decimals)} ${currency.symbol}`} className="font-semibold" /> by your exact loan shares, then take all {formatUnitsExact(collateral, CIRBTC_DECIMALS)} cirBTC back. The approval is{" "}
                    {formatUnitsExact(approval, currency.decimals)} {currency.symbol} to cover interest until the block, and it is reset to 0 in the same signature.
                  </p>
                ) : (
                  <p className="type-body text-text">No debt here. Take all {formatUnitsExact(collateral, CIRBTC_DECIMALS)} cirBTC back to your wallet.</p>
                )}
                {short !== null && short > 0n ? (
                  <p className="type-body mt-3 text-danger" data-close-short>
                    Your wallet holds <Value cell={loanTokenBalance} render={(v) => formatUnitsExact(v, currency.decimals)} /> {currency.symbol}; closing needs {formatUnitsExact(need, currency.decimals)}
                    {isUsdc ? " including a little for the fee" : ""}. Add {formatUnitsExact(short, currency.decimals)} {currency.symbol} first.
                  </p>
                ) : gasShort ? (
                  <p className="type-body mt-3 text-danger">Keep a little USDC in this wallet for the network fee.</p>
                ) : (
                  <>
                    <Button variant="primary" disabled={Boolean(busy) || (shares > 0n && short === null)} onClick={() => start("close")} data-action="close-loan" className="mt-5 w-full md:w-auto">
                      {busy ? <BusyLabel step={busy.step} since={busy.since} /> : shares > 0n ? "Close loan" : "Take your bitcoin back"}
                    </Button>
                    {shares > 0n && short === null && !busy && <p className="type-body mt-2 text-muted" data-blocked-reason>Reading your loan and balance on Arc.</p>}
                    <FeeLine query={closeFee} className="mt-3" />
                  </>
                )}
              </div>
            )}
            {setupNeeds.length > 0 && <GetSetUp needs={setupNeeds} className="mt-5" />}
            {done?.kind === "added" && (
              <p className="type-body mt-4 text-success" data-tx-result="added">
                {done.text}{" "}
                <a href={`${EXPLORER}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw text-text hover:text-gold">
                  View the transaction
                </a>
              </p>
            )}
            <div className="mt-4">
              <TxMessage state={tx} />
            </div>
          </div>
        </>
      )}

      <MorphoDisclaimer
        open={asking !== null}
        onCancel={() => setAsking(null)}
        onAccept={() => {
          rememberMorphoDisclaimer(address);
          const which = asking;
          setAsking(null);
          void (which === "add" ? runAdd() : runClose());
        }}
      />
    </article>
    </RetryContext.Provider>
  );
}

function Stat<T>({ label, cell, render, note }: { label: string; cell: Cell<T>; render: (v: T) => React.ReactNode; note?: string }) {
  return (
    <div>
      <dt className="type-micro text-muted">{label}</dt>
      <dd className="mt-2 font-display text-[1.45rem] leading-none font-medium tabular-nums text-text">
        <Value cell={cell} render={render} />
      </dd>
      {note && <dd className="type-micro mt-2 normal-case tracking-[0.04em] text-muted">{note}</dd>}
    </div>
  );
}

// 0 to 100% of the pledge's value, with Adag's payment line at 40% and Morpho's liquidation line at 86%.
function Gauge({ ltv, lltv }: { ltv: Cell<bigint>; lltv: bigint }) {
  const pct = ltv.state === "ok" ? Math.min(100, ltv.value === 2n ** 256n - 1n ? 100 : Number((ltv.value * 10_000n) / WAD) / 100) : 0;
  const adag = Number((MAX_LTV_WAD * 100n) / WAD);
  const morpho = Number((lltv * 100n) / WAD);
  const tone = pct >= morpho ? "var(--danger)" : pct > adag ? "var(--pending)" : "var(--gold-fill)";
  return (
    <div className="mt-7">
      <div className="flex items-baseline justify-between">
        <p className="type-micro text-muted">Loan-to-value</p>
        <p className="font-display text-[1.75rem] leading-none font-medium tabular-nums text-text">
          <Value cell={ltv} render={(v) => formatPercentWad(v)} />
        </p>
      </div>
      <div className="relative mt-3 h-3 rounded-[2px] border border-rule bg-bg/40" role="img" aria-label={`Loan-to-value ${pct.toFixed(2)}% of 100%, Adag's line at ${adag}%, Morpho liquidates at ${morpho}%`}>
        <motion.div
          className="absolute inset-y-0 left-0 rounded-[1px]"
          style={{ backgroundColor: tone }}
          initial={{ width: 0 }}
          animate={{ width: `${pct}%` }}
          transition={{ duration: 1, ease: [0.16, 1, 0.3, 1] }}
          data-gauge-fill={pct.toFixed(2)}
        />
        {[
          { at: adag, label: `Adag ${adag}%` },
          { at: morpho, label: `Morpho ${morpho}%` },
        ].map((line) => (
          <span key={line.label} className="absolute -top-1.5 -bottom-1.5 w-px bg-text/70" style={{ left: `${line.at}%` }}>
            <span className="type-micro absolute top-full mt-2 -translate-x-1/2 whitespace-nowrap text-muted normal-case tracking-[0.04em]">{line.label}</span>
          </span>
        ))}
      </div>
      <div className="h-7" />
    </div>
  );
}
