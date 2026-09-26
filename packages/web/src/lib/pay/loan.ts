import { MAX_UINT256, ORACLE_SCALE, WAD } from "./constants";

// Morpho's SharesMathLib.toAssetsUp: the debt a borrow-share count stands for, rounded against the borrower.
export function debtFromShares(shares: bigint, totalBorrowAssets: bigint, totalBorrowShares: bigint): bigint {
  if (shares === 0n) return 0n;
  const num = shares * (totalBorrowAssets + 1n);
  const den = totalBorrowShares + 1_000_000n;
  return (num + den - 1n) / den;
}

// Same rounding as AdagBills.loanToValue: collateral value rounds down, the ratio rounds up.
export function ltvWad(debt: bigint, collateral: bigint, price: bigint): bigint {
  if (debt === 0n) return 0n;
  const value = (collateral * price) / ORACLE_SCALE;
  if (value === 0n) return MAX_UINT256;
  return (debt * WAD + value - 1n) / value;
}

// How far bitcoin can fall, as a WAD fraction, before Morpho may liquidate: 1 - ltv / lltv (ARCHITECTURE.md section 5).
export function liquidationDropWad(ltv: bigint, lltv: bigint): bigint {
  if (ltv === MAX_UINT256 || ltv >= lltv) return 0n;
  if (ltv === 0n) return WAD;
  return WAD - (ltv * WAD) / lltv;
}

// What a close approves: the live debt rounded up, plus 0.1% for interest that accrues before the block, plus 1.
// Morpho pulls only what the shares are worth at that moment, and the batch resets the approval to 0 afterwards.
export function closeApproval(shares: bigint, totalBorrowAssets: bigint, totalBorrowShares: bigint): bigint {
  const debt = debtFromShares(shares, totalBorrowAssets, totalBorrowShares);
  return (debt * 1001n + 999n) / 1000n + 1n;
}

// C36: the most a repay by assets may name. Morpho turns assets into shares rounding down and subtracts them from the
// position, so the assets must not exceed the shares' value rounded down, taken from totals accrued to this block.
// Interest that accrues before the transaction lands only lowers the shares those assets buy, so the cap stays safe.
export function repaySomeCap(shares: bigint, accruedTotalBorrowAssets: bigint, totalBorrowShares: bigint): bigint {
  if (shares <= 0n) return 0n;
  return (shares * (accruedTotalBorrowAssets + 1n)) / (totalBorrowShares + 1_000_000n);
}

// Morpho's SharesMathLib.toSharesDown: the borrow shares a repay of `assets` removes.
export function sharesForRepay(assets: bigint, totalBorrowAssets: bigint, totalBorrowShares: bigint): bigint {
  return (assets * (totalBorrowShares + 1_000_000n)) / (totalBorrowAssets + 1n);
}

// Morpho Blue's MathLib.wTaylorCompounded: e^(x*n) - 1 to three terms, in WAD, rounding each term down.
function wTaylorCompounded(x: bigint, n: bigint): bigint {
  const firstTerm = x * n;
  const secondTerm = (firstTerm * firstTerm) / (2n * WAD);
  const thirdTerm = (secondTerm * firstTerm) / (3n * WAD);
  return firstTerm + secondTerm + thirdTerm;
}

// The total borrowed as Morpho will count it once interest is accrued, exactly as _accrueInterest does:
// totalBorrowAssets plus totalBorrowAssets.wMulDown(rate.wTaylorCompounded(elapsed)). market() alone is stale by
// however long nobody has touched the market.
export function accrueBorrowAssets(totalBorrowAssets: bigint, borrowRatePerSecondWad: bigint, elapsedSeconds: bigint): bigint {
  if (elapsedSeconds <= 0n || borrowRatePerSecondWad <= 0n || totalBorrowAssets === 0n) return totalBorrowAssets;
  return totalBorrowAssets + (totalBorrowAssets * wTaylorCompounded(borrowRatePerSecondWad, elapsedSeconds)) / WAD;
}
