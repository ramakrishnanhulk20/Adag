"use client";

import { useState } from "react";
import Link from "next/link";
import type { Address, Hex } from "viem";
import { arc } from "viem/chains";
import { useReadContracts } from "wagmi";
import { Button } from "@/components/Button";
import { BusyLabel, TxMessage, type TxState } from "@/components/app/TxProgress";
import { guardAbi } from "@/lib/guard/abi";
import { ADAG_GUARD } from "@/lib/guard/constants";
import { erc20Abi, morphoAbi } from "@/lib/pay/abi";
import { CURRENCIES, EXPLORER, MORPHO, type Currency } from "@/lib/pay/constants";
import type { TxStep } from "@/lib/wallet/send";
import { stopGuard } from "./guardTx";
import { GuardSummary, type GuardRule } from "./GuardSummary";

type Read = { status: "success"; result: unknown } | { status: "failure"; error: Error };
const PER_MARKET = 4;

type Done = { text: string; hash: Hex };
type ItemProps = { address: Address; currency: Currency; rule: GuardRule; allowance: bigint; balance: bigint | null; hasCard: boolean; canSign: boolean; onStopped: (done: Done) => void };

// One market's guard. A rule is set or changed on the loan card, but it can always be stopped from here, because a
// closed loan has no card and its leftover approval must still be switchable to 0 where it is shown (C60).
function GuardListItem({ address, currency, rule, allowance, balance, hasCard, canSign, onStopped }: ItemProps) {
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const busy = tx.kind === "busy" ? tx : null;
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));
  const hasRule = rule.triggerWad > 0n;
  const stop = async () => {
    const out = await stopGuard(address, currency, hasRule, step);
    if (!out.ok) return setTx(out.state);
    setTx({ kind: "idle" });
    onStopped({ hash: out.hash, text: out.text });
  };

  return (
    <li className="py-5" data-guard-list-item={currency.symbol}>
      <p className="type-micro text-muted">{currency.symbol} loan</p>
      <div className="mt-2">
        <GuardSummary currency={currency} rule={rule} allowance={allowance} balance={balance} />
      </div>
      {hasCard ? (
        <Link href={`/app#guard-${currency.symbol.toLowerCase()}`} className="link-draw type-body mt-3 inline-block text-text hover:text-gold" data-guard-list-link={currency.symbol}>
          Change it on your wallet page
        </Link>
      ) : (
        <p className="type-body mt-3 text-muted" data-guard-list-closed={currency.symbol}>
          This loan is closed. Stop protecting sets the approval to 0.
        </p>
      )}
      {canSign && (hasRule || allowance > 0n) && (
        <div className="mt-4">
          <Button variant="secondary" size="sm" disabled={Boolean(busy)} onClick={() => void stop()} data-action="list-protect-stop">
            {busy ? <BusyLabel step={busy.step} since={busy.since} /> : "Stop protecting"}
          </Button>
        </div>
      )}
      <div className="mt-3">
        <TxMessage state={tx} />
      </div>
    </li>
  );
}

// "Your loan guards": every market where this wallet borrows, keeps a rule or still grants AdagGuard an approval,
// in the loan card's own words, with a link to the card where it is changed and a way to stop it from here.
export function GuardList({ address, canSign }: { address: Address; canSign: boolean }) {
  const guard = ADAG_GUARD;
  const [done, setDone] = useState<Done | null>(null);
  const reads = useReadContracts({
    allowFailure: true,
    contracts: guard
      ? CURRENCIES.flatMap((c) => [
          { chainId: arc.id, address: MORPHO, abi: morphoAbi, functionName: "position", args: [c.marketId, address] } as const,
          { chainId: arc.id, address: guard, abi: guardAbi, functionName: "ruleOf", args: [address, c.marketId] } as const,
          { chainId: arc.id, address: c.address, abi: erc20Abi, functionName: "allowance", args: [address, guard] } as const,
          { chainId: arc.id, address: c.address, abi: erc20Abi, functionName: "balanceOf", args: [address] } as const,
        ])
      : [],
    query: { enabled: Boolean(guard), refetchInterval: 15_000 },
  });
  if (!guard) return null;

  const value = <T,>(i: number): T | null => {
    const r = reads.data?.[i] as Read | undefined;
    return r && r.status === "success" ? (r.result as T) : null;
  };
  const rows = CURRENCIES.map((currency, i) => {
    const position = value<readonly [bigint, bigint, bigint]>(i * PER_MARKET);
    const rule = value<GuardRule>(i * PER_MARKET + 1);
    const allowance = value<bigint>(i * PER_MARKET + 2);
    const balance = value<bigint>(i * PER_MARKET + 3);
    const unreadable = position === null || rule === null || allowance === null;
    const shown = !unreadable && (position[1] > 0n || rule.triggerWad > 0n || allowance > 0n);
    // The wallet page draws a loan card only while the market holds debt or collateral.
    const hasCard = position !== null && (position[1] > 0n || position[2] > 0n);
    return { currency, rule, allowance, balance, unreadable, shown, hasCard };
  });
  const listed = rows.filter((r) => r.shown);

  return (
    <section className="app-panel p-6 md:p-8" aria-label="Your loan guards" data-guard-list>
      <p className="type-label text-gold">Your loan guards</p>
      {reads.isPending ? (
        <p className="type-body mt-4 text-muted">Reading your loans and AdagGuard on Arc.</p>
      ) : (
        <>
          {listed.length === 0 && !rows.some((r) => r.unreadable) && (
            <p className="type-body mt-4 text-muted">This wallet has no loan and no guard. A loan appears here once you pay a bill from bitcoin.</p>
          )}
          <ul className="mt-2 divide-y divide-rule">
            {listed.map(({ currency, rule, allowance, balance, hasCard }) => (
              <GuardListItem
                key={currency.symbol}
                address={address}
                currency={currency}
                rule={rule!}
                allowance={allowance!}
                balance={balance}
                hasCard={hasCard}
                canSign={canSign}
                onStopped={(d) => {
                  setDone(d);
                  void reads.refetch();
                }}
              />
            ))}
          </ul>
          {/* Held here, not on the item: a stopped closed loan leaves the list on the next read, and its result must stay. */}
          {done && (
            <p className="type-body mt-4 text-success" data-guard-list-result>
              {done.text}{" "}
              <a href={`${EXPLORER}/tx/${done.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw text-text hover:text-gold">
                View the transaction
              </a>
            </p>
          )}
          {rows.some((r) => r.unreadable) && <p className="type-body mt-4 text-muted">Some loans are unavailable right now: Arc did not answer. They appear here once it does.</p>}
        </>
      )}
    </section>
  );
}
