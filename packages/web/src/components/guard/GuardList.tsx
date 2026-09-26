"use client";

import Link from "next/link";
import type { Address } from "viem";
import { arc } from "viem/chains";
import { useReadContracts } from "wagmi";
import { guardAbi } from "@/lib/guard/abi";
import { ADAG_GUARD } from "@/lib/guard/constants";
import { erc20Abi, morphoAbi } from "@/lib/pay/abi";
import { CURRENCIES, MORPHO } from "@/lib/pay/constants";
import { GuardSummary, type GuardRule } from "./GuardSummary";

type Read = { status: "success"; result: unknown } | { status: "failure"; error: Error };
const PER_MARKET = 4;

// "Your loan guards": every market where this wallet borrows, keeps a rule or still grants AdagGuard an approval,
// in the loan card's own words, with a link to the card where it is changed. Nothing is set from here.
export function GuardList({ address }: { address: Address }) {
  const guard = ADAG_GUARD;
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
    return { currency, rule, allowance, balance, unreadable, shown };
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
            {listed.map(({ currency, rule, allowance, balance }) => (
              <li key={currency.symbol} className="py-5" data-guard-list-item={currency.symbol}>
                <p className="type-micro text-muted">{currency.symbol} loan</p>
                <div className="mt-2">
                  <GuardSummary currency={currency} rule={rule!} allowance={allowance!} balance={balance} />
                </div>
                <Link href={`/app#guard-${currency.symbol.toLowerCase()}`} className="link-draw type-body mt-3 inline-block text-text hover:text-gold" data-guard-list-link={currency.symbol}>
                  Change it on your wallet page
                </Link>
              </li>
            ))}
          </ul>
          {rows.some((r) => r.unreadable) && <p className="type-body mt-4 text-muted">Some loans are unavailable right now: Arc did not answer. They appear here once it does.</p>}
        </>
      )}
    </section>
  );
}
