import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseAbi, parseEther } from 'viem';

process.env.NEXT_PUBLIC_ADAG_E2E = '1';
process.env.NEXT_PUBLIC_ADAG_GUARD_E2E = '0x00000000000000000000000000000000000Ada60';
const { buildSaveRule, buildStopRule, ruleProblem, GuardBuildError } = await import('../build.ts');
const { planRepay } = await import('../plan.ts');

const GUARD = '0x00000000000000000000000000000000000AdA60';
const USDC ='0x3600000000000000000000000000000000000000';
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const M3F = '0x522fAf9A91c41c443c66765030741e4AaCe147D0';
const USDC_MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const EURC_MARKET = '0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4';
const OWNER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const LLTV = parseEther('0.86');
const NOW = 1_800_000_000n;
const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const guardAbi = parseAbi(['function setRule(bytes32 marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry)', 'function clearRule(bytes32 marketId)']);
const rule = (over = {}) => ({ market: USDC_MARKET, triggerWad: parseEther('0.55'), targetWad: parseEther('0.45'), expiry: 0n, ...over });

test('save is one Multicall3From batch: approve exactly the typed amount to AdagGuard, then setRule', () => {
  const b = buildSaveRule(OWNER, rule(), 250_000_000n, LLTV, NOW);
  assert.equal(b.to, M3F);
  assert.equal(b.calls.length, 2);
  assert.equal(b.calls[0].target, USDC);
  assert.deepEqual(decodeFunctionData({ abi: erc20, data: b.calls[0].callData }).args, [GUARD, 250_000_000n]);
  assert.equal(b.calls[1].target.toLowerCase(), GUARD.toLowerCase());
  assert.deepEqual(decodeFunctionData({ abi: guardAbi, data: b.calls[1].callData }).args, [USDC_MARKET, parseEther('0.55'), parseEther('0.45'), 0n]);
  assert.ok(b.calls.every((c) => c.allowFailure === false));
  const eurc = buildSaveRule(OWNER, rule({ market: EURC_MARKET }), 1n, LLTV, NOW);
  assert.equal(eurc.calls[0].target, EURC, 'the approval is in the market’s own loan token');
});

test('no unlimited, zero or absurd approval is ever built (C38)', () => {
  for (const amount of [0n, -1n, 2n ** 256n - 1n, 10n ** 16n]) assert.throws(() => buildSaveRule(OWNER, rule(), amount, LLTV, NOW), GuardBuildError, String(amount));
});

test('the rule is checked like setRule before anything is built (C41)', () => {
  assert.match(ruleProblem(rule({ targetWad: 0n }), LLTV, NOW), /above 0%/);
  assert.match(ruleProblem(rule({ targetWad: parseEther('0.55') }), LLTV, NOW), /below the trigger/);
  assert.match(ruleProblem(rule({ triggerWad: LLTV }), LLTV, NOW), /liquidation line/);
  assert.match(ruleProblem(rule({ expiry: NOW }), LLTV, NOW), /future/);
  assert.equal(ruleProblem(rule({ expiry: NOW + 1n }), LLTV, NOW), null);
  assert.throws(() => buildSaveRule(OWNER, rule({ market: '0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566' }), 1n, LLTV, NOW), GuardBuildError);
});

test('stop clears the rule and sets the approval to 0 in the same batch (C60)', () => {
  const b = buildStopRule(OWNER, USDC_MARKET, true);
  assert.equal(b.calls.length, 2);
  assert.deepEqual(decodeFunctionData({ abi: guardAbi, data: b.calls[0].callData }).args, [USDC_MARKET]);
  assert.deepEqual(decodeFunctionData({ abi: erc20, data: b.calls[1].callData }).args, [GUARD, 0n]);
  const only = buildStopRule(OWNER, USDC_MARKET, false);
  assert.equal(only.calls.length, 1, 'with no rule left, only the approval is reset');
});

test('the preview uses the guard arithmetic: repays down to the target, capped by approval and balance', () => {
  const loan = { shares: 62_000_000n * 1_000_000n, totalAssets: 1_000_000_000_000n, totalShares: 1_000_000_000_000n * 1_000_000n, collateral: 1_000_000n, price: 10n ** 38n };
  const full = planRepay(loan, { triggerWad: parseEther('0.55'), targetWad: parseEther('0.45') }, 10n ** 12n, 10n ** 12n);
  assert.ok(full.ltvWad > parseEther('0.55'));
  assert.ok(full.amount > 16_000_000n && full.amount < 18_000_000n, String(full.amount));
  assert.equal(planRepay(loan, { triggerWad: parseEther('0.55'), targetWad: parseEther('0.45') }, 5n, 10n ** 12n).amount, 5n);
  assert.equal(planRepay(loan, { triggerWad: parseEther('0.70'), targetWad: parseEther('0.45') }, 10n ** 12n, 10n ** 12n).amount, 0n);
});
