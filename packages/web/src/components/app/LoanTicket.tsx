"use client";

import { useCallback, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, type Address, type Hex } from "viem";
import { arc } from "viem/chains";
import { useBlock, useReadContract, useReadContracts } from "wagmi";
import { Button } from "@/components/Button";
import { GuardSection } from "@/components/guard/GuardSection";
import { useLibText } from "@/i18n/useLibText";
import { adagAbi, erc20Abi, irmAbi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { parseAmountInput } from "@/lib/pay/amount";
import { buildAddCollateral, buildCloseLoan, buildCloseWithOtherCurrency, buildRepaySome, type GuardStop } from "@/lib/pay/build";
import { loanCurrencyFor } from "@/lib/fx/estimate";
import { checkAdapterPreflight } from "@/lib/fx/preflight";
import { guardAbi } from "@/lib/guard/abi";
import { ADAG_GUARD } from "@/lib/guard/constants";
import { ADAG_BILLS, CIRBTC, CIRBTC_DECIMALS, EXPLORER, MAX_LTV_WAD, MORPHO, USDC, WAD, type Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact, shortAddress, usdOfSats } from "@/lib/pay/format";
import { accrueBorrowAssets, closeApproval, debtFromShares, liquidationDropWad, ltvWad, repaySomeCap } from "@/lib/pay/loan";
import { paramsFromTuple } from "@/lib/pay/market";
import { conversionOutcome, morphoEventsIn, ruleClearedIn } from "@/lib/pay/receipt";
import { hasAcceptedMorphoDisclaimer, rememberMorphoDisclaimer } from "@/lib/wallet/consent";
import { estimateFee, publicArc, simulateAndSend, type TxOutcome, type TxStep } from "@/lib/wallet/send";
import { Reading, RetryContext, Value, type Cell } from "./cells";
import { FeeLine } from "./FeeLine";
import { GetSetUp, type SetupNeed } from "./GetSetUp";
import { MorphoDisclaimer } from "./MorphoDisclaimer";
import { CloseConvertEstimate, ConvertReset } from "./fx/ConvertParts";
import { EFFECTS_UNAVAILABLE, closeConvertView, reasons, type CloseEstimate, type CloseView } from "./fx/figures";
import { adapterReadBack, askCircle, conversionFailure, effectsCanBeChecked } from "./fx/press";
import { useCloseConvert } from "./fx/useConvert";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";
import { useUsdHint, useUsdPrice } from "./usdPrice";

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

type Done = { kind: "added" | "repaid" | "closed"; hash: Hex; text: string };
type Action = "add" | "repay" | "close" | "closeOther";
type CloseConvertState = { kind: "loading" } | { kind: "unavailable" } | CloseView;

export function LoanTicket(props: LoanTicketProps) {
  const { address, currency, position, cirBtc, loanTokenBalance, usdcBalance, canSign, blockedReason, onChanged } = props;
  const t = useTranslations("loan");
  const tc = useTranslations("common");
  const tl = useLibText();
  const usdHint = useUsdHint();
  const m = currency.marketId;
  const sym = currency.symbol;
  const fmt = (v: bigint) => formatUnitsExact(v, currency.decimals);
  const nothingSent = tc("nothingWasSent");
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

  const [mode, setMode] = useState<Action>("add");
  const [repayText, setRepayText] = useState("");
  const [addText, setAddText] = useState("");
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [done, setDone] = useState<Done | null>(null);
  const [asking, setAsking] = useState<null | Action>(null);
  const busy = tx.kind === "busy" ? tx : null;
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));

  // Closing with the other currency (C75): the amount to sell is read when the close tab is open, and never asks Circle
  // anything. Pressing the button freezes the figures on screen; the close uses exactly these until it ends (C70).
  const sold = loanCurrencyFor(currency.symbol);
  const [frozen, setFrozen] = useState<CloseEstimate | null>(null);
  const frozenRef = useRef<CloseEstimate | null>(null);
  const unfreeze = useCallback(() => {
    frozenRef.current = null;
    setFrozen(null);
  }, []);
  const closeRead = useCloseConvert({ enabled: mode === "close" && shares > 0n && canSign && !done && !busy && !frozen, payer: address, loan: currency, approval });
  const closeConvert: CloseConvertState = frozen
    ? { kind: "ready", estimate: frozen }
    : closeRead.data
      ? closeConvertView(closeRead.data)
      : closeRead.isError
        ? { kind: "unavailable" }
        : { kind: "loading" };

  const add = parseAmountInput(addText, CIRBTC_DECIMALS);
  const addError = !add.ok ? tl(add.message) : cirBtc.state === "ok" && add.value > cirBtc.value ? t("add.holdsOnly", { amount: formatUnitsExact(cirBtc.value, CIRBTC_DECIMALS) }) : null;
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

  // C60: the loan guard's rule and approval for this market, so a close can stop the guard in the same transaction.
  const guardState = useQuery({
    queryKey: ["adag-close-guard", address, m],
    enabled: ADAG_GUARD !== null,
    refetchInterval: 30_000,
    queryFn: () => readGuardStop(address, currency),
  });
  const stopsGuard = guardState.data ? guardState.data.hasRule || guardState.data.allowance > 0n : false;

  // The close's fee, from the same helper every screen uses. The fixed params stand in; the real close re-reads Morpho's.
  const closeFee = useQuery({
    queryKey: ["adag-fee", "close", m, address, shares.toString(), collateral.toString(), approval.toString(), String(stopsGuard)],
    enabled: mode === "close" && canSign && !done && (ADAG_GUARD === null || guardState.data !== undefined) && (shares === 0n ? collateral > 0n : approval > 0n && short === 0n),
    staleTime: 30_000,
    retry: false,
    queryFn: () => {
      const built = buildCloseLoan(address, currency, { shares, collateral }, approval, currency.params, guardState.data);
      return estimateFee({ account: address, to: built.to, data: built.data });
    },
  });
  const retryReads = useCallback(() => void reads.refetch(), [reads]);

  // Repay some: any amount up to the debt rounded down (C36). The whole debt stays with Close loan, which repays by shares.
  const repayCap = mv && accruedBorrow !== null ? repaySomeCap(shares, accruedBorrow, mv[3]) : null;
  const repay = parseAmountInput(repayText, currency.decimals);
  const repayError = !repay.ok
    ? tl(repay.message)
    : repayCap !== null && repay.value > repayCap
      ? t("repay.mostIs", { amount: fmt(repayCap), symbol: sym })
      : loanTokenBalance.state === "ok" && repay.value + (isUsdc ? USDC_FEE_RESERVE : 0n) > loanTokenBalance.value
        ? t("repay.holdsOnly", { amount: fmt(loanTokenBalance.value), symbol: sym, fee: isUsdc ? t("repay.andFee") : "" })
        : null;
  let afterRepay: Cell<{ ltv: bigint; drop: bigint }> = { state: "unavailable" };
  if (repay.ok && !repayError && debt.state === "ok" && price.state === "ok") {
    const left = debt.value > repay.value ? debt.value - repay.value : 0n;
    const nextLtv = ltvWad(left, collateral, price.value);
    afterRepay = { state: "ok", value: { ltv: nextLtv, drop: liquidationDropWad(nextLtv, currency.params.lltv) } };
  }
  const repayFee = useQuery({
    queryKey: ["adag-fee", "repay", m, address, repay.ok ? repay.value.toString() : "", repayCap?.toString()],
    enabled: mode === "repay" && canSign && !done && repay.ok && !repayError && repayCap !== null,
    staleTime: 30_000,
    retry: false,
    queryFn: () => {
      const built = buildRepaySome(address, currency, (repay as { value: bigint }).value, currency.params, repayCap!);
      return estimateFee({ account: address, to: built.to, data: built.data });
    },
  });
  if (mode === "repay" && repay.ok && loanTokenBalance.state === "ok" && isUsdc && repay.value + USDC_FEE_RESERVE > loanTokenBalance.value) setupNeeds.push("usdc");

  const fail = (message: string, hash?: Hex) => setTx({ kind: "failed", message, href: hash && `${EXPLORER}/tx/${hash}` });

  const runRepay = async () => {
    if (!repay.ok || repayError) return;
    const assets = repay.value;
    step("checking");
    const client = publicArc();
    let tuple: readonly [Hex, Hex, Hex, Hex, bigint];
    let before: Position;
    let mk: MarketState;
    let now: bigint;
    let ratePerSecond: bigint;
    try {
      // Read again at the moment of repaying: the cap moves with every second of interest.
      let block: { timestamp: bigint };
      [tuple, before, mk, block] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m] }),
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
      return fail(tc("arcNoAnswerNothingBuilt"));
    }
    const cap = repaySomeCap(before[1], accrueBorrowAssets(mk[2], ratePerSecond, now - mk[4]), mk[3]);
    let built;
    try {
      built = buildRepaySome(address, currency, assets, paramsFromTuple(tuple), cap);
    } catch (error) {
      return fail(`${(error as Error).message} ${nothingSent}`);
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: isUsdc ? assets : 0n });
    if (!out.ok) return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });

    // Proven by Morpho's own Repay for exactly these assets on this wallet, fewer shares on a fresh read, and no approval left.
    const repaid = morphoEventsIn(out.receipt.logs).find(
      (e) => e.name === "Repay" && e.id.toLowerCase() === m.toLowerCase() && e.onBehalf.toLowerCase() === address.toLowerCase(),
    );
    const [after, allowance, mkAfter] = await Promise.all([
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
      client.readContract({ address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, MORPHO] }),
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m] }),
    ]).catch(() => [null, null, null] as const);
    if (repaid?.name !== "Repay" || repaid.assets !== assets || !after || after[1] >= before[1] || allowance !== 0n || !mkAfter) {
      return fail(t("repay.notAsExpected"), out.hash);
    }
    const owed = debtFromShares(after[1], mkAfter[2], mkAfter[3]);
    setDone({ kind: "repaid", hash: out.hash, text: t("repay.done", { amount: fmt(assets), owed: fmt(owed), symbol: sym }) });
    setRepayText("");
    setTx({ kind: "idle" });
    onChanged();
  };

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
      return fail(tc("arcNoAnswerNothingBuilt"));
    }
    let built;
    try {
      built = buildAddCollateral(address, currency, add.value, paramsFromTuple(tuple));
    } catch (error) {
      return fail(`${(error as Error).message} ${nothingSent}`);
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: 0n });
    if (!out.ok) return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
    const supplied = morphoEventsIn(out.receipt.logs).find((e) => e.name === "SupplyCollateral" && e.id.toLowerCase() === m.toLowerCase() && e.onBehalf.toLowerCase() === address.toLowerCase());
    const after = await client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }).catch(() => null);
    if (!supplied || supplied.assets !== add.value || !after || after[2] !== before[2] + add.value) {
      return fail(t("add.notAsExpected"), out.hash);
    }
    setDone({ kind: "added", hash: out.hash, text: t("add.done", { amount: formatUnitsExact(add.value, CIRBTC_DECIMALS), pledged: formatUnitsExact(after[2], CIRBTC_DECIMALS) }) });
    setAddText("");
    setTx({ kind: "idle" });
    onChanged();
  };

  // The proof of a close, the same for both ways of closing: Morpho's own Repay and WithdrawCollateral for this wallet, the
  // position read back at 0, no approval left to Morpho, and the guard stopped when it was running (C60).
  const settleClose = async (
    out: Extract<TxOutcome, { ok: true }>,
    c: { liveShares: bigint; liveCollateral: bigint; stop: GuardStop; btcBefore: bigint; extra?: (repaidAssets: bigint | null) => Promise<string> },
  ) => {
    const client = publicArc();
    const { liveShares, liveCollateral, stop, btcBefore } = c;
    const events = morphoEventsIn(out.receipt.logs).filter((e) => e.id.toLowerCase() === m.toLowerCase() && e.onBehalf.toLowerCase() === address.toLowerCase());
    const repaid = events.find((e) => e.name === "Repay");
    const withdrawn = events.find((e) => e.name === "WithdrawCollateral");
    const [after, allowance, btcAfter, guardAfter] = await Promise.all([
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
      client.readContract({ address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, MORPHO] }),
      client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      ADAG_GUARD ? readGuardStop(address, currency) : Promise.resolve({ hasRule: false, allowance: 0n }),
    ]).catch(() => [null, null, null, null] as const);
    // C60: when the close stopped the guard, AdagGuard's own RuleCleared (if there was a rule) and a 0 approval prove it.
    const guardStopped =
      !(stop.hasRule || stop.allowance > 0n) ||
      (guardAfter !== null && !guardAfter.hasRule && guardAfter.allowance === 0n && (!stop.hasRule || ruleClearedIn(out.receipt.logs, address, m)));
    const proven =
      (liveShares === 0n || (repaid?.name === "Repay" && repaid.shares === liveShares)) &&
      (liveCollateral === 0n || (withdrawn?.name === "WithdrawCollateral" && withdrawn.assets === liveCollateral && withdrawn.receiver.toLowerCase() === address.toLowerCase())) &&
      after !== null && after[1] === 0n && after[2] === 0n && (liveShares === 0n || allowance === 0n) && guardStopped;
    if (!proven || btcAfter === null) return fail(t("close.notAsExpected"), out.hash);
    const back = btcAfter - btcBefore;
    const returned = t("close.backInWallet", { amount: formatUnitsExact(back, CIRBTC_DECIMALS) });
    const more = c.extra ? ` ${await c.extra(repaid?.name === "Repay" ? repaid.assets : null)}` : "";
    setDone({
      kind: "closed",
      hash: out.hash,
      text: `${liveShares > 0n ? t("close.doneLoan", { returned }) : t("close.doneNoLoan", { returned })}${stop.hasRule || stop.allowance > 0n ? ` ${t("close.guardOff")}` : ""}${more}`,
    });
    setTx({ kind: "idle" });
    onChanged();
  };

  // C75: closing with the other currency. Circle is asked once, last, for exactly the amount frozen at the press; every
  // other check is read again here, and nothing reaches the wallet unless the sender's checks and the transfer trace pass.
  const runCloseOther = async () => {
    const est = frozenRef.current;
    if (!est) return;
    step("checking");
    const client = publicArc();
    const failed = (message: string) => setTx({ kind: "failed", message: `${message} ${nothingSent}` });
    let tuple: readonly [Hex, Hex, Hex, Hex, bigint];
    let live: Position;
    let mk: MarketState;
    let btcBefore: bigint;
    let soldHeld: bigint;
    let now: bigint;
    let ratePerSecond: bigint;
    try {
      let block: { timestamp: bigint };
      [tuple, live, mk, btcBefore, soldHeld, block] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m] }),
        client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: sold.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
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
      return failed(t("close.notBuiltShort"));
    }
    const [, liveShares, liveCollateral] = live;
    if (liveShares === 0n) return failed(t("close.noLoanToConvert"));
    const liveApproval = closeApproval(liveShares, accrueBorrowAssets(mk[2], ratePerSecond, now - mk[4]), mk[3]);
    if (soldHeld < est.amountIn) return failed(reasons.closeShort(soldHeld, est.amountIn, sold.symbol));
    let stop: GuardStop;
    let pre: Awaited<ReturnType<typeof checkAdapterPreflight>>;
    try {
      [stop, pre] = await Promise.all([readGuardStop(address, currency), checkAdapterPreflight(client, address, sold.address)]);
    } catch {
      return failed(t("close.guardNoAnswerShort"));
    }
    if (pre.state !== "clear") return failed(pre.state === "blocked" ? pre.blockers.join(" ") : pre.text);
    const asked = await askCircle(client, { payer: address, sell: sold, buy: currency, amountIn: est.amountIn, minOut: liveApproval });
    if (!asked.ok) return setTx({ kind: "failed", message: asked.message });
    let built;
    try {
      built = buildCloseWithOtherCurrency(
        address,
        currency,
        { shares: liveShares, collateral: liveCollateral },
        liveApproval,
        paramsFromTuple(tuple),
        { amountIn: est.amountIn, plan: asked.pinned.plan, outputBalance: asked.pinned.outputBalance, maxFeePerGas: asked.pinned.maxFeePerGas, chainTime: asked.pinned.chainTime, rate: asked.pinned.rate },
        stop,
      );
    } catch (error) {
      return failed((error as Error).message);
    }
    // C71, failing closed: a conversion is only signed when this connection can trace the transfers it makes.
    if (!(await effectsCanBeChecked(client))) return setTx({ kind: "failed", message: EFFECTS_UNAVAILABLE });
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: 0n, conversion: built.conversion });
    if (!out.ok) return setTx(conversionFailure(out));
    await settleClose(out, {
      liveShares,
      liveCollateral,
      stop,
      btcBefore,
      // What the swap returned comes from the receipt's own Transfer logs, and Circle's adapter is read back to 0 (C67, C72).
      extra: async (repaidAssets) => {
        const outcome = conversionOutcome(out.receipt.logs, { token: currency.address, payer: address, spent: repaidAssets ?? liveApproval });
        const clear = await adapterReadBack(client, address).catch(() => null);
        const left = outcome.surplus > 0n ? ` ${t("close.leftInWallet", { amount: fmt(outcome.surplus), symbol: sym })}` : "";
        const adapter = clear === true ? ` ${t("close.adapterClear")}` : ` ${t("close.adapterMaybe")}`;
        const unchecked = out.effects === "unavailable" ? ` ${t("close.effectsUnchecked")}` : "";
        return `${t("close.circleTurned", { from: `${formatUnitsExact(est.amountIn, 6)} ${sold.symbol}`, to: `${fmt(outcome.converted)} ${sym}` })}${left}${adapter}${unchecked}`;
      },
    });
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
      return fail(tc("arcNoAnswerNothingBuilt"));
    }
    const [, liveShares, liveCollateral] = live;
    // Sized from the debt accrued to this block, as Morpho will count it; the 0.1% plus 1 covers the seconds until
    // the transaction lands, and the batch resets the approval to 0 whatever is left.
    const accrued = accrueBorrowAssets(mk[2], ratePerSecond, now - mk[4]);
    const liveApproval = liveShares > 0n ? closeApproval(liveShares, accrued, mk[3]) : 0n;
    const liveNeed = liveShares > 0n ? liveApproval + (isUsdc ? USDC_FEE_RESERVE : 0n) : 0n;
    if (tokenHeld < liveNeed) {
      return fail(t("close.needs", { need: fmt(liveNeed), symbol: sym, held: fmt(tokenHeld), add: fmt(liveNeed - tokenHeld) }));
    }
    let stop: GuardStop;
    try {
      stop = await readGuardStop(address, currency);
    } catch {
      return fail(t("close.guardNoAnswer"));
    }
    let built;
    try {
      built = buildCloseLoan(address, currency, { shares: liveShares, collateral: liveCollateral }, liveApproval, paramsFromTuple(tuple), stop);
    } catch (error) {
      return fail(`${(error as Error).message} ${nothingSent}`);
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: isUsdc ? liveApproval : 0n });
    if (!out.ok) return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });

    await settleClose(out, { liveShares, liveCollateral, stop, btcBefore });
  };

  const run = (which: Action) => void (which === "add" ? runAdd() : which === "repay" ? runRepay() : which === "close" ? runClose() : runCloseOther().finally(unfreeze));
  const start = (which: Action) => {
    setTx({ kind: "idle" });
    setDone(null);
    if (!hasAcceptedMorphoDisclaimer(address)) return setAsking(which);
    run(which);
  };

  // Pressing the button freezes the figures on screen: the close uses exactly these, and anything that moves after the
  // press needs a new press (C70).
  const onCloseOther = () => {
    if (closeConvert.kind !== "ready") return;
    frozenRef.current = closeConvert.estimate;
    setFrozen(closeConvert.estimate);
    start("closeOther");
  };

  const closed = done?.kind === "closed";
  const ltvPct = ltv.state === "ok" && ltv.value !== 2n ** 256n - 1n ? Number((ltv.value * 10_000n) / WAD) / 100 : null;
  const fresh = priceStatus.state === "ok" ? priceStatus.value[0] : null;
  const tabLabel = (tab: "add" | "repay" | "close") => (tab === "add" ? t("tabs.add") : tab === "repay" ? t("tabs.repay") : shares > 0n ? t("tabs.close") : t("tabs.takeBack"));

  return (
    <RetryContext.Provider value={retryReads}>
    <article className="app-panel p-6 md:p-8" data-loan={currency.symbol} data-ltv={ltvPct ?? ""}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="type-label text-text">{t.rich("borrowedAgainst", { symbol: sym, muted: (chunks) => <span className="text-muted">{chunks}</span> })}</p>
        <p className="type-micro text-muted">{t("morphoMarket", { id: shortAddress(m) })}</p>
      </div>

      {closed ? (
        <motion.div initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} className="mt-6" data-tx-result="closed">
          <p className="type-h3 text-text">{done.text}</p>
          <a href={`${EXPLORER}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address mt-4 inline-block text-muted hover:text-gold">
            {tc("transactionOnExplorer", { hash: shortAddress(done.hash) })}
          </a>
        </motion.div>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-x-6 gap-y-6">
            <Stat
              label={t("stats.pledged")}
              cell={{ state: "ok", value: collateral }}
              render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC`}
              note={usd !== null ? t("stats.aboutEstimated", { usd: tl(usdOfSats(collateral, usd)) }) : undefined}
            />
            <Stat label={t("stats.youOwe")} cell={debt} render={(v) => `${fmt(v)} ${sym}`} note={t("stats.exactRoundedUp")} />
            <Stat label={t("stats.bitcoinCanFall")} cell={drop} render={(v) => (shares === 0n ? t("stats.noLoan") : formatPercentWad(v))} note={t("stats.beforeLiquidate")} />
            <Stat label={t("stats.borrowRate")} cell={apyCell} render={(v) => tc("percentAYear", { pct: (v * 100).toFixed(2) })} note={tc("liveVariable")} />
          </dl>

          <Gauge ltv={ltv} lltv={currency.params.lltv} />

          <p className="type-body mt-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-text">
            <span aria-hidden="true" className={`diamond ${fresh === null ? "!bg-rule-strong" : fresh ? "!bg-success" : "!bg-danger"}`} />
            {fresh === null ? <Value cell={priceStatus} render={() => ""} /> : fresh ? t("priceFresh") : t("pricePaused")}
            <span className="text-muted">{t("checksOnlyAtPay")}</span>
          </p>

          <GuardSection address={address} currency={currency} position={position} canSign={canSign} blockedReason={blockedReason} onChanged={onChanged} />

          <div className="mt-7 border-t border-rule pt-6">
            <div role="tablist" aria-label={t("tabs.label")} className="flex flex-wrap gap-x-6 gap-y-2">
              {(shares > 0n ? (["add", "repay", "close"] as const) : (["add", "close"] as const)).map((tab) => (
                <button
                  key={tab}
                  role="tab"
                  type="button"
                  aria-selected={mode === tab}
                  onClick={() => setMode(tab)}
                  className={`type-label border-b-2 pb-2 transition-colors duration-200 ${mode === tab ? "border-gold text-gold" : "border-transparent text-muted hover:text-text"}`}
                >
                  {tabLabel(tab)}
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
                      {t.rich("add.label", { held: () => <Value cell={cirBtc} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)}${usdHint(v, usd)}`} /> })}
                    </span>
                    <input
                      inputMode="decimal"
                      autoComplete="off"
                      placeholder={tc("amountIn", { symbol: "cirBTC" })}
                      value={addText}
                      onChange={(e) => setAddText(e.target.value)}
                      className="app-input mt-1 !text-[2rem]"
                      data-field="add-collateral"
                    />
                  </label>
                  <Button variant="primary" disabled={!add.ok || Boolean(addError) || Boolean(busy)} onClick={() => start("add")} data-action="add-collateral" className="w-full md:w-auto">
                    {busy ? <BusyLabel step={busy.step} since={busy.since} /> : t("tabs.add")}
                  </Button>
                </div>
                <p className="type-body mt-3 text-muted">
                  {addText && addError ? (
                    <span className="text-danger">{addError}</span>
                  ) : (
                    t.rich("add.after", { ltv: () => <Value cell={add.ok ? ltvAfterAdd : { state: "ok", value: ltv.state === "ok" ? ltv.value : 0n }} render={(v) => formatPercentWad(v)} className="text-text" /> })
                  )}
                </p>
              </div>
            ) : mode === "repay" ? (
              <div className="mt-5" data-repay-panel>
                <div className="flex flex-col gap-4 md:flex-row md:items-end">
                  <label className="flex-1">
                    <span className="type-micro text-muted">{t.rich("repay.label", { symbol: sym, owed: () => <Value cell={debt} render={(v) => fmt(v)} /> })}</span>
                    <span className="mt-1 flex items-end gap-3">
                      <input
                        inputMode="decimal"
                        autoComplete="off"
                        placeholder={tc("amountIn", { symbol: sym })}
                        value={repayText}
                        onChange={(e) => setRepayText(e.target.value)}
                        className="app-input !text-[2rem]"
                        data-field="repay-some"
                      />
                      <button
                        type="button"
                        disabled={repayCap === null || repayCap === 0n}
                        onClick={() => repayCap !== null && setRepayText(formatUnits(repayCap, currency.decimals))}
                        className="type-micro mb-2 shrink-0 rounded-[6px] border border-rule-strong px-3 py-2 text-text transition-colors duration-200 hover:border-gold hover:text-gold disabled:opacity-40"
                        data-action="repay-max"
                      >
                        {t("repay.max")}
                      </button>
                    </span>
                  </label>
                  <Button variant="primary" disabled={!repay.ok || Boolean(repayError) || Boolean(busy) || repayCap === null} onClick={() => start("repay")} data-action="repay-some" className="w-full md:w-auto">
                    {busy ? <BusyLabel step={busy.step} since={busy.since} /> : t("repay.button")}
                  </Button>
                </div>
                <p className="type-body mt-3 text-muted">
                  {repayText && repayError ? (
                    <span className="text-danger">{repayError}</span>
                  ) : (
                    t.rich("repay.after", {
                      ltv: () => <Value cell={repay.ok ? afterRepay : { state: "ok", value: { ltv: ltv.state === "ok" ? ltv.value : 0n, drop: drop.state === "ok" ? drop.value : 0n } }} render={(v) => formatPercentWad(v.ltv)} className="text-text" />,
                      drop: () => <Value cell={repay.ok ? afterRepay : { state: "ok", value: { ltv: 0n, drop: drop.state === "ok" ? drop.value : 0n } }} render={(v) => formatPercentWad(v.drop)} className="text-text" />,
                    })
                  )}
                </p>
                <p className="type-body mt-2 text-muted">{t("repay.dust")}</p>
                <FeeLine query={repayFee} className="mt-3" idle={t("repay.feeIdle")} />
              </div>
            ) : (
              <div className="mt-5">
                {shares > 0n ? (
                  <p className="type-body text-text">
                    {t.rich("close.explain", {
                      debt: () => <Value cell={debt} render={(v) => `${fmt(v)} ${sym}`} className="font-semibold" />,
                      collateral: formatUnitsExact(collateral, CIRBTC_DECIMALS),
                      approval: fmt(approval),
                      symbol: sym,
                    })}
                  </p>
                ) : (
                  <p className="type-body text-text">{t("close.noDebt", { collateral: formatUnitsExact(collateral, CIRBTC_DECIMALS) })}</p>
                )}
                {short !== null && short > 0n ? (
                  <p className="type-body mt-3 text-danger" data-close-short>
                    {t.rich("close.short", {
                      held: () => <Value cell={loanTokenBalance} render={(v) => fmt(v)} />,
                      symbol: sym,
                      need: fmt(need),
                      fee: isUsdc ? t("close.includingFee") : "",
                      add: fmt(short),
                    })}
                  </p>
                ) : gasShort ? (
                  <p className="type-body mt-3 text-danger">{t("close.keepUsdc")}</p>
                ) : (
                  <>
                    {stopsGuard && (
                      <p className="type-body mt-3 text-text" data-close-stops-guard>
                        {t("close.stopsGuard")}
                      </p>
                    )}
                    <Button variant="primary" disabled={Boolean(busy) || (shares > 0n && short === null)} onClick={() => start("close")} data-action="close-loan" className="mt-5 w-full md:w-auto">
                      {busy && !frozen ? <BusyLabel step={busy.step} since={busy.since} /> : shares > 0n ? t("tabs.close") : t("tabs.takeBack")}
                    </Button>
                    {shares > 0n && short === null && !busy && <p className="type-body mt-2 text-muted" data-blocked-reason>{t("close.reading")}</p>}
                    <FeeLine query={closeFee} className="mt-3" />
                  </>
                )}
                {shares > 0n && (
                  <div className="mt-6 border-t border-rule pt-5" data-close-convert>
                    <p className="type-h4 text-text">{t("close.withOther", { symbol: sold.symbol })}</p>
                    {closeConvert.kind === "loading" ? (
                      <p className="type-body mt-2 text-muted">
                        {t("close.readingEuro", { symbol: sold.symbol })} <Reading />
                      </p>
                    ) : closeConvert.kind === "unavailable" ? (
                      <p className="type-body mt-2 text-muted">{tc("convertUnreadable")}</p>
                    ) : closeConvert.kind === "off" ? (
                      <>
                        <p className="type-body mt-2 text-text" data-close-convert-off>
                          {tl(closeConvert.reason)}
                        </p>
                        {closeConvert.reset && <ConvertReset account={address} loanToken={sold.address} canSign={!busy} onDone={() => void closeRead.refetch()} className="mt-4" />}
                      </>
                    ) : (
                      <>
                        <div className="type-body text-muted">
                          <CloseConvertEstimate e={closeConvert.estimate} />
                        </div>
                        <Button variant="secondary" disabled={Boolean(busy)} onClick={onCloseOther} data-action="close-other" className="mt-5 w-full md:w-auto">
                          {busy && frozen ? <BusyLabel step={busy.step} since={busy.since} /> : t("close.withOther", { symbol: sold.symbol })}
                        </Button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )}
            {setupNeeds.length > 0 && <GetSetUp needs={setupNeeds} className="mt-5" />}
            {(done?.kind === "added" || done?.kind === "repaid") && (
              <p className="type-body mt-4 text-success" data-tx-result={done.kind}>
                {done.text}{" "}
                <a href={`${EXPLORER}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw text-text hover:text-gold">
                  {tc("viewTheTransaction")}
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
        onCancel={() => {
          setAsking(null);
          unfreeze();
        }}
        onAccept={() => {
          rememberMorphoDisclaimer(address);
          const which = asking;
          setAsking(null);
          if (which) run(which);
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
  const t = useTranslations("loan.gauge");
  const pct = ltv.state === "ok" ? Math.min(100, ltv.value === 2n ** 256n - 1n ? 100 : Number((ltv.value * 10_000n) / WAD) / 100) : 0;
  const adag = Number((MAX_LTV_WAD * 100n) / WAD);
  const morpho = Number((lltv * 100n) / WAD);
  const tone = pct >= morpho ? "var(--danger)" : pct > adag ? "var(--pending)" : "var(--gold-fill)";
  return (
    <div className="mt-7">
      <div className="flex items-baseline justify-between">
        <p className="type-micro text-muted">{t("loanToValue")}</p>
        <p className="font-display text-[1.75rem] leading-none font-medium tabular-nums text-text">
          <Value cell={ltv} render={(v) => formatPercentWad(v)} />
        </p>
      </div>
      <div className="relative mt-3 h-3 rounded-[2px] border border-rule bg-bg/40" role="img" aria-label={t("aria", { pct: pct.toFixed(2), adag: String(adag), morpho: String(morpho) })}>
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

// The wallet's guard state for one market: whether a rule exists (AdagGuard stores a trigger of 0 for none) and what
// the loan token still lets AdagGuard pull. Read fresh before a close, never from a cached figure (C60).
async function readGuardStop(address: Address, currency: Currency): Promise<GuardStop> {
  if (!ADAG_GUARD) return { hasRule: false, allowance: 0n };
  const client = publicArc();
  const [rule, allowance] = await Promise.all([
    client.readContract({ address: ADAG_GUARD, abi: guardAbi, functionName: "ruleOf", args: [address, currency.marketId] }),
    client.readContract({ address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, ADAG_GUARD] }),
  ]);
  return { hasRule: rule.triggerWad !== 0n, allowance };
}
