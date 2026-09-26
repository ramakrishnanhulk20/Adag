// Plain TypeScript with relative imports only, so the unit tests and scripts/check-batches.mjs can load it under bare
// Node. The contract's own rules for when a payment runs the 40% check, restated so the page can say so before signing.
import type { Hex } from "viem";
import { MAX_LTV_WAD, ORACLE_SCALE, WAD } from "./constants";
import { debtFromShares } from "./loan";

export type Position = { shares: bigint; collateral: bigint };

// AdagBills._recordPosition: at pay(), a market is checked when its live borrow shares are nonzero and the shares rose
// or the collateral fell against what the contract last saw. A market this payment borrows in always gets new shares,
// so it is always checked. A wallet that never paid through the contract has seen (0, 0), so any loan counts as new.
export function willCheck(live: Position, seen: Position, borrowsHere: boolean): boolean {
  if (borrowsHere) return true;
  return live.shares !== 0n && (live.shares > seen.shares || live.collateral < seen.collateral);
}

// AdagBills._checkLoan and _maxBorrow: LtvAboveLimit when the debt (rounded up) is above
// floor(floor(collateral * price / 1e36) * 0.4e18 / 1e18).
export function overLimit(borrowed: bigint, collateral: bigint, price: bigint): boolean {
  const value = (collateral * price) / ORACLE_SCALE;
  const maxBorrow = (value * MAX_LTV_WAD) / WAD;
  return borrowed > maxBorrow;
}

export type MarketInput = {
  market: Hex;
  symbol: "USDC" | "EURC";
  live: Position;
  seen: Position;
  totalBorrowAssets: bigint;
  totalBorrowShares: bigint;
  price: bigint;
  // priceStatus(market).fresh: false makes any check in this market revert StalePrice.
  fresh: boolean;
};

export type Blocker = { market: Hex; symbol: "USDC" | "EURC"; reason: "over" | "stale"; ltvWad: bigint };

const ltvOf = (debt: bigint, collateral: bigint, price: bigint) => {
  if (debt === 0n) return 0n;
  const value = (collateral * price) / ORACLE_SCALE;
  return value === 0n ? 2n ** 256n - 1n : (debt * WAD + value - 1n) / value;
};

// The markets whose check would run at pay() on debt the payer already had, and would revert: over the 40% line or on
// a stale price. The market this payment borrows in is left out: its check is on the new borrowing, which the pledge
// suggestion already sizes. Totals should be accrued to now, as the contract accrues interest before it checks.
// A basket can borrow in both markets at once, so borrowsIn may also be a list; every market in it is left out.
export function blockers(input: { markets: readonly MarketInput[]; borrowsIn: Hex | readonly Hex[] | null }): Blocker[] {
  const borrowing = (input.borrowsIn === null ? [] : typeof input.borrowsIn === "string" ? [input.borrowsIn] : input.borrowsIn).map((x) => x.toLowerCase());
  const out: Blocker[] = [];
  for (const m of input.markets) {
    if (borrowing.includes(m.market.toLowerCase())) continue;
    if (!willCheck(m.live, m.seen, false)) continue;
    const debt = debtFromShares(m.live.shares, m.totalBorrowAssets, m.totalBorrowShares);
    const ltvWad = ltvOf(debt, m.live.collateral, m.price);
    if (!m.fresh) out.push({ market: m.market, symbol: m.symbol, reason: "stale", ltvWad });
    else if (overLimit(debt, m.live.collateral, m.price)) out.push({ market: m.market, symbol: m.symbol, reason: "over", ltvWad });
  }
  return out;
}
