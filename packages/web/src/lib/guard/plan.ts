// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node. Browser-safe.
// AdagGuard's own arithmetic, restated, for a rule that is not on chain yet: what it would repay now if saved (C41).
// Once a rule exists, the page reads quote() from the contract instead of this.

const WAD = 10n ** 18n;
const ORACLE_SCALE = 10n ** 36n;
const VIRTUAL_SHARES = 1_000_000n;
const VIRTUAL_ASSETS = 1n;

export type LoanState = { shares: bigint; totalAssets: bigint; totalShares: bigint; collateral: bigint; price: bigint };

const mulDivUp = (a: bigint, b: bigint, d: bigint) => (a * b + d - 1n) / d;

function debtAfter(l: LoanState, assets: bigint): bigint {
  const burned = (assets * (l.totalShares + VIRTUAL_SHARES)) / (l.totalAssets + VIRTUAL_ASSETS);
  if (burned >= l.shares) return 0n;
  const left = l.totalAssets > assets ? l.totalAssets - assets : 0n;
  return mulDivUp(l.shares - burned, left + VIRTUAL_ASSETS, l.totalShares - burned + VIRTUAL_SHARES);
}

export function planRepay(l: LoanState, rule: { triggerWad: bigint; targetWad: bigint }, allowance: bigint, balance: bigint): { ltvWad: bigint; amount: bigint; debt: bigint } {
  if (l.shares === 0n) return { ltvWad: 0n, amount: 0n, debt: 0n };
  const debt = mulDivUp(l.shares, l.totalAssets + VIRTUAL_ASSETS, l.totalShares + VIRTUAL_SHARES);
  const value = (l.collateral * l.price) / ORACLE_SCALE;
  const ltvWad = value === 0n ? 2n ** 256n - 1n : mulDivUp(debt, WAD, value);
  if (rule.triggerWad === 0n || ltvWad < rule.triggerWad) return { ltvWad, amount: 0n, debt };
  const maxDebt = (value * rule.targetWad) / WAD;
  const guess = debt > maxDebt ? debt - maxDebt : 0n;
  let amount = debtAfter(l, guess) <= maxDebt ? guess : guess + 1n;
  const roundedDown = (l.shares * (l.totalAssets + VIRTUAL_ASSETS)) / (l.totalShares + VIRTUAL_SHARES);
  for (const cap of [roundedDown, allowance, balance]) if (cap < amount) amount = cap;
  return { ltvWad, amount, debt };
}

// Where the loan-to-value lands after repaying `amount` at today's price.
export function ltvAfter(l: LoanState, amount: bigint): bigint {
  const value = (l.collateral * l.price) / ORACLE_SCALE;
  const left = debtAfter(l, amount);
  if (left === 0n) return 0n;
  return value === 0n ? 2n ** 256n - 1n : mulDivUp(left, WAD, value);
}
