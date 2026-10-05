import { test } from 'node:test';
import assert from 'node:assert/strict';

const { readyToLend, lendCovers } = await import('../lend.ts');

// [totalSupplyAssets, totalSupplyShares, totalBorrowAssets, totalBorrowShares, lastUpdate, fee]
const market = (supply, borrow) => [supply, supply * 1_000_000n, borrow, borrow * 1_000_000n, 1_800_000_000n, 0n];

test('readyToLend: supply minus borrow is the free cash', () => {
  assert.equal(readyToLend(market(5_000_000n, 3_250_000n)), 1_750_000n);
});

test('lendCovers: exactly equal to the amount covers it', () => {
  const ready = readyToLend(market(5_000_000n, 3_250_000n));
  assert.equal(lendCovers(ready, 1_750_000n), true);
});

test('lendCovers: one unit short does not cover it', () => {
  const ready = readyToLend(market(5_000_000n, 3_250_000n));
  assert.equal(lendCovers(ready, 1_750_001n), false);
});

test('readyToLend: borrow above supply is zero, never negative', () => {
  assert.equal(readyToLend(market(1_000_000n, 1_000_001n)), 0n);
  assert.equal(readyToLend(market(0n, 0n)), 0n);
});

test('lendCovers: an amount of zero is always covered, even by an empty market', () => {
  assert.equal(lendCovers(0n, 0n), true);
  assert.equal(lendCovers(readyToLend(market(1_000_000n, 1_000_000n)), 0n), true);
});
