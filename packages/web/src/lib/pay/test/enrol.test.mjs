import { test } from 'node:test';
import assert from 'node:assert/strict';

const { willCheck, overLimit, blockers } = await import('../enrol.ts');

const USDC_MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const EURC_MARKET = '0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4';
// A price that makes the arithmetic easy: 1 satoshi of collateral is worth exactly 1 base unit of the loan token.
const PRICE = 10n ** 36n;
const pos = (shares, collateral) => ({ shares, collateral });

test('willCheck: shares up is checked', () => {
  assert.equal(willCheck(pos(11n, 100n), pos(10n, 100n), false), true);
});

test('willCheck: collateral down is checked', () => {
  assert.equal(willCheck(pos(10n, 99n), pos(10n, 100n), false), true);
});

test('willCheck: both unchanged is not checked, and a smaller loan with more collateral is not either', () => {
  assert.equal(willCheck(pos(10n, 100n), pos(10n, 100n), false), false);
  assert.equal(willCheck(pos(9n, 101n), pos(10n, 100n), false), false);
});

test('willCheck: no borrow shares is never checked, even with collateral gone', () => {
  assert.equal(willCheck(pos(0n, 0n), pos(10n, 100n), false), false);
  assert.equal(willCheck(pos(0n, 50n), pos(0n, 100n), false), false);
});

test('willCheck: a wallet never seen has (0, 0), so any existing loan counts as new', () => {
  assert.equal(willCheck(pos(1n, 1_000n), pos(0n, 0n), false), true);
});

test('willCheck: the market this payment borrows in is always checked', () => {
  assert.equal(willCheck(pos(0n, 0n), pos(0n, 0n), true), true);
  assert.equal(willCheck(pos(10n, 100n), pos(10n, 100n), true), true);
});

test('overLimit: the exact 40% boundary, on both sides', () => {
  // value 1000, max borrow floor(1000 * 0.4) = 400.
  assert.equal(overLimit(400n, 1_000n, PRICE), false);
  assert.equal(overLimit(401n, 1_000n, PRICE), true);
  // Both floors: value floor(999 * p) with p just under 1, then floor(value * 0.4).
  const p = PRICE - 1n;
  // 999 * (1e36 - 1) / 1e36 floors to 998; 998 * 0.4 floors to 399.
  assert.equal(overLimit(399n, 999n, p), false);
  assert.equal(overLimit(400n, 999n, p), true);
  assert.equal(overLimit(1n, 0n, PRICE), true, 'debt against no collateral is over');
  assert.equal(overLimit(0n, 0n, PRICE), false);
});

// With Morpho's virtual amounts added, these totals make a million borrow shares worth one base unit.
const market = (over) => ({
  market: USDC_MARKET, symbol: 'USDC', live: pos(0n, 0n), seen: pos(0n, 0n),
  totalBorrowAssets: 999_999n, totalBorrowShares: 999_999_000_000n, price: PRICE, fresh: true, ...over,
});

test('blockers: an existing loan over 40% that the contract never saw blocks a cash payment', () => {
  // 5e8 shares at a million shares per unit is a debt of 500 against a 400 limit.
  const over = market({ live: pos(500_000_000n, 1_000n) });
  const list = blockers({ markets: [over], borrowsIn: null });
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'over');
  assert.equal(list[0].symbol, 'USDC');
  assert.ok(list[0].ltvWad > 4n * 10n ** 17n);
});

test('blockers: the same loan, once enrolled (seen equals live), blocks nothing', () => {
  const enrolled = market({ live: pos(500_000_000n, 1_000n), seen: pos(500_000_000n, 1_000n) });
  assert.deepEqual(blockers({ markets: [enrolled], borrowsIn: null }), []);
});

test('blockers: a loan under 40% is not a blocker even when it will be checked', () => {
  const under = market({ live: pos(100_000_000n, 1_000n) });
  assert.deepEqual(blockers({ markets: [under], borrowsIn: null }), []);
});

test('blockers: a stale market blocks when its check would run, and not when it would not', () => {
  const stale = market({ market: EURC_MARKET, symbol: 'EURC', live: pos(100_000_000n, 1_000n), fresh: false });
  const list = blockers({ markets: [stale], borrowsIn: null });
  assert.equal(list.length, 1);
  assert.equal(list[0].reason, 'stale');
  const quiet = market({ market: EURC_MARKET, symbol: 'EURC', live: pos(100_000_000n, 1_000n), seen: pos(100_000_000n, 1_000n), fresh: false });
  assert.deepEqual(blockers({ markets: [quiet], borrowsIn: null }), []);
});

test('blockers: the market this payment borrows in is excluded, the other one is still judged', () => {
  const usdc = market({ live: pos(500_000_000n, 1_000n) });
  const eurc = market({ market: EURC_MARKET, symbol: 'EURC', live: pos(500_000_000n, 1_000n) });
  const list = blockers({ markets: [usdc, eurc], borrowsIn: USDC_MARKET });
  assert.deepEqual(list.map((b) => b.symbol), ['EURC']);
  assert.deepEqual(blockers({ markets: [usdc], borrowsIn: USDC_MARKET.toUpperCase().replace('0X', '0x') }), []);
});
