"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { isAddressEqual, type Address, type Hex } from "viem";
import { BillStamp, type BillStatus } from "@/components/BillStamp";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { adagAbi, erc20Abi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { billFromJson, type BillJson } from "@/lib/pay/billJson";
import { buildPayMany, suggestPledge, type BasketPlan, type Bill } from "@/lib/pay/build";
import { billHref } from "@/lib/pay/billId";
import {
  BILL_STATUS,
  CIRBTC,
  CIRBTC_DECIMALS,
  CURRENCIES,
  EXPLORER,
  MARKET_EURC,
  MARKET_USDC,
  MAX_LTV_WAD,
  MORPHO,
  USDC,
  deploymentOf,
  requireDeployment,
  type Currency,
} from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact, fullAddress, referenceText, shortAddress } from "@/lib/pay/format";
import { debtFromShares, liquidationDropWad, ltvWad } from "@/lib/pay/loan";
import { currencyOf, paramsFromTuple } from "@/lib/pay/market";
import { billsPaidIn } from "@/lib/pay/receipt";
import { GUARD_UNREADABLE, guardRepayAfterBorrow, keptAsideText, type GuardRule, type Pending } from "@/lib/pay/guardView";
import { guardAbi } from "@/lib/guard/abi";
import { ADAG_GUARD } from "@/lib/guard/constants";
import { pendingGuardOutflow } from "@/lib/guard/outflow";
import { hasAcceptedMorphoDisclaimer, rememberMorphoDisclaimer } from "@/lib/wallet/consent";
import { estimateFee, publicArc, simulateAndSend, watchBills, type TxStep } from "@/lib/wallet/send";
import { readyToSign, useWallet } from "@/lib/wallet/useWallet";
import { RetryContext, Value, type Cell } from "./cells";
import { ConnectButton } from "./ConnectButton";
import { FeeLine } from "./FeeLine";
import { GetSetUp, type SetupNeed } from "./GetSetUp";
import { MorphoDisclaimer } from "./MorphoDisclaimer";
import { SafeEntry } from "./SafeEntry";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";
import { usdHint, useUsdPrice } from "./usdPrice";

export type BasketItem = { id: string; kind: "found"; bill: BillJson } | { id: string; kind: "none" | "unavailable" };

type Position = readonly [bigint, bigint, bigint];
type MarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
type Choice = "balance" | "bitcoin";

// On Arc the fee comes out of the USDC balance, so a USDC group paid from balance keeps this much back for it.
const USDC_FEE_RESERVE = 10_000n;
// Every stamp lands within half a second of the first, however many bills there are.
const STAMP_WINDOW_MS = 450;

type GroupData = { balance: Cell<bigint>; fresh: Cell<boolean>; needed: Cell<bigint>; position: Cell<Position>; market: Cell<MarketState>; price: Cell<bigint> };
type Group = { currency: Currency; bills: Bill[]; total: bigint };
type Paid = { hash: Hex; count: number; sold: bigint | null; ltv: { symbol: string; value: bigint }[] };

function asideReason(item: BasketItem, bill: Bill | null, me: Address | null): string | null {
  if (item.kind === "none") return "No bill with this number on Arc yet.";
  if (item.kind === "unavailable") return "Arc did not answer for this bill, so it is left out. Reload to try again.";
  if (!bill) return null;
  if (bill.status === BILL_STATUS.Paid) return "Already paid.";
  if (bill.status === BILL_STATUS.Void) return "Cancelled by the supplier. It can never be paid.";
  if (!currencyOf(bill.currency)) return "Not in USDC or EURC.";
  if (me && isAddressEqual(bill.payee, me)) return "You wrote this bill, so you cannot pay it.";
  return null;
}

const statusOf = (s: number): BillStatus => (s === BILL_STATUS.Paid ? "paid" : s === BILL_STATUS.Void ? "void" : "open");

// A basket covers one contract, named by the page from the parsed link (C33). Every read, the batch and the proofs
// use that contract; a bill that claims another is refused when it is decoded.
export function Basket({
  contract: contractRaw,
  items,
  dropped,
  droppedCount = dropped.length,
}: {
  contract: string;
  items: BasketItem[];
  dropped: string[];
  droppedCount?: number;
}) {
  const wallet = useWallet();
  const me = wallet.status === "connected" ? wallet.address : null;
  const ready = readyToSign(wallet);
  const contract = requireDeployment(contractRaw).address;
  const first = deploymentOf(contract)?.label === "first";
  const bills = useMemo(
    () =>
      items.map((it) => {
        if (it.kind !== "found") return null;
        const b = billFromJson(it.bill);
        if (!isAddressEqual(b.contract, contract)) throw new Error("A bill in this basket is on another AdagBills contract.");
        return b;
      }),
    [items, contract],
  );

  const rows = items.map((item, i) => ({ item, bill: bills[i] ?? null, reason: asideReason(item, bills[i] ?? null, me) }));
  const payable = rows.filter((r) => r.reason === null && r.bill).map((r) => r.bill!);
  const aside = rows.filter((r) => r.reason !== null);
  const groups: Group[] = CURRENCIES.map((c) => {
    const inGroup = payable.filter((b) => isAddressEqual(b.currency, c.address));
    return { currency: c, bills: inGroup, total: inGroup.reduce((s, b) => s + b.amount, 0n) };
  }).filter((g) => g.bills.length > 0);

  const [choices, setChoices] = useState<Partial<Record<"USDC" | "EURC", Choice>>>({});
  // Why a group's choice was cleared, shown until the payer chooses again.
  const [cleared, setCleared] = useState<Partial<Record<"USDC" | "EURC", string>>>({});
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [paid, setPaid] = useState<Paid | null>(null);
  const [landed, setLanded] = useState<Set<string>>(new Set());
  const [asking, setAsking] = useState(false);
  // Stable on purpose: the disclaimer resets its checkbox whenever this callback changes, and this page re-renders
  // while the dialog is open (a fee estimate or a balance read landing).
  const closeDisclaimer = useCallback(() => setAsking(false), []);
  const busy = tx.kind === "busy" ? tx : null;
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));

  const data = useQuery({
    queryKey: ["adag-basket", me, groups.map((g) => `${g.currency.symbol}:${g.total}`).join("|")],
    enabled: Boolean(me) && groups.length > 0 && !paid,
    refetchInterval: 30_000,
    queryFn: async () => {
      const client = publicArc();
      const who = me!;
      const contracts = [
        { address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [who] },
        ...groups.flatMap((g) => [
          { address: g.currency.address, abi: erc20Abi, functionName: "balanceOf", args: [who] },
          { address: contract, abi: adagAbi, functionName: "priceStatus", args: [g.currency.marketId] },
          { address: contract, abi: adagAbi, functionName: "collateralNeeded", args: [who, g.currency.marketId, g.total] },
          { address: MORPHO, abi: morphoAbi, functionName: "position", args: [g.currency.marketId, who] },
          { address: MORPHO, abi: morphoAbi, functionName: "market", args: [g.currency.marketId] },
          { address: g.currency.params.oracle, abi: oracleAbi, functionName: "price" },
        ]),
      ];
      return client.multicall({ allowFailure: true, contracts: contracts as never[] }) as Promise<{ status: "success" | "failure"; result?: unknown }[]>;
    },
  });

  function cellAt<T>(i: number, map: (v: unknown) => T = (v) => v as T): Cell<T> {
    if (data.isPending) return { state: "loading" };
    const r = data.data?.[i];
    if (data.isError || !r || r.status !== "success") return { state: "unavailable" };
    return { state: "ok", value: map(r.result) };
  }
  const cirBtc = cellAt<bigint>(0);
  const groupData: GroupData[] = groups.map((_, gi) => {
    const base = 1 + gi * 6;
    return {
      balance: cellAt<bigint>(base),
      fresh: cellAt<boolean>(base + 1, (v) => (v as readonly [boolean, bigint, bigint])[0]),
      needed: cellAt<bigint>(base + 2),
      position: cellAt<Position>(base + 3),
      market: cellAt<MarketState>(base + 4),
      price: cellAt<bigint>(base + 5),
    };
  });

  // C45: what the loan guard is about to pull from this wallet counts as spent. null when it could not be read.
  const pendingQuery = useQuery({
    queryKey: ["adag-guard-pending", me],
    enabled: Boolean(me),
    queryFn: () => pendingGuardOutflow(publicArc(), me!),
    refetchInterval: 30_000,
    staleTime: 15_000,
  });
  const pending: Pending | null | undefined = pendingQuery.data;
  const guardPullOf = (g: Group) => (pending ? (g.currency.symbol === "USDC" ? pending.usdc : pending.eurc) : 0n);
  // C58: the payer's own rule and remaining approval in each market this basket could borrow in.
  const guardQuery = useQuery({
    queryKey: ["adag-basket-guard", me],
    enabled: Boolean(me) && ADAG_GUARD !== null,
    refetchInterval: 30_000,
    queryFn: async () => {
      const client = publicArc();
      return Promise.all(
        CURRENCIES.map(async (c) => {
          const [rule, allowance] = await Promise.all([
            client.readContract({ address: ADAG_GUARD!, abi: guardAbi, functionName: "ruleOf", args: [me!, c.marketId] }),
            client.readContract({ address: c.address, abi: erc20Abi, functionName: "allowance", args: [me!, ADAG_GUARD!] }),
          ]);
          return { symbol: c.symbol, rule: { triggerWad: rule.triggerWad, targetWad: rule.targetWad, expiry: rule.expiry } as GuardRule, allowance };
        }),
      );
    },
  });

  const balanceEnough = (g: Group, d: GroupData) =>
    d.balance.state === "ok" && d.balance.value >= g.total + (isAddressEqual(g.currency.address, USDC) ? USDC_FEE_RESERVE : 0n) + guardPullOf(g);
  const pledgeOf = (d: GroupData) => (d.needed.state === "ok" ? suggestPledge(d.needed.value) : null);

  // The payer's choice is theirs. The app picks a default only for a group that has never had one; a choice that
  // stops being valid is cleared, never swapped for the other path, and the group says why and asks again.
  const loadedKey = data.dataUpdatedAt;
  useEffect(() => {
    if (!loadedKey) return;
    const invalid: Partial<Record<"USDC" | "EURC", string>> = {};
    groups.forEach((g, gi) => {
      const d = groupData[gi]!;
      const current = choices[g.currency.symbol];
      if (current === "bitcoin" && d.fresh.state === "ok" && !d.fresh.value) {
        invalid[g.currency.symbol] = `New loans in ${g.currency.symbol} are paused until the bitcoin price updates, so paying these bills from bitcoin is off. Choose again.`;
      }
      if (current === "balance" && d.balance.state === "ok" && !balanceEnough(g, d)) {
        invalid[g.currency.symbol] = `Your ${g.currency.symbol} balance no longer covers these bills${isAddressEqual(g.currency.address, USDC) ? " plus 0.01 USDC for the fee" : ""}, so paying from balance is off. Choose again.`;
      }
    });
    if (Object.keys(invalid).length) setCleared((prev) => ({ ...prev, ...invalid }));
    setChoices((prev) => {
      const next = { ...prev };
      groups.forEach((g, gi) => {
        const sym = g.currency.symbol;
        if (invalid[sym]) {
          delete next[sym];
          return;
        }
        if (next[sym] || cleared[sym] || invalid[sym]) return;
        const d = groupData[gi]!;
        if (d.fresh.state === "ok" && d.fresh.value) next[sym] = "bitcoin";
        else if (balanceEnough(g, d)) next[sym] = "balance";
      });
      return next;
    });
  }, [loadedKey]);

  const pledgeTotal = groups.reduce((s, g, gi) => (choices[g.currency.symbol] === "bitcoin" ? s + (pledgeOf(groupData[gi]!) ?? 0n) : s), 0n);
  const shortOfBtc = cirBtc.state === "ok" && pledgeTotal > cirBtc.value;
  const allChosen = groups.length > 0 && groups.every((g) => choices[g.currency.symbol]);
  const canPay = ready && allChosen && !shortOfBtc && !busy && payable.length > 0 && pending !== null && pending !== undefined;
  const pendingText = pending ? keptAsideText(pending) : null;

  // C58, per group paid from bitcoin: the loan-to-value after this basket against the payer's own trigger.
  const triggerNotes = groups.flatMap((g, gi) => {
    if (choices[g.currency.symbol] !== "bitcoin") return [];
    const d = groupData[gi]!;
    const pledge = pledgeOf(d);
    const guard = guardQuery.data?.find((x) => x.symbol === g.currency.symbol);
    if (!guard || pledge === null || d.position.state !== "ok" || d.market.state !== "ok" || d.price.state !== "ok" || d.balance.state !== "ok") return [];
    const debt = debtFromShares(d.position.value[1], d.market.value[2], d.market.value[3]) + g.total;
    const after = ltvWad(debt, d.position.value[2] + pledge, d.price.value);
    const repay = guardRepayAfterBorrow({
      rule: guard.rule,
      nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
      ltvAfterWad: after,
      before: { shares: d.position.value[1], collateral: d.position.value[2] },
      totals: { totalBorrowAssets: d.market.value[2], totalBorrowShares: d.market.value[3] },
      borrow: g.total,
      pledge,
      price: d.price.value,
      allowance: guard.allowance,
      balanceAfter: d.balance.value,
    });
    if (!repay) return [];
    return [
      `This payment takes the ${g.currency.symbol} loan to ${formatPercentWad(after)}, at or past your guard's ${formatPercentWad(repay.triggerWad)} trigger. The guard will then repay about ${formatUnitsExact(repay.amount, g.currency.decimals)} ${g.currency.symbol} from this wallet within minutes, back to ${formatPercentWad(repay.targetWad)}.`,
    ];
  });
  const usd = useUsdPrice();
  const refetchReads = data.refetch;
  const retryReads = useCallback(() => void refetchReads(), [refetchReads]);

  // Why the one button cannot be pressed yet, in words.
  const unchosen = groups.find((g) => !choices[g.currency.symbol]);
  const payBlocked: string | null = busy
    ? null
    : !me
      ? "Connect a wallet first."
      : !ready
        ? "Switch your wallet to Arc, or use an ordinary wallet, to pay."
        : data.isPending
          ? "Reading your balances and the prices on Arc."
          : unchosen
            ? `Choose how to pay the ${unchosen.currency.symbol} bills.`
            : shortOfBtc
              ? "This basket pledges more cirBTC than your wallet holds. Pay a group from balance instead."
              : null;
  const setupNeeds: SetupNeed[] = [];
  if (shortOfBtc || groups.some((g, gi) => !balanceEnough(g, groupData[gi]!) && groupData[gi]!.balance.state === "ok" && pledgeOf(groupData[gi]!) !== null && cirBtc.state === "ok" && cirBtc.value < (pledgeOf(groupData[gi]!) ?? 0n)))
    setupNeeds.push("cirbtc");
  if (groups.some((g, gi) => isAddressEqual(g.currency.address, USDC) && groupData[gi]!.balance.state === "ok" && !balanceEnough(g, groupData[gi]!))) setupNeeds.push("usdc");

  // The fee for exactly the batch the button would build, recomputed whenever a group's choice or pledge changes.
  // The fixed params stand in here; the real payment re-reads Morpho's and proves them by hash.
  const planKey = groups.map((g, gi) => `${g.currency.symbol}:${choices[g.currency.symbol] ?? "-"}:${pledgeOf(groupData[gi]!) ?? "?"}`).join("|");
  const feeQuery = useQuery({
    queryKey: ["adag-basket-fee", contract, me, payable.map((b) => b.id.toString()).join(","), planKey],
    enabled: Boolean(me) && ready && allChosen && !shortOfBtc && !paid,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      const plan: BasketPlan = {};
      groups.forEach((g, gi) => {
        const choice = choices[g.currency.symbol];
        if (choice === "balance") plan[g.currency.symbol] = { from: "balance" };
        else if (choice === "bitcoin") plan[g.currency.symbol] = { from: "bitcoin", pledge: pledgeOf(groupData[gi]!) ?? 0n, marketParams: g.currency.params };
      });
      const built = buildPayMany(payable, me!, plan);
      return estimateFee({ account: me!, to: built.to, data: built.data });
    },
  });

  const fail = (message: string, hash?: Hex) => setTx({ kind: "failed", message, href: hash && `${EXPLORER}/tx/${hash}` });

  const pay = async () => {
    if (!me) return;
    step("checking");
    const client = publicArc();
    const ids = payable.map((b) => b.id);
    let fresh: Bill[];
    try {
      // Read every bill again at the moment of paying. A bill that changed is named; none is ever dropped quietly.
      const records = await Promise.all(ids.map((id) => client.readContract({ address: contract, abi: adagAbi, functionName: "bill", args: [id] })));
      const changed = records.map((r, i) => ({ r, b: payable[i]! })).filter(({ r, b }) => r.status !== b.status || r.amount !== b.amount || !isAddressEqual(r.payee, b.payee) || !isAddressEqual(r.currency, b.currency) || r.ref !== b.ref);
      if (changed.length) {
        const words = changed.map(({ r, b }) => `#${b.id} is now ${r.status === BILL_STATUS.Paid ? "paid" : r.status === BILL_STATUS.Void ? "cancelled" : "different"}`).join(", ");
        return fail(`Since this page loaded, bill ${words}. Nothing was sent. Reload the basket to pay the rest.`);
      }
      fresh = records.map((r, i) => ({ ...payable[i]!, status: r.status, amount: r.amount, payee: r.payee, currency: r.currency, ref: r.ref }));
    } catch {
      return fail("Arc did not answer, so nothing was built. Try again.");
    }

    // C45, read again at the moment of paying.
    const pendingNow = await pendingGuardOutflow(client, me);
    if (!pendingNow) return fail(GUARD_UNREADABLE);
    const plan: BasketPlan = {};
    let held: bigint;
    try {
      held = await client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [me] });
      let pledged = 0n;
      for (const g of groups) {
        const m = g.currency.marketId;
        if (choices[g.currency.symbol] === "balance") {
          const bal = await client.readContract({ address: g.currency.address, abi: erc20Abi, functionName: "balanceOf", args: [me] });
          const guardPull = g.currency.symbol === "USDC" ? pendingNow.usdc : pendingNow.eurc;
          const need = g.total + (isAddressEqual(g.currency.address, USDC) ? USDC_FEE_RESERVE : 0n) + guardPull;
          if (bal < need) {
            const why = guardPull > 0n ? `, including ${formatUnitsExact(guardPull, g.currency.decimals)} your loan guard is about to repay` : "";
            return fail(`Paying the ${g.currency.symbol} bills from balance needs ${formatUnitsExact(need, g.currency.decimals)} ${g.currency.symbol}${why}; your wallet holds ${formatUnitsExact(bal, g.currency.decimals)}. Nothing was sent.`);
          }
          plan[g.currency.symbol] = { from: "balance" };
          continue;
        }
        const [status, needed, tuple] = await Promise.all([
          client.readContract({ address: contract, abi: adagAbi, functionName: "priceStatus", args: [m] }),
          client.readContract({ address: contract, abi: adagAbi, functionName: "collateralNeeded", args: [me, m, g.total] }),
          client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m] }),
        ]);
        // C24: the bitcoin path needs a fresh price at the moment of paying, not only when the page loaded.
        if (!status[0]) return fail(`New loans in ${g.currency.symbol} are paused until the bitcoin price updates. Pay those bills from balance, or wait. Nothing was sent.`);
        const pledge = suggestPledge(needed);
        pledged += pledge;
        plan[g.currency.symbol] = { from: "bitcoin", pledge, marketParams: paramsFromTuple(tuple) };
      }
      if (pledged > held) return fail(`This basket pledges ${formatUnitsExact(pledged, CIRBTC_DECIMALS)} cirBTC and your wallet holds ${formatUnitsExact(held, CIRBTC_DECIMALS)}. Nothing was sent.`);
    } catch {
      return fail("Arc did not answer, so nothing was built. Try again.");
    }

    let built;
    try {
      built = buildPayMany(fresh, me, plan);
    } catch (error) {
      return fail(`${(error as Error).message} Nothing was sent.`);
    }

    const pledgedNow = async () => {
      const [w, pu, pe] = await Promise.all([
        client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [me] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_USDC, me] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_EURC, me] }),
      ]);
      return w + pu[2] + pe[2];
    };
    const btcBefore = await pledgedNow().catch(() => null);

    const usdcOut = groups.reduce((s, g) => (choices[g.currency.symbol] === "balance" && isAddressEqual(g.currency.address, USDC) ? s + g.total : s), pendingNow.usdc);
    const out = await simulateAndSend({ account: me, to: built.to, data: built.data, onStep: step, usdcOut });
    let logs: Parameters<typeof billsPaidIn>[0] | null;
    let hash: Hex;
    if (out.ok) {
      logs = out.receipt.logs;
      hash = out.hash;
    } else if (out.stage === "unconfirmed") {
      // No receipt in time: the bills' own records say what happened, so nobody pays twice.
      step("watching");
      if (!(await watchBills(contract, ids, BILL_STATUS.Paid, me))) {
        return fail("Arc has not confirmed it after two minutes. Do not pay again: check the transaction first.", out.hash);
      }
      logs = null;
      hash = out.hash;
    } else {
      return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
    }

    // C16, C53: every bill is proven by its own BillPaid from the basket's contract and its record read again there;
    // without a receipt, by the record alone, which must name this payer.
    const proofs = logs ? billsPaidIn(logs, contract, ids) : null;
    const after = await Promise.all(ids.map((id) => client.readContract({ address: contract, abi: adagAbi, functionName: "bill", args: [id] }))).catch(() => null);
    const missing = ids.filter((id, i) => (proofs !== null && !proofs.get(id)) || !after || after[i]!.status !== BILL_STATUS.Paid || !isAddressEqual(after[i]!.payer, me));
    if (missing.length) return fail(`Arc confirmed the transaction, but bill #${missing.join(", #")} does not read as paid by you. Check the transaction.`, hash);

    const btcAfter = await pledgedNow().catch(() => null);
    const ltv = await Promise.all(
      CURRENCIES.map(async (c) => ({ symbol: c.symbol, value: await client.readContract({ address: contract, abi: adagAbi, functionName: "loanToValue", args: [me, c.marketId] }) })),
    ).catch(() => []);
    setPaid({ hash, count: ids.length, sold: btcBefore !== null && btcAfter !== null ? btcBefore - btcAfter : null, ltv: ltv.filter((l) => l.value > 0n) });
    setTx({ kind: "idle" });
    // The signature moment: every stamp lands, staggered inside half a second.
    const gap = ids.length > 1 ? Math.min(150, STAMP_WINDOW_MS / (ids.length - 1)) : 0;
    ids.forEach((id, i) => window.setTimeout(() => setLanded((s) => new Set(s).add(id.toString())), 250 + i * gap));
  };

  const onPay = () => {
    setTx({ kind: "idle" });
    const usesBitcoin = groups.some((g) => choices[g.currency.symbol] === "bitcoin");
    if (usesBitcoin && me && !hasAcceptedMorphoDisclaimer(me)) return setAsking(true);
    void pay();
  };

  const n = payable.length;
  return (
    <section className="relative px-5 pt-12 pb-24 md:px-[6vw] md:pt-[9vh]">
      <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
        <Hallmark>
          Basket · {items.length} bills{aside.length > 0 ? ` · ${payable.length} payable` : ""}
          {first ? " · First deployment" : ""}
          <span className="hidden md:inline"> · Arc mainnet</span>
        </Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[14ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
        {n === 0 ? (
          "Nothing to pay."
        ) : (
          <>
            {n > 1 ? `${n} bills.` : "One bill."} <em className="font-semibold text-gold italic">One</em> signature.
          </>
        )}
      </h1>
      {droppedCount > 0 && (
        // L3: a link's text reaches this page only as a short sample and a count, never as sentences.
        <p className="type-body app-rise mt-6 text-muted" style={{ "--d": 2 } as React.CSSProperties} data-dropped>
          Left out because {droppedCount === 1 ? "it is not a bill number" : "they are not bill numbers"}: {dropped.join(", ")}
          {droppedCount > dropped.length ? ` and ${droppedCount - dropped.length} more` : ""}.
        </p>
      )}

      <div className="mt-12 grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {payable.map((b, i) => (
          <BillCard key={b.id.toString()} bill={b} index={i} landed={landed.has(b.id.toString())} />
        ))}
      </div>

      {aside.length > 0 && (
        <div className="mt-12" data-aside>
          <p className="type-label text-muted">Not in this payment</p>
          <ul className="mt-4 border-t border-rule">
            {aside.map(({ item, bill, reason }) => (
              <li key={item.id} className="grid grid-cols-[5rem_1fr] items-center gap-4 border-b border-rule py-4 md:grid-cols-[5rem_12rem_1fr_auto]" data-aside-bill={item.id}>
                <a href={billHref(contract, BigInt(item.id))} className="font-display text-[1.5rem] leading-none text-text transition-colors duration-200 hover:text-gold">
                  No. {item.id}
                </a>
                <span className="type-ui tabular-nums text-muted">{bill ? money(bill) : "unknown"}</span>
                <span className="type-body col-span-2 text-text md:col-span-1" data-reason>
                  {reason}
                </span>
                {bill && (
                  <span className="app-stamp-sm hidden md:block">
                    <BillStamp status={statusOf(bill.status)} tilt={-4} />
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {n === 0 && !paid && (
        <div className="mt-10 flex flex-col gap-3 md:flex-row" data-next-steps>
          <Button href="/pay" variant="primary" className="w-full md:w-auto">
            Pay a bill
          </Button>
          <Button href="/bill/new" variant="secondary" className="w-full md:w-auto">
            Write a bill
          </Button>
        </div>
      )}

      {n > 0 && !paid && (
        <div className="mt-14 grid gap-8 lg:grid-cols-12">
          <div className="lg:col-span-8">
            {!me ? (
              <div className="app-panel p-6 md:p-8" data-blocked="true">
                <div className="flex flex-col gap-5 md:flex-row md:items-center md:justify-between">
                  <p className="type-lead max-w-[30rem] text-text">Connect a wallet to see how each currency can be paid.</p>
                  <ConnectButton />
                </div>
                <GetSetUp needs={["arc", "cirbtc", "usdc"]} className="mt-6" />
              </div>
            ) : (
              <RetryContext.Provider value={retryReads}>
              <div className="grid gap-5">
                {groups.map((g, gi) => (
                  <GroupPanel
                    key={g.currency.symbol}
                    group={g}
                    data={groupData[gi]!}
                    cirBtc={cirBtc}
                    choice={choices[g.currency.symbol]}
                    balanceOk={balanceEnough(g, groupData[gi]!)}
                    disabled={Boolean(busy)}
                    notice={choices[g.currency.symbol] ? null : (cleared[g.currency.symbol] ?? null)}
                    onChoose={(c) => {
                      setChoices((prev) => ({ ...prev, [g.currency.symbol]: c }));
                      setCleared((prev) => {
                        const next = { ...prev };
                        delete next[g.currency.symbol];
                        return next;
                      });
                    }}
                    usd={usd}
                  />
                ))}
                {setupNeeds.length > 0 && <GetSetUp needs={setupNeeds} />}
              </div>
              </RetryContext.Provider>
            )}
          </div>
          <div className="lg:col-span-4">
            <div className="app-panel p-6 md:p-8 lg:sticky lg:top-28">
              <p className="type-label text-muted">One transaction</p>
              <p className="type-body mt-3 text-text">
                {groups.map((g) => `${formatUnitsExact(g.total, g.currency.decimals)} ${g.currency.symbol}`).join(" and ")} across {n} bill{n === 1 ? "" : "s"}. Every
                step succeeds together or nothing moves.
              </p>
              <FeeLine query={feeQuery} idle="The network fee shows once each currency has a choice." className="mt-3" />
              {triggerNotes.map((t) => (
                <p key={t} className="type-body mt-4 text-text" data-guard-trigger>
                  {t}
                </p>
              ))}
              <Button variant="primary" disabled={!canPay} onClick={onPay} className="mt-6 w-full" data-action="pay-basket">
                {busy ? <BusyLabel step={busy.step} since={busy.since} /> : `Pay ${n} bill${n === 1 ? "" : "s"} with one signature`}
              </Button>
              {payBlocked && (
                <p className={`type-body mt-3 ${shortOfBtc ? "text-danger" : "text-muted"}`} data-blocked-reason>
                  {payBlocked}
                </p>
              )}
              {pendingText && (
                <p className="type-body mt-3 text-muted" data-guard-pending>
                  {pendingText}
                </p>
              )}
              {pending === null && (
                <p className="type-body mt-3 text-danger" data-guard-unreadable>
                  {GUARD_UNREADABLE}
                </p>
              )}
              <div className="mt-4">
                <TxMessage state={tx} />
              </div>
            </div>
          </div>
        </div>
      )}

      {me && <SafeEntry bills={payable} available={n > 0 && !paid && !busy} className="mt-8" />}

      {paid && (
        <motion.div
          data-tx-result="basket-paid"
          initial={{ opacity: 0, y: 24 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, delay: 0.7, ease: [0.16, 1, 0.3, 1] }}
          className="app-panel mt-14 p-6 md:p-10"
        >
          <p className="type-label text-success">Confirmed on Arc</p>
          <p className="mt-4 font-display text-[clamp(2.5rem,6vw,5rem)] leading-[0.95] font-semibold tracking-[-0.02em] text-text">
            {paid.count} bills paid. <em className="text-gold italic">1</em> signature.
          </p>
          <dl className="mt-8 grid gap-x-10 gap-y-5 border-t border-rule pt-6 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <dt className="type-micro text-muted">Transaction</dt>
              <dd className="mt-1">
                <a href={`${EXPLORER}/tx/${paid.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address text-text hover:text-gold">
                  {shortAddress(paid.hash)} on the explorer
                </a>
              </dd>
            </div>
            <div>
              <dt className="type-micro text-muted">Bitcoin sold</dt>
              <dd className="type-body mt-1 text-text" data-sold>
                {paid.sold === null ? "unavailable" : `${paid.sold === 0n ? "0" : formatUnitsExact(paid.sold, CIRBTC_DECIMALS)} cirBTC`}
              </dd>
            </div>
            {paid.ltv.map((l) => (
              <div key={l.symbol}>
                <dt className="type-micro text-muted">{l.symbol} loan-to-value after</dt>
                <dd className="type-body mt-1 tabular-nums text-text" data-ltv-after={l.symbol}>
                  {formatPercentWad(l.value)} <span className="text-muted">of Adag&apos;s {formatPercentWad(MAX_LTV_WAD)}</span>
                </dd>
              </div>
            ))}
          </dl>
        </motion.div>
      )}

      <MorphoDisclaimer
        open={asking}
        onCancel={closeDisclaimer}
        onAccept={() => {
          if (me) rememberMorphoDisclaimer(me);
          setAsking(false);
          void pay();
        }}
      />
    </section>
  );
}

function money(b: Bill) {
  const c = currencyOf(b.currency);
  return c ? `${formatUnitsExact(b.amount, c.decimals)} ${c.symbol}` : b.amount.toString();
}

// Payee and amount come from bill(id), the record pay() uses (C15); the reference is text only (C14).
function BillCard({ bill, index, landed }: { bill: Bill; index: number; landed: boolean }) {
  const c = currencyOf(bill.currency);
  const reference = referenceText(bill.ref);
  return (
    <motion.article
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.7, delay: 0.15 + index * 0.08, ease: [0.16, 1, 0.3, 1] }}
      className="app-panel app-stamp relative p-6"
      data-basket-bill={bill.id.toString()}
      data-landed={landed ? "paid" : "open"}
    >
      <div className="flex items-start justify-between gap-4">
        <p className="font-display text-[2.25rem] leading-none font-semibold tracking-[-0.02em] text-text">No. {bill.id.toString()}</p>
        <div className="-mt-1">
          {landed ? <BillStamp key="paid" status="paid" entrance="in-view" tilt={-9} /> : <BillStamp key="open" status="open" tilt={-6} />}
        </div>
      </div>
      <p className="mt-6 font-display text-[clamp(2.25rem,4vw,3rem)] leading-none font-semibold tabular-nums text-text">
        {c ? formatUnitsExact(bill.amount, c.decimals) : bill.amount.toString()}
        <span className="app-amount-unit">{c?.symbol}</span>
      </p>
      <dl className="mt-6 space-y-3 border-t border-rule pt-4">
        <div>
          <dt className="type-micro text-muted">Pays</dt>
          <dd className="type-address mt-1 break-all text-text">{fullAddress(bill.payee)}</dd>
        </div>
        <div>
          <dt className="type-micro text-muted">Reference</dt>
          <dd className="type-body mt-1 text-text">{reference ? <span className="app-reference">{reference}</span> : <span className="text-muted">None</span>}</dd>
        </div>
      </dl>
    </motion.article>
  );
}

type GroupPanelProps = {
  group: Group;
  data: GroupData;
  cirBtc: Cell<bigint>;
  choice: Choice | undefined;
  balanceOk: boolean;
  disabled: boolean;
  notice: string | null;
  onChoose: (c: Choice) => void;
  usd: bigint | null;
};

function GroupPanel({ group, data, cirBtc, choice, balanceOk, disabled, notice, onChoose, usd }: GroupPanelProps) {
  const { currency, total, bills } = group;
  const fresh = data.fresh.state === "ok" ? data.fresh.value : null;
  const pledge: Cell<bigint> = data.needed.state === "ok" ? { state: "ok", value: suggestPledge(data.needed.value) } : data.needed;
  let after: Cell<{ ltv: bigint; drop: bigint }> = { state: "loading" };
  if (pledge.state === "ok" && data.position.state === "ok" && data.market.state === "ok" && data.price.state === "ok") {
    const debt = debtFromShares(data.position.value[1], data.market.value[2], data.market.value[3]) + total;
    const ltv = ltvWad(debt, data.position.value[2] + pledge.value, data.price.value);
    after = { state: "ok", value: { ltv, drop: liquidationDropWad(ltv, currency.params.lltv) } };
  } else if ([pledge, data.position, data.market, data.price].some((c) => c.state === "unavailable")) {
    after = { state: "unavailable" };
  }
  const isUsdc = isAddressEqual(currency.address, USDC);

  const option = (c: Choice, title: string, enabled: boolean, body: React.ReactNode) => (
    <button
      type="button"
      role="radio"
      aria-checked={choice === c}
      disabled={!enabled || disabled}
      onClick={() => onChoose(c)}
      data-choice={`${currency.symbol}-${c}`}
      className={`flex h-full flex-col rounded-[8px] border p-5 text-left transition-colors duration-200 disabled:cursor-not-allowed disabled:opacity-45 ${
        choice === c ? "border-gold bg-raised" : "border-rule hover:border-rule-strong"
      }`}
    >
      <span className="flex items-center justify-between gap-3">
        <span className="type-ui text-text">{title}</span>
        <span aria-hidden="true" className={`h-3 w-3 rounded-full border ${choice === c ? "border-gold bg-gold" : "border-rule-strong"}`} />
      </span>
      {/* No "Try again" button inside this button: a button may not hold another. The panel's own retry sits below. */}
      <RetryContext.Provider value={null}>
        <span className="type-body mt-3 block text-muted">{body}</span>
      </RetryContext.Provider>
    </button>
  );

  return (
    <div className="app-panel p-6 md:p-8" data-group={currency.symbol}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="type-label text-text">
          {bills.length} {currency.symbol} bill{bills.length === 1 ? "" : "s"}
        </p>
        <p className="font-display text-[1.75rem] leading-none font-medium tabular-nums text-text">
          {formatUnitsExact(total, currency.decimals)} <span className="text-[0.6em] italic text-gold">{currency.symbol}</span>
        </p>
      </div>
      {notice && (
        <p role="status" className="type-body mt-4 flex items-start gap-3 text-danger" data-cleared={currency.symbol}>
          <span aria-hidden="true" className="diamond mt-[0.55em] !bg-danger" />
          {notice}
        </p>
      )}
      <div role="radiogroup" aria-label={`Pay the ${currency.symbol} bills from`} className="mt-6 grid gap-4 md:grid-cols-2">
        {option(
          "bitcoin",
          "From bitcoin",
          fresh === true,
          fresh === false ? (
            "New loans are paused until the bitcoin price updates."
          ) : (
            <>
              You pledge{" "}
              <Value cell={pledge} render={(v) => (v === 0n ? "no more cirBTC" : `${formatUnitsExact(v, CIRBTC_DECIMALS)} cirBTC${usdHint(v, usd)}`)} className="text-text" /> and keep
              it. Bitcoin can fall <Value cell={after} render={(v) => formatPercentWad(v.drop)} className="text-text" /> before Morpho may liquidate.
            </>
          ),
        )}
        {option(
          "balance",
          "From balance",
          balanceOk,
          <>
            You hold <Value cell={data.balance} render={(v) => `${formatUnitsExact(v, currency.decimals)} ${currency.symbol}`} className="text-text" />.{" "}
            {balanceOk ? "One exact approval, then each bill is paid." : isUsdc ? "Not enough for these bills and the network fee." : "Not enough for these bills."}
          </>,
        )}
      </div>
      {fresh !== false && (
        <details className="group mt-4">
          <summary className="type-micro cursor-pointer list-none text-muted transition-colors duration-200 hover:text-text">Details</summary>
          <p className="type-body mt-2 text-muted">
            Loan-to-value after: <Value cell={after} render={(v) => formatPercentWad(v.ltv)} className="text-text" /> (Adag refuses anything over 40%). cirBTC in your wallet:{" "}
            <Value cell={cirBtc} render={(v) => `${formatUnitsExact(v, CIRBTC_DECIMALS)}${usdHint(v, usd)}`} className="text-text" />. The pledge includes 5% for price moves.
          </p>
        </details>
      )}
    </div>
  );
}
