// Morpho's market(id) is [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee].
// Accrued interest raises both asset totals by the same amount, so the stored totals already give the free cash.
export function readyToLend(market: readonly bigint[]): bigint {
  const free = market[0]! - market[2]!;
  return free > 0n ? free : 0n;
}

export function lendCovers(ready: bigint, amount: bigint): boolean {
  return amount === 0n || ready >= amount;
}
