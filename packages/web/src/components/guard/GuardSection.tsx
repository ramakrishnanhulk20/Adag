"use client";

import { useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "motion/react";
import { decodeEventLog, isAddressEqual, type Address, type Hex, type Log } from "viem";
import { arc } from "viem/chains";
import { useReadContracts } from "wagmi";
import { Button } from "@/components/Button";
import { MorphoDisclaimer } from "@/components/app/MorphoDisclaimer";
import { BusyLabel, TxMessage, type TxState } from "@/components/app/TxProgress";
import { guardAbi } from "@/lib/guard/abi";
import { buildSaveRule, buildStopRule, type RuleInput } from "@/lib/guard/build";
import { ADAG_GUARD } from "@/lib/guard/constants";
import type { LoanState } from "@/lib/guard/plan";
import { erc20Abi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { EXPLORER, MORPHO, type Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";
import { hasAcceptedMorphoDisclaimer, rememberMorphoDisclaimer } from "@/lib/wallet/consent";
import { publicArc, simulateAndSend, type TxStep } from "@/lib/wallet/send";
import { ProtectPanel } from "./ProtectPanel";

type Rule = { triggerWad: bigint; targetWad: bigint; expiry: bigint };
type Read = { status: "success"; result: unknown } | { status: "failure"; error: Error };

type Props = { address: Address; currency: Currency; position: readonly [bigint, bigint, bigint]; canSign: boolean; blockedReason: string | null; onChanged: () => void };

function guardEvent(logs: readonly Log[], guard: Address, name: "RuleSet" | "RuleCleared") {
  for (const log of logs) {
    if (!isAddressEqual(log.address, guard)) continue;
    try {
      const event = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics });
      if (event.eventName === name) return event.args as { borrower: Address; marketId: Hex; triggerWad?: bigint; targetWad?: bigint; expiry?: bigint };
    } catch {
      // Not one of AdagGuard's events.
    }
  }
  return null;
}

// The loan guard for one loan: what it is set to, the approval standing beside it (C60), what it would do right now,
// and the panel to set, change or stop it.
export function GuardSection({ address, currency, position, canSign, blockedReason, onChanged }: Props) {
  const guard = ADAG_GUARD;
  const m = currency.marketId;
  const reads = useReadContracts({
    allowFailure: true,
    contracts: guard
      ? [
          { chainId: arc.id, address: guard, abi: guardAbi, functionName: "ruleOf", args: [address, m] },
          { chainId: arc.id, address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, guard] },
          { chainId: arc.id, address: guard, abi: guardAbi, functionName: "quote", args: [address, m] },
          { chainId: arc.id, address: currency.address, abi: erc20Abi, functionName: "balanceOf", args: [address] },
          { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "market", args: [m] },
          { chainId: arc.id, address: currency.params.oracle, abi: oracleAbi, functionName: "price" },
        ]
      : [],
    query: { enabled: Boolean(guard), refetchInterval: 15_000 },
  });
  const [open, setOpen] = useState(false);
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [done, setDone] = useState<{ text: string; hash: Hex } | null>(null);
  const [asking, setAsking] = useState<null | (() => void)>(null);

  if (!guard) return null;

  const value = <T,>(i: number): T | null => {
    const r = reads.data?.[i] as Read | undefined;
    return r && r.status === "success" ? (r.result as T) : null;
  };
  const rule = value<Rule>(0);
  const allowance = value<bigint>(1);
  const quote = value<readonly [boolean, bigint, bigint]>(2);
  const balance = value<bigint>(3);
  const market = value<readonly [bigint, bigint, bigint, bigint, bigint, bigint]>(4);
  const price = value<bigint>(5);
  const loan: LoanState | null = market && price !== null ? { shares: position[1], totalAssets: market[2], totalShares: market[3], collateral: position[2], price } : null;
  const hasRule = rule !== null && rule.triggerWad > 0n;
  // A repaid loan can still carry a rule or an approval, and both stay on screen until stopped (C60).
  if (position[1] === 0n && !hasRule && !(allowance !== null && allowance > 0n)) return null;
  const sym = currency.symbol;
  const fmt = (v: bigint) => formatUnitsExact(v, currency.decimals);
  const busy = tx.kind === "busy" ? tx : null;
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));
  const fail = (message: string, hash?: Hex) => setTx({ kind: "failed", message, href: hash && `${EXPLORER}/tx/${hash}` });
  const refresh = () => {
    void reads.refetch();
    onChanged();
  };
  const withConsent = (go: () => void) => {
    setTx({ kind: "idle" });
    setDone(null);
    if (!hasAcceptedMorphoDisclaimer(address)) return setAsking(() => go);
    go();
  };

  const save = async (next: RuleInput, approval: bigint) => {
    step("checking");
    const client = publicArc();
    let now: bigint;
    try {
      now = (await client.getBlock()).timestamp;
    } catch {
      return fail("Arc did not answer, so nothing was built. Try again.");
    }
    let built;
    try {
      built = buildSaveRule(address, next, approval, currency.params.lltv, now);
    } catch (error) {
      return fail(`${(error as Error).message} Nothing was sent.`);
    }
    // The approval moves no tokens, so nothing is counted against the fee balance here.
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: 0n });
    if (!out.ok) return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });

    // Proven by AdagGuard's own RuleSet for this wallet and market, and a fresh read of the rule and the approval.
    const set = guardEvent(out.receipt.logs, guard, "RuleSet");
    const [after, allowed] = await Promise.all([
      client.readContract({ address: guard, abi: guardAbi, functionName: "ruleOf", args: [address, m] }),
      client.readContract({ address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, guard] }),
    ]).catch(() => [null, null] as const);
    const proven =
      set !== null &&
      isAddressEqual(set.borrower, address) &&
      set.marketId.toLowerCase() === m.toLowerCase() &&
      after !== null &&
      after.triggerWad === next.triggerWad &&
      after.targetWad === next.targetWad &&
      after.expiry === next.expiry &&
      allowed === approval;
    if (!proven) return fail("Arc confirmed the transaction, but AdagGuard does not read the rule as saved. Check the transaction.", out.hash);
    setDone({ hash: out.hash, text: `Protected. It steps in at ${formatPercentWad(next.triggerWad)} and repays down to ${formatPercentWad(next.targetWad)}, using at most ${fmt(approval)} ${sym}.` });
    setTx({ kind: "idle" });
    setOpen(false);
    refresh();
  };

  const stop = async () => {
    step("checking");
    let built;
    try {
      built = buildStopRule(address, m, hasRule);
    } catch (error) {
      return fail(`${(error as Error).message} Nothing was sent.`);
    }
    const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep: step, usdcOut: 0n });
    if (!out.ok) return setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
    const client = publicArc();
    const cleared = hasRule ? guardEvent(out.receipt.logs, guard, "RuleCleared") : { borrower: address, marketId: m };
    const [after, allowed] = await Promise.all([
      client.readContract({ address: guard, abi: guardAbi, functionName: "ruleOf", args: [address, m] }),
      client.readContract({ address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, guard] }),
    ]).catch(() => [null, null] as const);
    // C60: stopped means no rule and an approval of exactly 0, read back from the chain.
    if (!cleared || after === null || after.triggerWad !== 0n || allowed !== 0n) {
      return fail("Arc confirmed the transaction, but the rule or the approval does not read as cleared. Check the transaction.", out.hash);
    }
    setDone({ hash: out.hash, text: `Protection stopped. No rule, and AdagGuard's approval for your ${sym} is 0.` });
    setTx({ kind: "idle" });
    setOpen(false);
    refresh();
  };

  const expired = hasRule && rule!.expiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) >= rule!.expiry;
  const usable = allowance !== null && balance !== null ? (allowance < balance ? allowance : balance) : null;

  return (
    <section className="mt-7 border-t border-rule pt-6" data-guard={sym} aria-label={`Loan guard for the ${sym} loan`}>
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <p className="type-label text-gold">Loan guard</p>
        <Link href="/app/protect" className="link-draw type-micro text-muted hover:text-gold">
          Telegram alerts
        </Link>
      </div>

      {reads.isPending ? (
        <p className="type-body mt-3 text-muted">Reading AdagGuard on Arc.</p>
      ) : rule === null || allowance === null ? (
        <p className="type-body mt-3 text-muted">The guard&apos;s settings are unavailable right now: Arc did not answer.</p>
      ) : hasRule ? (
        <div className="mt-3" data-guard-summary>
          <p className="type-body text-text">
            Protected: repays at <span className="font-semibold">{formatPercentWad(rule.triggerWad)}</span> down to <span className="font-semibold">{formatPercentWad(rule.targetWad)}</span>. May use up to{" "}
            <span className="font-semibold" data-guard-usable={usable?.toString() ?? ""}>
              {usable === null ? "…" : `${fmt(usable)} ${sym}`}
            </span>{" "}
            (allowance now <span data-guard-allowance={allowance.toString()}>{fmt(allowance)}</span>).
            {rule.expiry !== 0n && <span className="text-muted"> {expired ? "Ended" : "Until"} {new Date(Number(rule.expiry) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.</span>}
          </p>
          {allowance === 0n && <p className="type-body mt-2 text-danger">It cannot act: its approval is 0. Change it to give it an amount, or stop protecting.</p>}
          {quote && (
            <p className={`type-body mt-2 ${quote[0] ? "text-pending" : "text-muted"}`} data-guard-quote data-guard-would-repay={quote[0] ? quote[1].toString() : "0"}>
              {quote[0]
                ? `Right now it would repay ${fmt(quote[1])} ${sym}, from a loan at ${formatPercentWad(quote[2])}. The keeper sends it within minutes.`
                : `It would not act right now: the loan is at ${formatPercentWad(quote[2])}.`}
            </p>
          )}
        </div>
      ) : (
        <div className="mt-3">
          <p className="type-body text-muted">Not protected. The guard repays part of this loan from your own {sym} if it crosses a line you choose, so Morpho never gets there.</p>
          {allowance > 0n && (
            <p className="type-body mt-2 text-pending" data-guard-leftover={allowance.toString()}>
              AdagGuard still holds an approval of {fmt(allowance)} {sym} with no rule. Stop protecting sets it to 0.
            </p>
          )}
        </div>
      )}

      {!canSign ? (
        blockedReason && <p className="type-body mt-4 text-muted">{blockedReason}</p>
      ) : !open && rule !== null && allowance !== null ? (
        <div className="mt-5 flex flex-col gap-3 md:flex-row">
          <Button variant={hasRule ? "secondary" : "primary"} disabled={Boolean(busy)} onClick={() => (setOpen(true), setDone(null), setTx({ kind: "idle" }))} data-action="protect-open" className="w-full md:w-auto">
            {hasRule ? "Change" : "Protect this loan"}
          </Button>
          {(hasRule || allowance > 0n) && (
            <Button
              variant="secondary"
              disabled={Boolean(busy)}
              // Taking permission away never waits on the Morpho notice: stopping touches only the rule and the approval.
              onClick={() => (setTx({ kind: "idle" }), setDone(null), void stop())}
              data-action="protect-stop"
              className="w-full md:w-auto"
            >
              {busy ? <BusyLabel step={busy.step} since={busy.since} /> : "Stop protecting"}
            </Button>
          )}
        </div>
      ) : null}

      <AnimatePresence initial={false}>
        {open && canSign && (
          <motion.div key="panel" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }} className="overflow-hidden">
            <ProtectPanel
              address={address}
              currency={currency}
              loan={loan}
              ltvWad={quote ? quote[2] : null}
              balance={balance}
              initial={hasRule ? { ...rule!, approval: allowance ?? 0n } : null}
              busy={busy}
              onSave={(next, approval) => withConsent(() => void save(next, approval))}
              onCancel={() => setOpen(false)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {done && (
        <p className="type-body mt-4 text-success" data-guard-result>
          {done.text}{" "}
          <a href={`${EXPLORER}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw text-text hover:text-gold">
            View the transaction
          </a>
        </p>
      )}
      <div className="mt-3">
        <TxMessage state={tx} />
      </div>

      <MorphoDisclaimer
        open={asking !== null}
        onCancel={() => setAsking(null)}
        onAccept={() => {
          rememberMorphoDisclaimer(address);
          const go = asking;
          setAsking(null);
          go?.();
        }}
      />
    </section>
  );
}
