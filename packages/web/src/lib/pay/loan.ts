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
