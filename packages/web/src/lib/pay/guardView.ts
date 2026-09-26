// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node. What a payment means
// for the payer's own loan guard, worked out before signing (C45, C58).
import { planRepay, type LoanState } from "../guard/plan";
import { formatUnitsExact } from "./format";

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

export const GUARD_UNREADABLE = "Adag could not read your loan guard, so it cannot check this wallet can cover the payment. Try again.";
