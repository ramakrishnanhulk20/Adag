// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node. What a payment means
// for the payer's own loan guard, worked out before signing (C45, C58).
import type { Address, Hex, PublicClient } from "viem";
import { guardAbi } from "../guard/abi";
import { ADAG_GUARD } from "../guard/constants";
import { planRepay, type LoanState } from "../guard/plan";
import { erc20Abi } from "./abi";
import { formatPercentWad, formatUnitsExact } from "./format";

export type GuardRule = { triggerWad: bigint; targetWad: bigint; expiry: bigint };
export type Pending = { usdc: bigint; eurc: bigint };

// Morpho's SharesMathLib.toSharesUp: the borrow shares a borrow of `assets` adds.
export function sharesForBorrow(assets: bigint, totalBorrowAssets: bigint, totalBorrowShares: bigint): bigint {
  const num = assets * (totalBorrowShares + 1_000_000n);
  const den = totalBorrowAssets + 1n;
  return (num + den - 1n) / den;
}

export const ruleActive = (rule: GuardRule | null, nowSeconds: bigint): rule is GuardRule =>
  rule !== null && rule.triggerWad > 0n && (rule.expiry === 0n || rule.expiry > nowSeconds);

// C58: when a payment that borrows lands at or past the payer's own trigger, how much the guard will repay afterwards,
// from AdagGuard's own arithmetic on the loan as it will stand, capped by the approval and by the wallet's balance of
// the loan token after the payment. null when the payment stays under the trigger or there is no live rule.
export function guardRepayAfterBorrow(input: {
  rule: GuardRule | null;
  nowSeconds: bigint;
  ltvAfterWad: bigint;
  before: { shares: bigint; collateral: bigint };
  totals: { totalBorrowAssets: bigint; totalBorrowShares: bigint };
  borrow: bigint;
  pledge: bigint;
  price: bigint;
  allowance: bigint;
  balanceAfter: bigint;
}): { amount: bigint; triggerWad: bigint; targetWad: bigint } | null {
  const { rule } = input;
  if (!ruleActive(rule, input.nowSeconds) || input.ltvAfterWad < rule.triggerWad) return null;
  const added = sharesForBorrow(input.borrow, input.totals.totalBorrowAssets, input.totals.totalBorrowShares);
  const after: LoanState = {
    shares: input.before.shares + added,
    totalAssets: input.totals.totalBorrowAssets + input.borrow,
    totalShares: input.totals.totalBorrowShares + added,
    collateral: input.before.collateral + input.pledge,
    price: input.price,
  };
  const plan = planRepay(after, rule, input.allowance, input.balanceAfter);
  return { amount: plan.amount, triggerWad: rule.triggerWad, targetWad: rule.targetWad };
}

// C45: what a wallet must hold for a payment once the guard's pending repayments are kept aside. `usdcOut` is what the
// USDC-and-gas check in simulateAndSend must count; `needInToken` is the payment token the wallet must hold.
export function coverNeeds(input: { symbol: "USDC" | "EURC"; from: "balance" | "bitcoin"; amount: bigint; pending: Pending }): { usdcOut: bigint; needInToken: bigint } {
  const { symbol, from, amount, pending } = input;
  if (from === "bitcoin") return { usdcOut: pending.usdc, needInToken: 0n };
  if (symbol === "USDC") return { usdcOut: amount + pending.usdc, needInToken: amount + pending.usdc };
  return { usdcOut: pending.usdc, needInToken: amount + pending.eurc };
}

// The sentence under a pay button when the guard is about to pull from this wallet. null when it is not.
export function keptAsideText(pending: Pending): string | null {
  const parts = [
    pending.usdc > 0n ? `${formatUnitsExact(pending.usdc, 6)} USDC` : null,
    pending.eurc > 0n ? `${formatUnitsExact(pending.eurc, 6)} EURC` : null,
  ].filter(Boolean);
  if (parts.length === 0) return null;
  return `Your loan guard will repay about ${parts.join(" and ")} from this wallet within minutes, so that is kept aside.`;
}

// C58: an owner's own rule and remaining approval for one market. A failed read is "unreadable", never "no rule":
// the pay screens block paying from bitcoin on it. With no guard deployed there is simply no rule.
export type GuardRead = { state: "ok"; rule: GuardRule; allowance: bigint } | { state: "unreadable" };
export type GuardViewState = GuardRead | { state: "pending" };

export async function readOwnGuard(client: Pick<PublicClient, "readContract">, owner: Address, market: Hex, loanToken: Address): Promise<GuardRead> {
  if (!ADAG_GUARD) return { state: "ok", rule: { triggerWad: 0n, targetWad: 0n, expiry: 0n }, allowance: 0n };
  try {
    const [rule, allowance] = await Promise.all([
      client.readContract({ address: ADAG_GUARD, abi: guardAbi, functionName: "ruleOf", args: [owner, market] }),
      client.readContract({ address: loanToken, abi: erc20Abi, functionName: "allowance", args: [owner, ADAG_GUARD] }),
    ]);
    return { state: "ok", rule: { triggerWad: rule.triggerWad, targetWad: rule.targetWad, expiry: rule.expiry }, allowance };
  } catch {
    return { state: "unreadable" };
  }
}

// What a screen holding a query of readOwnGuard knows right now.
export const guardViewOf = (query: { data?: GuardRead; isPending: boolean }): GuardViewState => (query.data ?? (query.isPending ? { state: "pending" } : { state: "unreadable" }));

export const GUARD_RULE_UNREADABLE = "Adag could not read your loan guard, so it cannot tell you whether this payment trips it. Try again.";

// The C58 sentence, one wording for every screen. `who` is "this wallet" or "the Safe".
export function triggerSentence(t: { ltvAfterWad: bigint; amount: bigint; triggerWad: bigint; targetWad: bigint; symbol: string; who?: string }): string {
  const pct = formatPercentWad;
  return `This payment takes the loan to ${pct(t.ltvAfterWad)}, at or past your guard's ${pct(t.triggerWad)} trigger. The guard will then repay about ${formatUnitsExact(t.amount, 6)} ${t.symbol} from ${t.who ?? "this wallet"} within minutes, back to ${pct(t.targetWad)}.`;
}

export const GUARD_UNREADABLE = "Adag could not read your loan guard, so it cannot check this wallet can cover the payment. Try again.";
