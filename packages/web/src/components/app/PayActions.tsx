"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { isAddressEqual, type Address, type Hex } from "viem";
import { Button } from "@/components/Button";
import { adagAbi, erc20Abi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { buildPayConverted, buildPayFromBalance, buildPayFromBitcoin, suggestPledge, type Bill } from "@/lib/pay/build";
import { loanCurrencyFor, readLoanPriceFresh } from "@/lib/fx/estimate";
import { checkAdapterPreflight } from "@/lib/fx/preflight";
import { BILL_STATUS, CIRBTC, CIRBTC_DECIMALS, EXPLORER, MAX_LTV_WAD, MORPHO, USDC, type Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";
import { lendCovers, readyToLend } from "@/lib/pay/lend";
import { debtFromShares, liquidationDropWad, ltvWad } from "@/lib/pay/loan";
import { paramsFromTuple } from "@/lib/pay/market";
import { billPaidIn, conversionOutcome, payPanelFor, type PayPanel } from "@/lib/pay/receipt";
import type { Blocker } from "@/lib/pay/enrol";
import {
  GUARD_RULE_UNREADABLE,
  GUARD_UNREADABLE,
  coverNeeds,
  guardRepayAfterBorrow,
  guardViewOf,
  keptAsideText,
  readOwnGuard,
  triggerSentence,
  type Pending,
} from "@/lib/pay/guardView";
import { pendingGuardOutflow } from "@/lib/guard/outflow";
import { EnrolCard } from "./EnrolCard";
import { hasAcceptedMorphoDisclaimer, rememberMorphoDisclaimer } from "@/lib/wallet/consent";
import { estimateFee, publicArc, simulateAndSend, watchBills, type TxOutcome, type TxStep } from "@/lib/wallet/send";
import { Reading, Value, type Cell } from "./cells";
import { e2ePledge } from "./e2eHook";
import { keepText } from "./fee";
import { FeeLine } from "./FeeLine";
import { GetSetUp, type SetupNeed } from "./GetSetUp";
import { MorphoDisclaimer } from "./MorphoDisclaimer";
import { ConvertEstimate, ConvertReset, convertTitle } from "./fx/ConvertParts";
import { EFFECTS_UNAVAILABLE, billConvertView, reasons, type ConvertView, type Estimate } from "./fx/figures";
import { adapterReadBack, askCircle, conversionFailure, effectsCanBeChecked } from "./fx/press";
import { useBillConvert } from "./fx/useConvert";
import { SuccessCard } from "./SuccessCard";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";
import { usdHint, useUsdPrice } from "./usdPrice";

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
  // The loans this payment would check and fail, per path, from enrol.blockers (null until read), and whether the
  // loan was recorded in the current block.
  enrol: { balance: Blocker[] | null; bitcoin: Blocker[] | null; sameBlock: boolean };
  onRecorded: () => void;
  // Told whether a payment is under way, so the page keeps this panel mounted until the payment has read its receipt.
  onBusy: (busy: boolean) => void;
};


// Used only until the live fee estimate arrives, and if it cannot be read.
const USDC_FEE_FALLBACK = 10_000n;
const NATIVE_PER_USDC_UNIT = 10n ** 12n;

type Paid = {
  method: "balance" | "bitcoin" | "convert";
  hash: Hex;
  loanChecked: boolean | null;
  ltvAfter?: bigint;
  sold?: bigint;
  pledged?: bigint;
  // Set when a loan in the other currency paid it: what the swap put in the wallet and what was left over, from the
  // receipt's own Transfer logs (C72), and whether Circle's adapter reads as having no access afterwards (C67).
  borrowed?: bigint;
  converted?: bigint;
  surplus?: bigint;
  adapterClear?: boolean | null;
  effectsUnchecked?: boolean;
};
type ConvertState = { kind: "loading" } | { kind: "unavailable" } | ConvertView;

export function PayActions(props: PayActionsProps) {
  const { bill, address, currency, balance, cirBtc, position, market, price, priceStatus, needed, borrowApy, onSettled, enrol, onRecorded, onBusy } = props;
  const open = bill.status === BILL_STATUS.Open;
  const [enrolling, setEnrolling] = useState(false);
  const balanceBlockers = enrol.balance ?? [];
  const bitcoinBlockers = enrol.bitcoin ?? [];

  // C45: a guard rule that would act now pulls from this wallet within minutes, so that much is treated as spent.
  const pendingQuery = useQuery({
    queryKey: ["adag-guard-pending", address],
    queryFn: () => pendingGuardOutflow(publicArc(), address),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const pending: Pending | null | undefined = pendingQuery.data;
  // C58: the payer's own rule for this market and what it may still pull.
  const guardQuery = useQuery({
    queryKey: ["adag-guard-rule", address, currency.marketId],
    refetchInterval: 30_000,
    queryFn: () => readOwnGuard(publicArc(), address, currency.marketId, currency.address),
  });
  const guardView = guardViewOf(guardQuery);
  const guardOk = guardView.state === "ok" ? guardView : null;
  // C58 at signing: a trip the page had not shown is stopped and shown here instead of sending.
  const [caught, setCaught] = useState<string | null>(null);
  // The recording's transaction, kept on screen above the pay options once it is proven.
  const [recorded, setRecorded] = useState<Hex | null>(null);
  const router = useRouter();
  const usd = useUsdPrice();
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [paid, setPaid] = useState<Paid | null>(null);
  const [asking, setAsking] = useState<null | "bitcoin" | "convert">(null);
  // The conversion's figures as they stood when pay was pressed. The screen shows them, and the payment uses them, until
  // it ends: a refresh in between never changes what is signed (C70).
  const [frozen, setFrozen] = useState<{ estimate: Estimate } | null>(null);
  const frozenRef = useRef<{ estimate: Estimate } | null>(null);
  const unfreeze = useCallback(() => {
    frozenRef.current = null;
    setFrozen(null);
  }, []);
  // Stable on purpose: the disclaimer resets its checkbox whenever this callback changes, and this page re-renders
  // while the dialog is open (a fee estimate or a balance read landing).
  const closeDisclaimer = useCallback(() => {
    setAsking(null);
    unfreeze();
  }, [unfreeze]);
  const [active, setActive] = useState<"balance" | "bitcoin" | "convert" | null>(null);
  const [convertCaught, setConvertCaught] = useState<string | null>(null);
  const busy = tx.kind === "busy";
  // The page polls the bill and can refresh it to Paid before this payment has read its receipt; the parent keeps this
  // panel mounted while busy, so the receipt card is not lost to that refresh.
  useEffect(() => {
    onBusy(busy);
    return () => onBusy(false);
  }, [busy, onBusy]);
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));

  // The conversion option: its figures are read once and never ask Circle anything (C73), plus the payer's loan guard for
  // the loan market, which is the other currency's (C58, C69).
  const loan = loanCurrencyFor(currency.symbol);
  const convertRead = useBillConvert({ enabled: open && !paid && !busy && !frozen, payer: address, contract: bill.contract, billSymbol: currency.symbol, total: bill.amount, otherTotal: 0n });
  const loanGuardQuery = useQuery({
    queryKey: ["adag-guard-rule", address, loan.marketId],
    refetchInterval: 30_000,
    queryFn: () => readOwnGuard(publicArc(), address, loan.marketId, loan.address),
  });
  const loanGuardView = guardViewOf(loanGuardQuery);
  const convertState: ConvertState = frozen
    ? { kind: "ready", estimate: frozen.estimate }
    : convertRead.data
      ? billConvertView(convertRead.data, { otherConverts: false, otherBill: null, sharedBorrow: 0n })
      : convertRead.isError
        ? { kind: "unavailable" }
        : { kind: "loading" };
  const convertEstimate = convertState.kind === "ready" ? convertState.estimate : null;
  const convertFigures = convertRead.data && convertRead.data.state === "ok" ? convertRead.data : null;
  // C58: this conversion's loan-to-value against the payer's own guard trigger, in the loan market.
  const convertGuardAfter =
    convertEstimate && convertFigures && loanGuardView.state === "ok"
      ? guardRepayAfterBorrow({
          rule: loanGuardView.rule,
          nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
          ltvAfterWad: convertEstimate.ltvAfter,
          before: { shares: convertFigures.position[1], collateral: convertFigures.position[2] },
          totals: { totalBorrowAssets: convertFigures.market[2], totalBorrowShares: convertFigures.market[3] },
          borrow: convertEstimate.amountIn,
          pledge: convertEstimate.pledge,
          price: convertFigures.price,
          allowance: loanGuardView.allowance,
          balanceAfter: convertFigures.loanBalance,
        })
      : null;
  const convertShortOfBtc = convertEstimate !== null && convertEstimate.cirBtc < convertEstimate.pledge;
  // The loans the conversion would check and fail: the same list as paying from balance, less the loan market, whose
  // new borrowing the pledge already sizes.
  const convertBlockers = balanceBlockers.filter((b) => b.market.toLowerCase() !== loan.marketId.toLowerCase());

  const fresh = priceStatus.state === "ok" ? priceStatus.value[0] : null;
  const pledge: Cell<bigint> = needed.state === "ok" ? { state: "ok", value: suggestPledge(needed.value) } : needed;
  const isUsdc = isAddressEqual(currency.address, USDC);
  const shortOfBtc = pledge.state === "ok" && cirBtc.state === "ok" && cirBtc.value < pledge.value;
  const amountText = `${formatUnitsExact(bill.amount, currency.decimals)} ${currency.symbol}`;
  // An unreadable market never counts as short: the dry run before signing still refuses a market without the cash.
  const ready: Cell<bigint> = market.state === "ok" ? { state: "ok", value: readyToLend(market.value) } : market;
  const lendShort = ready.state === "ok" && !lendCovers(ready.value, bill.amount);
  const readyText = (v: bigint) => `${formatUnitsExact(v, currency.decimals)} ${currency.symbol}`;

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
  const bitcoinFee = useQuery({
    queryKey: ["adag-fee", "bitcoin", bill.contract, bill.id.toString(), address, pledgeValue?.toString()],
    enabled: open && fresh === true && pledgeValue !== null && !shortOfBtc && !lendShort && !paid,
    staleTime: 30_000,
    retry: false,
    // The fixed params go in here; the real payment re-reads Morpho's and proves them by hash before building.
    queryFn: () => {
      const built = buildPayFromBitcoin(bill, address, pledgeValue!, currency.params);
      return estimateFee({ account: address, to: built.to, data: built.data });
    },
  });
  const heldEnoughForBill = balance.state === "ok" && balance.value >= bill.amount;
  const balanceFee = useQuery({
    queryKey: ["adag-fee", "balance", bill.contract, bill.id.toString(), address],
    // With an unrecorded loan the estimate would only revert, so it waits for the recording.
    enabled: open && heldEnoughForBill && !paid && (enrol.balance?.length ?? 0) === 0,
    staleTime: 30_000,
    retry: false,
    queryFn: () => {
      const built = buildPayFromBalance(bill, address);
      return estimateFee({ account: address, to: built.to, data: built.data });
    },
  });
  // A USDC bill from balance needs the bill plus the most the fee can be, because on Arc both come from one balance,
  // plus whatever the loan guard is about to pull in the same token (C45).
  const reserve = isUsdc ? (balanceFee.data ? (balanceFee.data.keepUpTo + NATIVE_PER_USDC_UNIT - 1n) / NATIVE_PER_USDC_UNIT : USDC_FEE_FALLBACK) : 0n;
  const keptAside = pending ? (isUsdc ? pending.usdc : pending.eurc) : 0n;
  const enough: boolean | null =
    balance.state !== "ok" || pending === undefined ? null : isUsdc && balanceFee.isPending && balanceFee.fetchStatus !== "idle" && heldEnoughForBill ? null : balance.value >= bill.amount + reserve + keptAside;

  const settle = async (method: Paid["method"], hash: Hex, logs: Parameters<typeof billPaidIn>[0] | null, extra: () => Promise<Partial<Paid>>) => {
    const record = await publicArc()
      .readContract({ address: bill.contract, abi: adagAbi, functionName: "bill", args: [bill.id] })
      .catch(() => null);
    const proof = logs ? billPaidIn(logs, bill.contract, bill.id, address) : null;
    // C16, C53: the bill's own contract's BillPaid in the receipt, or, when the receipt never came, that contract's
    // record naming this payer.
    const proven = record !== null && record.status === BILL_STATUS.Paid && (proof !== null || (logs === null && isAddressEqual(record.payer, address)));
    if (!proven) {
      setTx({ kind: "failed", message: "Arc confirmed the transaction, but Adag has no payment record for this bill in it. Check the link before trying again.", href: `${EXPLORER}/tx/${hash}` });
      return;
    }
    const more = await extra().catch(() => ({}));
    setPaid({ method, hash, loanChecked: proof ? proof.loanChecked : null, ...more });
    setTx({ kind: "idle" });
    onSettled();
    router.refresh();
  };

  // One ending for both paths: refusals in plain words, and a receipt that never came is checked against the bill
  // itself for up to two minutes, so nobody pays twice.
  const conclude = async (out: TxOutcome, method: Paid["method"], extra: () => Promise<Partial<Paid>>) => {
    if (out.ok) return settle(method, out.hash, out.receipt.logs, extra);
    if (out.stage === "refused") {
      // A check on an existing loan: read the loans again, so the enrol card can take the place of the raw refusal.
      if (out.error.name === "LtvAboveLimit" || out.error.name === "StalePrice") onRecorded();
      return setTx(method === "convert" ? conversionFailure(out) : { kind: "refused", error: out.error });
    }
    if (out.stage === "unconfirmed") {
      step("watching");
      if (await watchBills(bill.contract, [bill.id], BILL_STATUS.Paid, address)) return settle(method, out.hash, null, extra);
      return setTx({ kind: "failed", message: "Arc has not confirmed it after two minutes. Do not pay again: check the transaction first.", href: `${EXPLORER}/tx/${out.hash}` });
    }
    setTx(method === "convert" ? conversionFailure(out) : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
  };

  const payFromBalance = async () => {
    setActive("balance");
    let built;
    try {
      built = buildPayFromBalance(bill, address);
    } catch (error) {
      setTx({ kind: "failed", message: (error as Error).message });
      return;
    }
    step("checking");
    // C45, read again at the moment of paying: what the guard is about to pull counts as already spent.
    const fresh = await pendingGuardOutflow(publicArc(), address);
    if (!fresh) return setTx({ kind: "failed", message: GUARD_UNREADABLE });
    const cover = coverNeeds({ symbol: currency.symbol, from: "balance", amount: bill.amount, pending: fresh });
    if (!isUsdc) {
      const held = await publicArc()
        .readContract({ address: currency.address, abi: erc20Abi, functionName: "balanceOf", args: [address] })
        .catch(() => null);
      if (held === null) return setTx({ kind: "failed", message: "Arc did not answer with your balance. Nothing was sent. Try again." });
      if (held < cover.needInToken) {
        return setTx({
          kind: "failed",
          message: `This payment needs ${formatUnitsExact(cover.needInToken, currency.decimals)} ${currency.symbol}: the bill plus ${formatUnitsExact(fresh.eurc, currency.decimals)} your loan guard is about to repay. Your wallet holds ${formatUnitsExact(held, currency.decimals)}. Nothing was sent.`,
        });
      }
    }
    // On Arc a USDC payment and the fee come out of one balance, so the check covers both, plus the guard's USDC.
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: cover.usdcOut });
    await conclude(out, "balance", async () => ({}));
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
        client.readContract({ address: bill.contract, abi: adagAbi, functionName: "priceStatus", args: [m] }),
        client.readContract({ address: bill.contract, abi: adagAbi, functionName: "collateralNeeded", args: [address, m, bill.amount] }),
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
    const pendingNow = await pendingGuardOutflow(client, address);
    if (!pendingNow) return setTx({ kind: "failed", message: GUARD_UNREADABLE });
    // C58, read again at the moment of signing: the rule and the approval, against the loan as it will stand.
    const guardNow = await readOwnGuard(client, address, m, currency.address);
    if (guardNow.state !== "ok") return setTx({ kind: "failed", message: GUARD_RULE_UNREADABLE });
    let tripNow: string | null = null;
    try {
      const [mk, px, tokenHeld] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [m] }),
        client.readContract({ address: currency.params.oracle, abi: oracleAbi, functionName: "price" }),
        client.readContract({ address: currency.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      ]);
      const ltvAfterWad = ltvWad(debtFromShares(before[1], mk[2], mk[3]) + bill.amount, before[2] + chosen, px);
      const repay = guardRepayAfterBorrow({
        rule: guardNow.rule,
        nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        ltvAfterWad,
        before: { shares: before[1], collateral: before[2] },
        totals: { totalBorrowAssets: mk[2], totalBorrowShares: mk[3] },
        borrow: bill.amount,
        pledge: chosen,
        price: px,
        allowance: guardNow.allowance,
        balanceAfter: tokenHeld,
      });
      if (repay) tripNow = triggerSentence({ ltvAfterWad, amount: repay.amount, triggerWad: repay.triggerWad, targetWad: repay.targetWad, symbol: currency.symbol });
    } catch {
      return setTx({ kind: "failed", message: GUARD_RULE_UNREADABLE });
    }
    if (tripNow && !guardAfter && caught === null) {
      setCaught(tripNow);
      return setTx({ kind: "failed", message: "Your loan guard changed since this page loaded: read the note above before paying. Nothing was sent." });
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: coverNeeds({ symbol: currency.symbol, from: "bitcoin", amount: bill.amount, pending: pendingNow }).usdcOut });
    await conclude(out, "bitcoin", async () => {
      const [heldAfter, afterPos, ltv] = await Promise.all([
        client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [m, address] }),
        client.readContract({ address: bill.contract, abi: adagAbi, functionName: "loanToValue", args: [address, m] }),
      ]);
      // Bitcoin sold is what left the wallet and the pledge together. Pledging moves it; it does not sell it.
      return { ltvAfter: ltv, sold: held + before[2] - (heldAfter + afterPos[2]), pledged: chosen };
    });
  };

  // Paying from a loan in the other currency (C65 to C75): every check is read again at the moment of paying against the
  // figures frozen at the press, Circle is asked once and last, and nothing reaches the wallet unless the sender's own
  // checks and the transfer trace both pass.
  const payFromConvert = async () => {
    const est = frozenRef.current?.estimate;
    if (!est) return;
    setActive("convert");
    step("checking");
    const client = publicArc();
    const sold = est.loan;
    const failed = (message: string) => setTx({ kind: "failed", message: `${message} Nothing was sent.` });
    try {
      // The bill is read again: the figures on screen were sized for exactly this amount.
      const record = await client.readContract({ address: bill.contract, abi: adagAbi, functionName: "bill", args: [bill.id] });
      if (record.status !== BILL_STATUS.Open || record.amount !== bill.amount || !isAddressEqual(record.payee, bill.payee) || !isAddressEqual(record.currency, bill.currency) || record.ref !== bill.ref) {
        return failed("This bill changed since the page loaded. Reload the page to see it as it is now.");
      }
    } catch {
      return failed("Arc did not answer, so the payment was not built. Try again.");
    }
    const pendingNow = await pendingGuardOutflow(client, address);
    if (!pendingNow) return setTx({ kind: "failed", message: GUARD_UNREADABLE });
    let tuple: readonly [Hex, Hex, Hex, Hex, bigint];
    try {
      const [loanFresh, mk, params, held, pre] = await Promise.all([
        readLoanPriceFresh(client, bill.contract, currency.symbol),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [sold.marketId] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [sold.marketId] }),
        client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
        checkAdapterPreflight(client, address, sold.address),
      ]);
      if (loanFresh === false) return failed(reasons.loanPaused(sold.symbol));
      if (loanFresh === null) return failed(reasons.loanUnknown(sold.symbol));
      if (pre.state !== "clear") return failed(pre.state === "blocked" ? pre.blockers.join(" ") : pre.text);
      const cash = readyToLend(mk);
      if (!lendCovers(cash, est.amountIn)) return failed(reasons.cash(cash, est.amountIn, sold.symbol));
      if (held < est.pledge) return failed(`This payment pledges ${formatUnitsExact(est.pledge, CIRBTC_DECIMALS)} cirBTC and your wallet holds ${formatUnitsExact(held, CIRBTC_DECIMALS)}.`);
      tuple = params;
    } catch {
      return failed("Arc did not answer, so the payment was not built. Try again.");
    }

    // C58, read again at the moment of signing, in the loan market: a trip the page had not shown stops here.
    const guardNow = await readOwnGuard(client, address, sold.marketId, sold.address);
    if (guardNow.state !== "ok") return setTx({ kind: "failed", message: GUARD_RULE_UNREADABLE });
    let tripNow: string | null = null;
    try {
      const [pos, mk, px, tokenHeld] = await Promise.all([
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [sold.marketId, address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [sold.marketId] }),
        client.readContract({ address: sold.params.oracle, abi: oracleAbi, functionName: "price" }),
        client.readContract({ address: sold.address, abi: erc20Abi, functionName: "balanceOf", args: [address] }),
      ]);
      const ltvAfterWad = ltvWad(debtFromShares(pos[1], mk[2], mk[3]) + est.amountIn, pos[2] + est.pledge, px);
      const repay = guardRepayAfterBorrow({
        rule: guardNow.rule,
        nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
        ltvAfterWad,
        before: { shares: pos[1], collateral: pos[2] },
        totals: { totalBorrowAssets: mk[2], totalBorrowShares: mk[3] },
        borrow: est.amountIn,
        pledge: est.pledge,
        price: px,
        allowance: guardNow.allowance,
        balanceAfter: tokenHeld,
      });
      if (repay) tripNow = triggerSentence({ ltvAfterWad, amount: repay.amount, triggerWad: repay.triggerWad, targetWad: repay.targetWad, symbol: sold.symbol });
    } catch {
      return setTx({ kind: "failed", message: GUARD_RULE_UNREADABLE });
    }
    if (tripNow && !convertGuardAfter && convertCaught === null) {
      setConvertCaught(tripNow);
      return setTx({ kind: "failed", message: "Your loan guard changed since this page loaded: read the note above before paying. Nothing was sent." });
    }

    // C73: Circle is asked here, for exactly the frozen amount (the identical request is repeated at most twice for "no
    // route" or rate limiting). If it still refuses, times out or answers badly, its fixed sentence is shown and the payer
    // presses again; nothing is raised.
    const asked = await askCircle(client, { payer: address, sell: sold, buy: currency, amountIn: est.amountIn, minOut: bill.amount });
    if (!asked.ok) return setTx({ kind: "failed", message: asked.message });
    let built;
    try {
      built = buildPayConverted(bill, address, {
        from: "convert",
        loan: sold.symbol,
        amountIn: est.amountIn,
        pledge: est.pledge,
        marketParams: paramsFromTuple(tuple),
        plan: asked.pinned.plan,
        outputBalance: asked.pinned.outputBalance,
        maxFeePerGas: asked.pinned.maxFeePerGas,
        chainTime: asked.pinned.chainTime,
        rate: asked.pinned.rate,
      });
    } catch (error) {
      return failed((error as Error).message);
    }
    // C71, failing closed: a conversion is only signed when this connection can trace the transfers it makes.
    if (!(await effectsCanBeChecked(client))) return setTx({ kind: "failed", message: EFFECTS_UNAVAILABLE });
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: pendingNow.usdc, conversion: built.conversion });
    await conclude(out, "convert", async () => {
      // What the swap returned comes from the receipt's own Transfer logs, and Circle's adapter is read back to 0 (C67, C72).
      const outcome = out.ok ? conversionOutcome(out.receipt.logs, { token: currency.address, payer: address, spent: bill.amount }) : null;
      const [adapterClear, ltv] = await Promise.all([
        adapterReadBack(client, address),
        client.readContract({ address: bill.contract, abi: adagAbi, functionName: "loanToValue", args: [address, sold.marketId] }),
      ]);
      return {
        borrowed: est.amountIn,
        converted: outcome?.converted,
        surplus: outcome?.surplus,
        adapterClear,
        ltvAfter: ltv,
        pledged: est.pledge,
        effectsUnchecked: out.ok && out.effects === "unavailable",
      };
    });
  };

  const onBitcoin = () => {
    setTx({ kind: "idle" });
    if (hasAcceptedMorphoDisclaimer(address)) void payFromBitcoin();
    else setAsking("bitcoin");
  };

  // Pressing pay freezes the figures on screen: the payment below uses exactly these, and anything that moves after the
  // press needs a new press (C70).
  const runConvert = async () => {
    try {
      await payFromConvert();
    } finally {
      unfreeze();
    }
  };
  const onConvert = () => {
    setTx({ kind: "idle" });
    if (!convertEstimate) return;
    const snapshot = { estimate: convertEstimate };
    frozenRef.current = snapshot;
    setFrozen(snapshot);
    if (hasAcceptedMorphoDisclaimer(address)) void runConvert();
    else setAsking("convert");
  };

  const panel = payPanelFor({ status: bill.status, paid: paid !== null, busy });
  if (paid) {
    return (
      <SuccessCard
        status="paid"
        hash={paid.hash}
        title={`Bill #${bill.id} is paid.`}
        rows={[
          { label: "Supplier received", value: amountText },
          {
            label: "Paid from",
            value:
              paid.method === "balance"
                ? `Your ${currency.symbol} balance`
                : paid.method === "convert"
                  ? `A ${loan.symbol} loan against your cirBTC, converted to ${currency.symbol} by Circle`
                  : "A loan against your cirBTC",
          },
          ...(paid.method === "convert"
            ? [
                {
                  label: "Borrowed and converted",
                  value:
                    paid.borrowed !== undefined && paid.converted !== undefined
                      ? `${formatUnitsExact(paid.borrowed, 6)} ${loan.symbol} became ${formatUnitsExact(paid.converted, 6)} ${currency.symbol}`
                      : "unavailable",
                },
                { label: "Left in your wallet", value: paid.surplus !== undefined ? `${formatUnitsExact(paid.surplus, 6)} ${currency.symbol}` : "unavailable" },
                { label: "Pledged now", value: paid.pledged !== undefined ? `${formatUnitsExact(paid.pledged, CIRBTC_DECIMALS)} cirBTC more${usdHint(paid.pledged, usd)}` : "unavailable" },
                { label: `${loan.symbol} loan-to-value after`, value: paid.ltvAfter !== undefined ? formatPercentWad(paid.ltvAfter) : "unavailable" },
                { label: "40% check", value: paid.loanChecked === null ? "See the transaction" : paid.loanChecked ? "Ran and passed" : "Not needed" },
                { label: "Your debt", value: `In ${loan.symbol}. Its dollar cost moves with the euro.` },
                {
                  label: "Circle's adapter",
                  value: (
                    <span data-adapter-clear={String(paid.adapterClear ?? null)}>
                      {paid.adapterClear === true ? "No access to your wallet is left." : paid.adapterClear === false ? "It still has access to your wallet." : "Its access could not be read."}
                      {paid.adapterClear !== true && <ConvertReset account={address} loanToken={loan.address} canSign onDone={() => setPaid((p) => (p ? { ...p, adapterClear: true } : p))} className="mt-2" />}
                    </span>
                  ),
                },
                ...(paid.effectsUnchecked
                  ? [{ label: "Extra check", value: "Adag could not trace this conversion's transfers before you signed, so only the payment's own balance check guarded it." }]
                  : []),
                { label: "Your bitcoin back", value: "Repay any time from Your wallet: Close loan, or close it with the other currency." },
              ]
            : []),
          ...(paid.method === "bitcoin"
            ? [
                { label: "Bitcoin sold", value: paid.sold !== undefined ? `${paid.sold === 0n ? "0" : formatUnitsExact(paid.sold, CIRBTC_DECIMALS)} cirBTC` : "unavailable" },
                {
                  label: "Pledged now",
                  value: paid.pledged !== undefined ? `${formatUnitsExact(paid.pledged, CIRBTC_DECIMALS)} cirBTC more${usdHint(paid.pledged, usd)}` : "unavailable",
                },
                { label: "Loan-to-value after", value: paid.ltvAfter !== undefined ? formatPercentWad(paid.ltvAfter) : "unavailable" },
                { label: "40% check", value: paid.loanChecked === null ? "See the transaction" : paid.loanChecked ? "Ran and passed" : "Not needed" },
                { label: "Your bitcoin back", value: "Repay any time from Your wallet: Close loan." },
              ]
            : []),
        ]}
      />
    );
  }

  if (panel !== "options") {
    return (
      <div className="app-panel flex h-full flex-col p-6 md:p-8" data-pay-closed={panel}>
        <p className="type-label text-muted">Pay this bill</p>
        <p className="type-lead mt-4 text-text">{closedText(bill.status, panel)}</p>
        <div className="mt-5">
          <TxMessage state={tx} />
        </div>
      </div>
    );
  }

  const needs: SetupNeed[] = [];
  if (shortOfBtc) needs.push("cirbtc");
  if (enough === false && isUsdc) needs.push("usdc");

  // Why the bitcoin button cannot be pressed yet, said in words under it.
  const bitcoinBlocked: string | null = busy
    ? null
    : guardView.state === "unreadable"
      ? GUARD_RULE_UNREADABLE
      : guardView.state === "pending"
        ? "Reading your loan guard on Arc."
        : fresh === null
      ? "Reading the bitcoin price status on Arc."
      : pledge.state === "loading" || cirBtc.state === "loading"
        ? "Reading your position on Arc."
        : pledge.state === "unavailable" || cirBtc.state === "unavailable"
          ? "Your position could not be read. Try again below."
          : shortOfBtc
            ? "Your wallet holds less cirBTC than this pledge."
            : null;

  const busyStep = tx.kind === "busy" ? tx : null;

  // The loan in this market as it stands, before the payment: over 40% means the pledge must cover all of it.
  const wholeLoanOver =
    position.state === "ok" && market.state === "ok" && price.state === "ok" && position.value[1] > 0n
      ? ltvWad(debtFromShares(position.value[1], market.value[2], market.value[3]), position.value[2], price.value) > MAX_LTV_WAD
      : false;

  // C58: this payment's loan-to-value against the payer's own guard trigger, and what the guard would then repay.
  const guardAfter =
    guardOk && after.state === "ok" && position.state === "ok" && market.state === "ok" && price.state === "ok" && pledge.state === "ok" && balance.state === "ok"
      ? guardRepayAfterBorrow({
          rule: guardOk.rule,
          nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
          ltvAfterWad: after.value.ltv,
          before: { shares: position.value[1], collateral: position.value[2] },
          totals: { totalBorrowAssets: market.value[2], totalBorrowShares: market.value[3] },
          borrow: bill.amount,
          pledge: pledge.value,
          price: price.value,
          allowance: guardOk.allowance,
          balanceAfter: balance.value,
        })
      : null;

  // A refusal from the dry run about a loan the payer already had is answered by the enrol card, not raw words.
  const refusedOnOldLoan =
    tx.kind === "refused" &&
    ((tx.error.name === "LtvAboveLimit" && balanceBlockers.some((b) => b.market.toLowerCase() === String(tx.error.args?.[0] ?? "").toLowerCase())) ||
      (tx.error.name === "StalePrice" && balanceBlockers.some((b) => b.reason === "stale")));
  // Stays mounted while recording, so a background re-read that already sees the recorded loan cannot drop the card
  // before it has waited for the next block.
  const showEnrol = balanceBlockers.length > 0 || refusedOnOldLoan || enrolling;
  const guardBlocked = pending === null;
  const pendingText = pending ? keptAsideText(pending) : null;

  return (
    <div className="app-panel flex h-full flex-col p-6 md:p-8">
      <p className="type-label text-muted">Pay this bill</p>

      {recorded && !showEnrol && (
        <p className="type-body mt-5 flex items-center gap-3 text-text" data-enrol-recorded>
          <span aria-hidden="true" className="diamond !bg-success" />
          Loan recorded ·{" "}
          <a href={`${EXPLORER}/tx/${recorded}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold hover:text-text">
            view the transaction
          </a>
        </p>
      )}
      {showEnrol && (
        <div className="mt-5">
          <EnrolCard
            contract={bill.contract}
            address={address}
            blockers={balanceBlockers}
            canSign={!busy}
            onBusy={setEnrolling}
            onRecorded={(hash) => {
              setTx({ kind: "idle" });
              setRecorded(hash);
              onRecorded();
            }}
          />
        </div>
      )}
      {enrol.sameBlock && !showEnrol && (
        <p className="type-body mt-5 text-muted" data-enrol-state="same-block">
          Your loan was recorded in Arc&apos;s latest block. The payment opens with the next one, in a moment.
        </p>
      )}
      {guardBlocked && (
        <p className="type-body mt-5 text-danger" data-guard-unreadable>
          {GUARD_UNREADABLE}
        </p>
      )}

      <div className="mt-5 border-b border-rule pb-6">
        <p className="type-h4 text-text">From your balance</p>
        <p className="type-body mt-2 text-muted">
          {enough === null ? (
            balance.state === "unavailable" ? (
              `Your ${currency.symbol} balance is unavailable right now.`
            ) : (
              <Reading />
            )
          ) : enough ? (
            `You hold ${formatUnitsExact((balance as { value: bigint }).value, currency.decimals)} ${currency.symbol}. One signature approves exactly the bill amount and pays it.`
          ) : keptAside > 0n && balance.state === "ok" && balance.value >= bill.amount + reserve ? (
            // The reason first: without the guard's repayment the wallet would cover this.
            `Your loan guard is about to use ${formatUnitsExact(keptAside, currency.decimals)} ${currency.symbol} from this wallet, so none is free for this bill.`
          ) : isUsdc ? (
            `You need ${amountText} for the bill and a little USDC for the network fee${balanceFee.data ? `: ${keepText(balanceFee.data.keepUpTo)}` : ""}. Your wallet holds ${formatUnitsExact((balance as { value: bigint }).value, currency.decimals)} USDC, so paying from balance is not offered.`
          ) : (
            `You hold less ${currency.symbol} than this bill, so paying from balance is not offered.`
          )}
        </p>
        {enough && (
          <>
            <Button
              variant={fresh ? "secondary" : "primary"}
              disabled={busy || enrolling || balanceBlockers.length > 0 || enrol.sameBlock || guardBlocked}
              onClick={() => void payFromBalance()}
              className="mt-5 w-full md:w-auto"
              data-action="pay-balance"
            >
              {busyStep && active === "balance" ? <BusyLabel step={busyStep.step} since={busyStep.since} /> : `Pay ${amountText} from balance`}
            </Button>
            {balanceBlockers.length > 0 ? (
              <p className="type-body mt-3 text-muted" data-fee-waits>
                Opens once your loan is recorded. The network fee shows then.
              </p>
            ) : (
              <FeeLine query={balanceFee} className="mt-3" />
            )}
          </>
        )}
        {pendingText && (
          <p className="type-body mt-2 text-muted" data-guard-pending>
            {pendingText}
          </p>
        )}
      </div>

      <div className="pt-6">
        <p className="type-h4 text-text">From bitcoin</p>
        {fresh === false ? (
          // C24: no bitcoin path while the price is stale.
          <p className="type-body mt-2 text-text" data-price="stale">
            New loans are paused until the bitcoin price updates. Paying from your balance still works.
          </p>
        ) : lendShort ? (
          <p className="type-body mt-2 text-text" data-lend="short">
            Morpho has <Value cell={ready} render={readyText} className="font-semibold" /> ready to lend right now, less than this bill. Paying from your balance still works, or check
            back later.
          </p>
        ) : (
          <>
            <ul className="mt-4 space-y-3" data-plain-lead>
              <li className="type-lead text-text">
                The supplier gets <span className="font-semibold">{amountText}</span>.
              </li>
              <li className="type-lead text-text">
                {pledge.state === "ok" && pledge.value === 0n ? (
                  <>
                    You pledge <span className="font-semibold">no extra cirBTC</span>: what you already pledged covers this. Nothing is sold.
                  </>
                ) : (
                  <>
                    You pledge{" "}
                    <Value cell={pledge} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC${usdHint(v, usd)}`} className="font-semibold" /> and keep it. Nothing is
                    sold.
                  </>
                )}
              </li>
              <li className="type-lead text-text">
                Bitcoin can fall <Value cell={after} render={(v) => formatPercentWad(v.drop)} className="font-semibold" /> before Morpho may liquidate.
              </li>
            </ul>
            <p className="type-body mt-3 text-muted">
              Morpho has <Value cell={ready} render={readyText} className="text-text" /> ready to lend now.
            </p>

            <details className="group mt-5 rounded-[8px] border border-rule">
              <summary className="type-label flex cursor-pointer list-none items-center justify-between px-4 py-3 text-muted transition-colors duration-200 hover:text-text">
                Details
                <span aria-hidden="true" className="transition-transform duration-200 group-open:rotate-45">
                  +
                </span>
              </summary>
              <dl className="grid grid-cols-2 gap-x-6 gap-y-5 border-t border-rule px-4 py-4">
                <Figure label="Loan-to-value after" cell={after} render={(v) => formatPercentWad(v.ltv)} note={`Adag refuses anything over ${formatPercentWad(MAX_LTV_WAD)}`} />
                <Figure label="Morpho borrow rate" cell={borrowApy} render={(v) => `${(v * 100).toFixed(2)}% a year`} note="live, variable" />
                <Figure label="cirBTC in your wallet" cell={cirBtc} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC`} note={cirBtc.state === "ok" ? usdHint(cirBtc.value, usd).replace(/^ \(|\)$/g, "") : undefined} />
                <Figure label="Liquidation line" cell={{ state: "ok", value: currency.params.lltv }} render={(v) => formatPercentWad(v)} note="Morpho's, not Adag's" />
              </dl>
              <div className="border-t border-rule px-4 py-4">
                <FeeLine query={bitcoinFee} />
                <p className="type-body mt-2 text-muted">The pledge is Adag&apos;s own figure plus 5% for price moves. Repay any time from Your wallet to take the bitcoin back.</p>
              </div>
            </details>

            {wholeLoanOver && (
              <p className="type-body mt-4 text-muted" data-whole-loan-over>
                Your whole {currency.symbol} loan is above 40%, so a new loan must bring all of it back under the line. That is why the pledge is this large.
              </p>
            )}
            {(guardAfter || caught) && (
              <p className="type-body mt-5 text-text" data-guard-trigger>
                {guardAfter && after.state === "ok"
                  ? triggerSentence({ ltvAfterWad: after.value.ltv, amount: guardAfter.amount, triggerWad: guardAfter.triggerWad, targetWad: guardAfter.targetWad, symbol: currency.symbol })
                  : caught}
              </p>
            )}
            <Button
              variant="primary"
              disabled={busy || enrolling || fresh !== true || shortOfBtc || lendShort || pledge.state !== "ok" || bitcoinBlockers.length > 0 || enrol.sameBlock || guardBlocked || guardView.state !== "ok"}
              onClick={onBitcoin}
              className="mt-6 w-full md:w-auto"
              data-action="pay-bitcoin"
            >
              {busyStep && active === "bitcoin" ? <BusyLabel step={busyStep.step} since={busyStep.since} /> : "Pay from bitcoin"}
            </Button>
            {bitcoinBlocked && (
              <p className={`type-body mt-2 ${shortOfBtc ? "text-danger" : "text-muted"}`} data-blocked-reason>
                {bitcoinBlocked}
              </p>
            )}
          </>
        )}
      </div>

      <div className="mt-6 border-t border-rule pt-6" data-convert-section>
        <p className="type-h4 text-text">{convertTitle(loan)}</p>
        {convertState.kind === "loading" ? (
          <p className="type-body mt-2 text-muted">
            Reading the euro price and the {loan.symbol} market on Arc. <Reading />
          </p>
        ) : convertState.kind === "unavailable" ? (
          <p className="type-body mt-2 text-muted">Adag could not read what a conversion needs, so it is off. Reload to try again.</p>
        ) : convertState.kind === "off" ? (
          <>
            <p className="type-body mt-2 text-text" data-convert-off>
              {convertState.reason}
            </p>
            {convertState.reset && <ConvertReset account={address} loanToken={loan.address} canSign={!busy} onDone={() => void convertRead.refetch()} className="mt-4" />}
          </>
        ) : (
          <>
            <div className="type-body text-muted">
              <ConvertEstimate e={convertState.estimate} />
            </div>
            {(convertGuardAfter || convertCaught) && (
              <p className="type-body mt-5 text-text" data-guard-trigger>
                {convertGuardAfter
                  ? triggerSentence({ ltvAfterWad: convertState.estimate.ltvAfter, amount: convertGuardAfter.amount, triggerWad: convertGuardAfter.triggerWad, targetWad: convertGuardAfter.targetWad, symbol: loan.symbol })
                  : convertCaught}
              </p>
            )}
            <Button
              variant="secondary"
              disabled={busy || enrolling || convertBlockers.length > 0 || enrol.sameBlock || guardBlocked || loanGuardView.state !== "ok" || convertShortOfBtc}
              onClick={onConvert}
              className="mt-6 w-full md:w-auto"
              data-action="pay-convert"
            >
              {busyStep && active === "convert" ? <BusyLabel step={busyStep.step} since={busyStep.since} /> : `Pay from bitcoin, borrowing ${loan.symbol}`}
            </Button>
            {!busy && (convertShortOfBtc || convertBlockers.length > 0 || loanGuardView.state !== "ok") && (
              <p className={`type-body mt-2 ${convertShortOfBtc ? "text-danger" : "text-muted"}`} data-convert-blocked>
                {convertShortOfBtc
                  ? "Your wallet holds less cirBTC than this pledge."
                  : convertBlockers.length > 0
                    ? "Record your existing loan first, above."
                    : loanGuardView.state === "unreadable"
                      ? GUARD_RULE_UNREADABLE
                      : "Reading your loan guard on Arc."}
              </p>
            )}
          </>
        )}
      </div>

      {needs.length > 0 && <GetSetUp needs={needs} className="mt-6" />}

      <div className="mt-5">
        <TxMessage state={refusedOnOldLoan ? { kind: "idle" } : tx} />
      </div>

      <MorphoDisclaimer
        open={asking !== null}
        onCancel={closeDisclaimer}
        onAccept={() => {
          rememberMorphoDisclaimer(address);
          const which = asking;
          setAsking(null);
          void (which === "convert" ? runConvert() : payFromBitcoin());
        }}
      />
    </div>
  );
}

function closedText(status: number, panel: PayPanel): string {
  if (panel === "progress") {
    return status === BILL_STATUS.Paid
      ? "Arc already shows this bill as paid. Adag is reading your transaction to confirm the payment is yours."
      : "This bill was cancelled while your payment was on its way. Adag is reading your transaction.";
  }
  return status === BILL_STATUS.Paid ? "Already paid. Nothing to pay here." : status === BILL_STATUS.Void ? "Cancelled. It can never be paid." : "This bill cannot be paid.";
}

function Figure<T>({ label, cell, render, note }: { label: string; cell: Cell<T>; render: (v: T) => React.ReactNode; note?: string }) {
  return (
    <div>
      <dt className="type-micro text-muted">{label}</dt>
      <dd className="mt-2 font-display text-[1.35rem] leading-none font-medium tabular-nums text-text">
        <Value cell={cell} render={render} />
      </dd>
      {note && <dd className="type-micro mt-2 text-muted normal-case tracking-[0.04em]">{note}</dd>}
    </div>
  );
}
