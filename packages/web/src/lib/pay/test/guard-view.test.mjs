import { test } from 'node:test';
import assert from 'node:assert/strict';

const { readOwnGuard, guardViewOf, triggerSentence, guardRepayAfterBorrow } = await import('../guardView.ts');

const OWNER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const USDC = '0x3600000000000000000000000000000000000000';
const MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';

test('readOwnGuard: a failed read is unreadable, never "no rule" (C58 fails closed)', async () => {
  const failing = { readContract: async () => { throw new Error('execution reverted'); } };
  assert.deepEqual(await readOwnGuard(failing, OWNER, MARKET, USDC), { state: 'unreadable' });
  const working = {
    readContract: async ({ functionName }) => (functionName === 'ruleOf' ? { triggerWad: 3n * 10n ** 17n, targetWad: 2n * 10n ** 17n, expiry: 0n } : 535_652n),
  };
  const ok = await readOwnGuard(working, OWNER, MARKET, USDC);
  assert.equal(ok.state, 'ok');
  assert.equal(ok.allowance, 535_652n);
  assert.equal(ok.rule.triggerWad, 3n * 10n ** 17n);
});

test('guardViewOf: pending while loading, unreadable after an error with no data', () => {
  assert.deepEqual(guardViewOf({ data: undefined, isPending: true }), { state: 'pending' });
  assert.deepEqual(guardViewOf({ data: undefined, isPending: false }), { state: 'unreadable' });
  assert.deepEqual(guardViewOf({ data: { state: 'unreadable' }, isPending: false }), { state: 'unreadable' });
});

test('guardRepayAfterBorrow: a trip only at or past the trigger, and the sentence names the numbers', () => {
  const base = {
    rule: { triggerWad: 3n * 10n ** 17n, targetWad: 2n * 10n ** 17n, expiry: 0n },
    nowSeconds: 1_800_000_000n,
    before: { shares: 0n, collateral: 0n },
    totals: { totalBorrowAssets: 999_999n, totalBorrowShares: 999_999_000_000n },
    borrow: 380n,
    pledge: 1_000n,
    price: 10n ** 36n,
    allowance: 10_000n,
    balanceAfter: 10_000n,
  };
  assert.equal(guardRepayAfterBorrow({ ...base, ltvAfterWad: 29n * 10n ** 16n }), null);
  const trip = guardRepayAfterBorrow({ ...base, ltvAfterWad: 38n * 10n ** 16n });
  assert.ok(trip && trip.amount > 0n);
  const text = triggerSentence({ ltvAfterWad: 38n * 10n ** 16n, amount: trip.amount, triggerWad: trip.triggerWad, targetWad: trip.targetWad, symbol: 'USDC', who: 'the Safe' });
  assert.match(text, /takes the loan to 38\.00%, at or past your guard's 30\.00% trigger/);
  assert.match(text, /from the Safe within minutes, back to 20\.00%\.$/);
  assert.equal(guardRepayAfterBorrow({ ...base, ltvAfterWad: 38n * 10n ** 16n, rule: { ...base.rule, expiry: 1n } }), null, 'an expired rule never acts');
});
