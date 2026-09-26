"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { hexToBigInt, isAddressEqual, sliceHex, type Address, type Hex, type PublicClient } from "viem";
import { getConnection, signTypedData } from "wagmi/actions";
import { BillStamp } from "@/components/BillStamp";
import { Button } from "@/components/Button";
import { adagAbi, erc20Abi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { SAFE_CURRENT_ONLY, buildSafeBatch, buildSafeEnrol, suggestPledge, type BasketPlan, type Bill, type SafeBatch } from "@/lib/pay/build";
import { blockers, type MarketInput } from "@/lib/pay/enrol";
import { GUARD_RULE_UNREADABLE, GUARD_UNREADABLE, guardRepayAfterBorrow, keptAsideText, readOwnGuard, triggerSentence, type GuardRule } from "@/lib/pay/guardView";
import { debtFromShares, ltvWad } from "@/lib/pay/loan";
import { pendingGuardOutflow } from "@/lib/guard/outflow";
import { ADAG_BILLS, BILL_STATUS, CIRBTC, CIRBTC_DECIMALS, CURRENCIES, EXPLORER, MORPHO, type Currency } from "@/lib/pay/constants";
import { decodeAdagError } from "@/lib/pay/errors";
import { formatPercentWad, formatUnitsExact, shortAddress } from "@/lib/pay/format";
import { paramsFromTuple } from "@/lib/pay/market";
import { SAFE_APP_URL } from "@/lib/safe/constants";
import { assertSafeTxShape } from "@/lib/safe/multisend";
import { safeTxFor, safeTxToJson, safeTxTypedData } from "@/lib/safe/typedData";
import { checkedSafeTxHash, simulateFromSafe, verifySafe, type SafeInfo } from "@/lib/safe/verify";
import { wagmiConfig } from "@/lib/wallet/config";
import { hasAcceptedMorphoDisclaimer, rememberMorphoDisclaimer } from "@/lib/wallet/consent";
import { publicArc } from "@/lib/wallet/send";
import { readyToSign, useWallet } from "@/lib/wallet/useWallet";
import { MorphoDisclaimer } from "./MorphoDisclaimer";
import { forgetProposal, recallProposal, rememberProposal } from "./safeMemory";
import { useSafeList } from "./safeList";
import { useElapsed } from "./TxProgress";
import { usdHint, useUsdPrice } from "./usdPrice";

type Choice = "balance" | "bitcoin";
type Group = { currency: Currency; total: bigint };
type Step = "idle" | "checking" | "simulating" | "signing" | "proposing";
// The bills are kept as proposed: the page around this may drop them from its own list once they are paid.
type Proposed = { safe: Address; safeTxHash: Hex; threshold: number; bills: Bill[]; restored: boolean };

const LABEL: Record<Step, string> = {
  idle: "",
  checking: "Checking the Safe and the bills on Arc",
  simulating: "Running the payment as the Safe would, on live state",
  signing: "Sign in your wallet",
  proposing: "Sending the proposal to your Safe's queue",
};

const client = () => publicArc() as PublicClient;

type LoanNow = { live: { shares: bigint; collateral: bigint }; totalBorrowAssets: bigint; totalBorrowShares: bigint; price: bigint };

// C58 for a Safe paying from its bitcoin: its own rule against the loan this payment would leave, as a sentence, or
// null when it stays under the trigger.
function safeTrip(g: Group, loan: LoanNow, guard: { rule: GuardRule; allowance: bigint }, pledge: bigint, balance: bigint): string | null {
  const ltvAfterWad = ltvWad(debtFromShares(loan.live.shares, loan.totalBorrowAssets, loan.totalBorrowShares) + g.total, loan.live.collateral + pledge, loan.price);
  const repay = guardRepayAfterBorrow({
    rule: guard.rule,
    nowSeconds: BigInt(Math.floor(Date.now() / 1000)),
    ltvAfterWad,
    before: loan.live,
    totals: { totalBorrowAssets: loan.totalBorrowAssets, totalBorrowShares: loan.totalBorrowShares },
    borrow: g.total,
    pledge,
    price: loan.price,
    allowance: guard.allowance,
    balanceAfter: balance,
  });
  return repay ? triggerSentence({ ltvAfterWad, amount: repay.amount, triggerWad: repay.triggerWad, targetWad: repay.targetWad, symbol: g.currency.symbol, who: "the Safe" }) : null;
}

// Safes sign with v = 27 or 28. A few wallets answer 0 or 1; the signature is the same, only the last byte differs.
function normaliseV(signature: Hex): Hex {
  const v = Number(hexToBigInt(sliceHex(signature, 64, 65)));
  if (v === 0 || v === 1) return `${signature.slice(0, 130)}${(v + 27).toString(16)}` as Hex;
  return signature;
}

export function SafePay({ bills, onProposed }: { bills: Bill[]; onProposed?: () => void }) {
  const router = useRouter();
  const refresh = useCallback(() => router.refresh(), [router]);
  const wallet = useWallet();
  const owner = wallet.status === "connected" ? wallet.address : null;
  const ready = readyToSign(wallet);
  const usd = useUsdPrice();
  const fieldId = useId();

  const [pasted, setPasted] = useState("");
  const [info, setInfo] = useState<SafeInfo | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [step, setStep] = useState<Step>("idle");
  const [since, setSince] = useState<number | null>(null);
  const [choices, setChoices] = useState<Partial<Record<"USDC" | "EURC", Choice>>>({});
  const [proposed, setProposed] = useState<Proposed | null>(null);
  const [enrolProposed, setEnrolProposed] = useState<{ safeTxHash: Hex; threshold: number } | null>(null);
  const [safeCaught, setSafeCaught] = useState<string[]>([]);

  // F5: a proposal this browser made for these same bills comes back on load, instead of an offer to propose again.
  useEffect(() => {
    if (bills.length === 0) return;
    const remembered = recallProposal(bills[0]!.contract, bills.map((b) => b.id));
    if (remembered) {
      setProposed({ ...remembered, bills, restored: true });
      onProposed?.();
    }
    // Only on first load: a proposal made on this page is already in state.
  }, []);
  const [asking, setAsking] = useState(false);
  const closeDisclaimer = useCallback(() => setAsking(false), []);
  const seconds = useElapsed(since);
  const go = (s: Step) => {
    setStep(s);
    setSince(s === "idle" ? null : Date.now());
  };

  const groups: Group[] = CURRENCIES.map((c) => ({
    currency: c,
    total: bills.filter((b) => isAddressEqual(b.currency, c.address)).reduce((s, b) => s + b.amount, 0n),
  })).filter((g) => g.total > 0n);

  const list = useSafeList(owner);

  // What the Safe itself holds and owes, read from Arc. The Safe is the account everywhere (C55).
  const reads = useQuery({
    queryKey: ["adag-safe-reads", info?.address, groups.map((g) => `${g.currency.symbol}:${g.total}`).join("|")],
    enabled: Boolean(info) && !proposed,
    refetchInterval: enrolProposed ? 6_000 : 30_000,
    queryFn: async () => {
      const safe = info!.address;
      const c = client();
      const cirBtc = await c.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
      // C45 for the Safe: its own guard rules pull from the Safe. C55: the Safe's own loans, as the contract saw them.
      const pending = await pendingGuardOutflow(c, safe);
      const loans = await Promise.all(
        CURRENCIES.map(async (cur) => {
          const [live, seenPos, mkt, price, status] = await Promise.all([
            c.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [cur.marketId, safe] }),
            c.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "seenPosition", args: [safe, cur.marketId] }),
            c.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [cur.marketId] }),
            c.readContract({ address: cur.params.oracle, abi: oracleAbi, functionName: "price" }),
            c.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [cur.marketId] }),
          ]);
          return {
            market: cur.marketId,
            symbol: cur.symbol,
            live: { shares: live[1], collateral: live[2] },
            seen: { shares: seenPos[0], collateral: seenPos[1] },
            totalBorrowAssets: mkt[2],
            totalBorrowShares: mkt[3],
            price,
            fresh: status[0],
          } satisfies MarketInput;
        }),
      );
      const per = await Promise.all(
        groups.map(async (g) => {
          const [balance, status, needed, guard] = await Promise.all([
            c.readContract({ address: g.currency.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
            c.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [g.currency.marketId] }),
            c.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "collateralNeeded", args: [safe, g.currency.marketId, g.total] }),
            readOwnGuard(c, safe, g.currency.marketId, g.currency.address),
          ]);
          const pull = pending ? (g.currency.symbol === "USDC" ? pending.usdc : pending.eurc) : 0n;
          const pledge = suggestPledge(needed);
          const loan = loans.find((l) => l.market === g.currency.marketId)!;
          // C58 for the Safe as the owner: its own rule against the loan as this payment would leave it.
          const trip = guard.state === "ok" ? safeTrip(g, loan, guard, pledge, balance) : null;
          return { symbol: g.currency.symbol, balance, fresh: status[0], pledge, pull, guard, trip };
        }),
      );
      return { cirBtc, per, pending, loans };
    },
  });

  // Once the Safe's owners have executed the recording, the contract's seenPosition matches and the payment opens.
  useEffect(() => {
    if (enrolProposed && reads.data && blockers({ markets: reads.data.loans, borrowsIn: null }).length === 0) setEnrolProposed(null);
  }, [enrolProposed, reads.data]);

  // A first choice per currency, only while none is set: bitcoin when the price is fresh and the Safe holds the pledge.
  useEffect(() => {
    if (!reads.data) return;
    setChoices((prev) => {
      const next = { ...prev };
      for (const p of reads.data.per) {
        const sym = p.symbol;
        if (next[sym]) continue;
        const g = groups.find((x) => x.currency.symbol === sym)!;
        if (p.fresh && reads.data.cirBtc >= p.pledge) next[sym] = "bitcoin";
        else if (p.balance >= g.total + p.pull) next[sym] = "balance";
      }
      return next;
    });
  }, [reads.dataUpdatedAt]);

  const check = async (address: string) => {
    setProblem(null);
    setInfo(null);
    setChoices({});
    if (!owner || !ready) return setProblem("Connect an ordinary wallet that owns the Safe, on Arc.");
    go("checking");
    try {
      setInfo(await verifySafe(client(), address, owner));
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      go("idle");
    }
  };

  const propose = async () => {
    if (!info || !owner) return;
    setProblem(null);
    const c = client();
    const safe = info.address;
    try {
      go("checking");
      // Read everything again now: the bills, the prices and the Safe itself (C52: owner, version and nonce from the contract).
      const fresh = await verifySafe(c, safe, owner);
      if (bills.some((b) => !isAddressEqual(b.contract, ADAG_BILLS))) throw new Error(SAFE_CURRENT_ONLY);
      const records = await Promise.all(bills.map((b) => c.readContract({ address: b.contract, abi: adagAbi, functionName: "bill", args: [b.id] })));
      const changed = records.map((r, i) => ({ r, b: bills[i]! })).filter(({ r, b }) => r.status !== BILL_STATUS.Open || r.amount !== b.amount || !isAddressEqual(r.payee, b.payee));
      if (changed.length) throw new Error(`Bill #${changed.map((x) => x.b.id).join(", #")} changed since this page loaded. Nothing was signed. Reload to pay the rest.`);
      const plan: BasketPlan = {};
      for (const g of groups) {
        const choice = choices[g.currency.symbol];
        if (!choice) throw new Error(`Choose how the Safe pays the ${g.currency.symbol} bills.`);
        if (choice === "balance") {
          plan[g.currency.symbol] = { from: "balance" };
          continue;
        }
        const [status, needed, tuple] = await Promise.all([
          c.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [g.currency.marketId] }),
          c.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "collateralNeeded", args: [safe, g.currency.marketId, g.total] }),
          c.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [g.currency.marketId] }),
        ]);
        if (!status[0]) throw new Error(`New loans in ${g.currency.symbol} are paused until the bitcoin price updates. Choose the Safe's balance, or wait.`);
        plan[g.currency.symbol] = { from: "bitcoin", pledge: suggestPledge(needed), marketParams: paramsFromTuple(tuple) };
      }
      // C45: the Safe's own guard rules pull from the Safe, so that much is kept aside; a failed read stops here.
      const pendingNow = await pendingGuardOutflow(c, safe);
      if (!pendingNow) throw new Error(GUARD_UNREADABLE);
      for (const g of groups) {
        if (choices[g.currency.symbol] !== "balance") continue;
        const pull = g.currency.symbol === "USDC" ? pendingNow.usdc : pendingNow.eurc;
        const held = await c.readContract({ address: g.currency.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] });
        if (held < g.total + pull) {
          throw new Error(
            `The Safe holds ${formatUnitsExact(held, g.currency.decimals)} ${g.currency.symbol} and needs ${formatUnitsExact(g.total + pull, g.currency.decimals)}${pull > 0n ? `, including ${formatUnitsExact(pull, g.currency.decimals)} its loan guard is about to repay` : ""}. Nothing was signed.`,
          );
        }
      }
      // C58 for the Safe (C55), read again before proposing: its own rule and approval against the loan as it will
      // stand. A trip the page had not shown stops here and is shown instead.
      const newTrips: string[] = [];
      for (const g of groups) {
        const p = plan[g.currency.symbol];
        if (!p || p.from !== "bitcoin") continue;
        const guard = await readOwnGuard(c, safe, g.currency.marketId, g.currency.address);
        if (guard.state !== "ok") throw new Error(GUARD_RULE_UNREADABLE.replace("your loan guard", "the Safe's loan guard"));
        const [pos, mk, px, held] = await Promise.all([
          c.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [g.currency.marketId, safe] }),
          c.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [g.currency.marketId] }),
          c.readContract({ address: g.currency.params.oracle, abi: oracleAbi, functionName: "price" }),
          c.readContract({ address: g.currency.address, abi: erc20Abi, functionName: "balanceOf", args: [safe] }),
        ]);
        const loan = { live: { shares: pos[1], collateral: pos[2] }, totalBorrowAssets: mk[2], totalBorrowShares: mk[3], price: px };
        const trip = safeTrip(g, loan, guard, p.pledge, held);
        const onScreen = (reads.data?.per.find((x) => x.symbol === g.currency.symbol)?.trip ?? null) !== null || safeCaught.some((x) => x.includes(` ${g.currency.symbol} from`));
        if (trip && !onScreen) newTrips.push(trip);
      }
      if (newTrips.length) {
        setSafeCaught((prev) => [...prev, ...newTrips]);
        throw new Error("The Safe's loan guard changed since this page loaded: read the note above before proposing. Nothing was signed.");
      }
      const batch = buildSafeBatch(safe, bills, plan);

      // C54: run it as the Safe, now, before anyone signs.
      go("simulating");
      const sim = await simulateFromSafe(c, safe, batch);
      if (!sim.ok) {
        const why = decodeAdagError(sim.returnData);
        throw new Error(
          why.name === "unknown"
            ? "Run from the Safe right now, this payment would fail. Check the Safe holds the balance or the cirBTC it needs. Nothing was signed."
            : `Run from the Safe right now, this payment would fail: ${why.text}`,
        );
      }

      const sent = await signAndPropose(safe, batch, fresh.nonce);
      const threshold = sent.threshold ?? fresh.threshold;
      rememberProposal(bills[0]!.contract, bills.map((b) => b.id), { safe, safeTxHash: sent.hash, threshold });
      setProposed({ safe, safeTxHash: sent.hash, threshold, bills, restored: false });
      onProposed?.();
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      go("idle");
    }
  };

  // Hashes the Safe transaction, checks the hash against the Safe's own, has the connected owner sign it and hands it
  // to the server, which checks it all again before proposing (C51, C52).
  const signAndPropose = async (safe: Address, batch: SafeBatch, nonce: bigint): Promise<{ hash: Hex; threshold?: number }> => {
    if (!owner) throw new Error("Connect an ordinary wallet that owns the Safe, on Arc.");
    const c = client();
    const tx = safeTxFor(batch, nonce);
    assertSafeTxShape(safe, tx);
    const hash = await checkedSafeTxHash(c, safe, tx);

    // C27 and C4: the account signing is the owner just checked, on Arc, at this very moment.
    const connection = getConnection(wagmiConfig);
    if (connection.status !== "connected" || connection.chainId !== 5042 || !connection.address || !isAddressEqual(connection.address, owner)) {
      throw new Error("Your wallet changed account or network since the Safe was checked. Nothing was signed.");
    }
    go("signing");
    let signature: Hex;
    try {
      signature = normaliseV(await signTypedData(wagmiConfig, { account: owner, ...safeTxTypedData(safe, tx) }));
    } catch {
      throw new Error("You declined in your wallet. Nothing was signed.");
    }

    go("proposing");
    const res = await fetch("/api/safe/propose", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ safe, owner, safeTxHash: hash, signature, tx: safeTxToJson(tx) }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = (await res.json()) as { ok?: boolean; error?: string; threshold?: number };
    if (!res.ok || !body.ok) throw new Error(body.error ?? "The proposal was not accepted.");
    return { hash, threshold: body.threshold };
  };

  // C55: the Safe records its own existing loan, as itself, in a Safe transaction of its own.
  const proposeEnrol = async () => {
    if (!info || !owner) return;
    setProblem(null);
    const c = client();
    const safe = info.address;
    try {
      go("checking");
      const fresh = await verifySafe(c, safe, owner);
      const batch = buildSafeEnrol(safe);
      go("simulating");
      const sim = await simulateFromSafe(c, safe, batch);
      if (!sim.ok) throw new Error(`Run from the Safe right now, recording its loan would fail: ${decodeAdagError(sim.returnData).text}`);
      const sent = await signAndPropose(safe, batch, fresh.nonce);
      setEnrolProposed({ safeTxHash: sent.hash, threshold: sent.threshold ?? fresh.threshold });
    } catch (error) {
      setProblem((error as Error).message);
    } finally {
      go("idle");
    }
  };

  const onPropose = () => {
    const usesBitcoin = groups.some((g) => choices[g.currency.symbol] === "bitcoin");
    if (usesBitcoin && owner && !hasAcceptedMorphoDisclaimer(owner)) return setAsking(true);
    void propose();
  };

  if (proposed) {
    return (
      <SafeStatus
        safe={proposed.safe}
        proposal={proposed}
        onPaid={refresh}
        onStartOver={() => {
          forgetProposal(proposed.bills[0]!.contract, proposed.bills.map((b) => b.id), proposed.safe);
          setProposed(null);
        }}
      />
    );
  }

  const busy = step !== "idle";
  const allChosen = groups.every((g) => choices[g.currency.symbol]);
  // As on a wallet's own pay screen: the markets the Safe borrows in are checked on the new borrowing, the others on the
  // loan it already had.
  const safeBorrowing = groups.filter((g) => choices[g.currency.symbol] === "bitcoin").map((g) => g.currency.marketId);
  const safeBlockers = reads.data ? blockers({ markets: reads.data.loans, borrowsIn: safeBorrowing.length ? safeBorrowing : null }) : [];
  const bitcoinGroups = (reads.data?.per ?? []).filter((p) => choices[p.symbol] === "bitcoin");
  const safeGuardUnread = bitcoinGroups.some((p) => p.guard.state !== "ok");
  const safeTrips = [...bitcoinGroups.flatMap((p) => (p.trip ? [p.trip] : [])), ...safeCaught.filter((c) => !bitcoinGroups.some((p) => p.trip && c.includes(` ${p.symbol} from`)))];
  const guardUnread = reads.data !== undefined && reads.data.pending === null;
  const safePendingText = reads.data?.pending ? keptAsideText(reads.data.pending) : null;
  return (
    <div className="app-panel p-6 md:p-8" data-safe-pay>
      <p className="type-label text-gold">Pay from a Safe</p>
      <p className="type-body mt-3 text-muted">
        Your wallet builds the payment and signs it once as one owner. Your other owners confirm it in Safe&apos;s own app. Nothing is paid until the Safe
        executes it, and it is checked again then: if anything changed, the whole payment is refused and nothing moves.
      </p>

      {!ready ? (
        <p className="type-body mt-5 text-text">Connect an ordinary wallet that owns the Safe, on Arc.</p>
      ) : (
        <>
          <div className="mt-6">
            <p className="type-micro text-muted">Your Safes</p>
            <div className="mt-2 flex flex-wrap gap-2">
              {list.isPending ? (
                <span className="type-body text-muted">Looking up your Safes…</span>
              ) : list.isError ? (
                <span className="type-body text-muted" data-safe-list-error>
                  {(list.error as Error).message} Paste the Safe&apos;s address below instead.
                </span>
              ) : list.data && list.data.length ? (
                list.data.map((s) => (
                  <button
                    key={s}
                    type="button"
                    disabled={busy}
                    onClick={() => {
                      setPasted(s);
                      void check(s);
                    }}
                    className="type-address rounded-[6px] border border-rule-strong px-3 py-2 text-text transition-colors duration-200 hover:border-gold hover:text-gold"
                  >
                    {shortAddress(s)}
                  </button>
                ))
              ) : (
                <span className="type-body text-muted">No Safes listed for this wallet. Paste the Safe&apos;s address below.</span>
              )}
            </div>
            <p className="type-micro mt-1 normal-case tracking-[0.04em] text-muted">The list is a hint from Safe&apos;s service; Adag checks the Safe on Arc before anything is signed.</p>
          </div>

          <label htmlFor={fieldId} className="type-micro mt-5 block text-muted">
            Safe address
          </label>
          <div className="mt-2 flex flex-col gap-3 md:flex-row">
            <input
              id={fieldId}
              value={pasted}
              onChange={(e) => setPasted(e.target.value.trim())}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
              className="type-address h-11 flex-1 rounded-[8px] border border-rule-strong bg-transparent px-3 text-text transition-colors duration-200 hover:border-gold focus:border-gold focus:outline-none"
              data-field="safe-address"
            />
            <Button variant="secondary" size="sm" disabled={busy || !pasted} onClick={() => void check(pasted)} data-action="safe-check" className="h-11">
              Check this Safe
            </Button>
          </div>

          {info && (
            <div className="mt-6 border-t border-rule pt-5" data-safe-verified>
              <p className="type-body text-text">
                Safe <span className="type-address">{shortAddress(info.address)}</span> · version {info.version} · {info.threshold} of {info.owners.length} owners must
                sign · you are an owner.
              </p>
              {safeBlockers.length > 0 && (
                <div className="mt-4 rounded-[8px] border border-gold/50 p-4" data-safe-enrol>
                  <p className="type-label text-gold">Record this Safe&apos;s existing loan first</p>
                  <p className="type-body mt-2 text-text">
                    This Safe already borrows on Morpho: its {safeBlockers[0]!.symbol} loan is at {formatPercentWad(safeBlockers[0]!.ltvWad)}. Adag checks the 40% line only on
                    new borrowing, so the Safe records the loan it has first, in a Safe transaction of its own. No money moves.
                  </p>
                  <p className="type-body mt-2 text-muted">Recording does not change the loan or make it safer: it tells Adag to judge only what the Safe borrows from now on.</p>
                  {enrolProposed ? (
                    <p className="type-body mt-3 text-text" data-safe-enrol-proposed>
                      Proposed ({shortAddress(enrolProposed.safeTxHash)}). Once your other owners execute it in Safe&apos;s app, the payment can be proposed here.
                    </p>
                  ) : (
                    <Button variant="primary" size="sm" disabled={busy} onClick={() => void proposeEnrol()} className="mt-3" data-action="safe-enrol">
                      Propose: record this Safe&apos;s existing loan
                    </Button>
                  )}
                </div>
              )}
              <div className="mt-4 grid gap-3">
                {groups.map((g) => {
                  const p = reads.data?.per.find((x) => x.symbol === g.currency.symbol);
                  const canBalance = p ? p.balance >= g.total + p.pull : false;
                  const canBitcoin = p ? p.fresh && (reads.data?.cirBtc ?? 0n) >= p.pledge : false;
                  const choice = choices[g.currency.symbol];
                  return (
                    <div key={g.currency.symbol} className="rounded-[8px] border border-rule p-4" data-safe-group={g.currency.symbol}>
                      <p className="type-label text-text">
                        {formatUnitsExact(g.total, g.currency.decimals)} {g.currency.symbol}
                      </p>
                      <div role="radiogroup" className="mt-3 flex flex-col gap-2">
                        {(["bitcoin", "balance"] as const).map((opt) => {
                          const enabled = opt === "bitcoin" ? canBitcoin : canBalance;
                          return (
                            <label key={opt} className={`type-body flex items-start gap-3 ${enabled ? "cursor-pointer text-text" : "text-muted opacity-60"}`}>
                              <input
                                type="radio"
                                name={`safe-${g.currency.symbol}`}
                                disabled={!enabled || busy}
                                checked={choice === opt}
                                onChange={() => setChoices((prev) => ({ ...prev, [g.currency.symbol]: opt }))}
                                className="mt-1.5 accent-[var(--gold-fill)]"
                                data-safe-choice={`${g.currency.symbol}-${opt}`}
                              />
                              <span>
                                {opt === "bitcoin"
                                  ? p
                                    ? p.fresh
                                      ? `From the Safe's bitcoin: it pledges ${formatUnitsExact(p.pledge, CIRBTC_DECIMALS)} cirBTC${usdHint(p.pledge, usd)} and keeps it.`
                                      : "From the Safe's bitcoin: paused until the bitcoin price updates."
                                    : "From the Safe's bitcoin"
                                  : p
                                    ? `From the Safe's balance: it holds ${formatUnitsExact(p.balance, g.currency.decimals)} ${g.currency.symbol}.`
                                    : "From the Safe's balance"}
                              </span>
                            </label>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
              {safeTrips.map((t) => (
                <p key={t} className="type-body mt-4 text-text" data-guard-trigger>
                  {t}
                </p>
              ))}
              {safeGuardUnread && (
                <p className="type-body mt-4 text-danger" data-guard-rule-unreadable>
                  {GUARD_RULE_UNREADABLE.replace("your loan guard", "the Safe's loan guard")}
                </p>
              )}
              <Button
                variant="primary"
                disabled={busy || !allChosen || safeBlockers.length > 0 || guardUnread || safeGuardUnread}
                onClick={onPropose}
                className="mt-5 w-full md:w-auto"
                data-action="safe-propose"
              >
                {busy ? `${LABEL[step]}${seconds >= 2 ? ` · ${seconds}s` : ""}` : "Propose to the Safe"}
              </Button>
              {!allChosen && !busy && <p className="type-body mt-2 text-muted">Choose how the Safe pays each currency.</p>}
              {safeBlockers.length > 0 && <p className="type-body mt-2 text-muted">The payment can be proposed once the recording above has executed.</p>}
              {safePendingText && (
                <p className="type-body mt-2 text-muted" data-guard-pending>
                  {safePendingText.replace("this wallet", "this Safe")}
                </p>
              )}
              {guardUnread && (
                <p className="type-body mt-2 text-danger" data-guard-unreadable>
                  {GUARD_UNREADABLE}
                </p>
              )}
            </div>
          )}
          {busy && !info && <p className="type-body mt-4 text-muted">{LABEL[step]}{seconds >= 2 ? ` · ${seconds}s` : ""}</p>}
          {problem && (
            <p className="type-body mt-4 text-danger" data-safe-problem>
              {problem}
            </p>
          )}
        </>
      )}

      <MorphoDisclaimer
        open={asking}
        onCancel={closeDisclaimer}
        onAccept={() => {
          if (owner) rememberMorphoDisclaimer(owner);
          setAsking(false);
          void propose();
        }}
      />
    </div>
  );
}

// After the proposal: signatures so far from the service, and whether the bills are paid only from AdagBills (C53).
function SafeStatus({ safe, proposal, onPaid, onStartOver }: { safe: Address; proposal: Proposed; onPaid: () => void; onStartOver: () => void }) {
  const bills = proposal.bills;
  const status = useQuery({
    queryKey: ["adag-safe-status", safe, proposal.safeTxHash],
    refetchInterval: 6_000,
    retry: false,
    queryFn: async () => {
      const res = await fetch(`/api/safe/status?safe=${safe}&safeTxHash=${proposal.safeTxHash}`, { signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { confirmations?: number; threshold?: number; nonceUsed?: boolean; error?: string };
      if (!res.ok) throw new Error(body.error ?? "Status unavailable.");
      return body;
    },
  });
  const paid = useQuery({
    queryKey: ["adag-safe-paid", safe, bills.map((b) => b.id.toString()).join(",")],
    refetchInterval: (q) => (q.state.data?.bySafe ? false : 6_000),
    queryFn: async () => {
      const records = await Promise.all(bills.map((b) => client().readContract({ address: b.contract, abi: adagAbi, functionName: "bill", args: [b.id] })));
      // F4: a bill someone else paid makes the whole proposal fail at execution, so it is named while there is time.
      const byOther = records.map((r, i) => ({ r, b: bills[i]! })).filter(({ r }) => r.status === BILL_STATUS.Paid && !isAddressEqual(r.payer, safe)).map(({ b }) => b.id);
      return { bySafe: records.every((r) => r.status === BILL_STATUS.Paid && isAddressEqual(r.payer, safe)), byOther };
    },
  });
  const paidBySafe = paid.data?.bySafe === true;
  const reported = useRef(false);
  useEffect(() => {
    if (!paidBySafe || reported.current) return;
    reported.current = true;
    onPaid();
  }, [paidBySafe, onPaid]);

  const s = status.data;
  const queueUrl = `${SAFE_APP_URL}/transactions/queue?safe=arc:${safe}`;
  if (paidBySafe) {
    return (
      <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} className="app-panel app-stamp p-6 md:p-8" data-safe-paid>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="type-label text-success">Paid by your Safe</p>
            <p className="type-h3 mt-3 text-text">{bills.length === 1 ? `Bill #${bills[0]!.id} is paid.` : `${bills.length} bills are paid.`}</p>
            <p className="type-body mt-2 text-muted">
              {proposal.restored ? "The proposal this browser made has been executed. " : ""}Read from AdagBills: the Safe is the payer of record.
            </p>
          </div>
          <BillStamp status="paid" entrance="in-view" tilt={-9} />
        </div>
      </motion.div>
    );
  }
  const ready = s !== undefined && s.threshold !== undefined && s.confirmations !== undefined && s.confirmations >= s.threshold;
  const byOther = paid.data?.byOther ?? [];
  return (
    <div className="app-panel p-6 md:p-8" data-safe-status>
      <p className="type-label text-gold">{proposal.restored ? "Proposed to your Safe from this browser" : "Proposed to your Safe"}</p>
      <p className="type-h3 mt-3 text-text">
        {s
          ? ready
            ? `All ${s.threshold} signature${s.threshold === 1 ? " is" : "s are"} in`
            : `${s.confirmations} of ${s.threshold} signatures`
          : status.isError
            ? "Signatures unavailable"
            : "Reading the Safe's queue"}
      </p>
      {ready ? (
        <p className="type-body mt-3 text-text" data-safe-ready>
          All signatures are in. One owner presses Execute in Safe&apos;s app (it costs a small fee).
        </p>
      ) : (
        <p className="type-body mt-3 text-text">Waiting for your other owners in Safe&apos;s app. Nothing is paid until the Safe executes it.</p>
      )}
      {byOther.length > 0 && (
        <p className="type-body mt-3 text-danger" data-safe-paid-by-other>
          Bill #{byOther.join(", #")} was paid by someone else. If the Safe executes, the whole payment is refused and only the fee is spent: reject it in Safe&apos;s app.
        </p>
      )}
      {s?.nonceUsed && (
        <div className="mt-3" data-safe-nonce-used>
          <p className="type-body text-danger">
            The Safe has moved past this proposal without paying: it was replaced, or it failed at execution and nothing moved.
          </p>
          <Button variant="secondary" size="sm" onClick={onStartOver} className="mt-3" data-action="safe-start-over">
            Build the payment again
          </Button>
        </div>
      )}
      <a href={queueUrl} target="_blank" rel="noopener noreferrer" className="link-draw type-body mt-5 inline-block text-gold hover:text-text">
        Open the Safe&apos;s queue in Safe&apos;s app
      </a>
      <p className="type-micro mt-4 normal-case tracking-[0.04em] text-muted">
        Proposal {shortAddress(proposal.safeTxHash)}. When it runs, the transaction appears on the <a href={`${EXPLORER}/address/${safe}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold">explorer</a>.
      </p>
    </div>
  );
}
