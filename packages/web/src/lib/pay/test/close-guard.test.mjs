import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, parseAbi, toFunctionSelector } from 'viem';

const { buildCloseLoan, buildEnrol } = await import('../build.ts');
const C = await import('../constants.ts');

const GUARD = '0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806';
const PAYER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const usdc = C.CURRENCIES[0];
const eurc = C.CURRENCIES[1];
const guardAbi = parseAbi(['function clearRule(bytes32 marketId)']);
const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
const position = { shares: 1_000_000n, collateral: 5_000n };

test('a close with a rule ends by clearing that market’s rule and setting the guard’s approval to 0 (C60)', () => {
  const b = buildCloseLoan(PAYER, usdc, position, 2_000n, usdc.params, { hasRule: true, allowance: 535_652n });
  const [clear, zero] = b.calls.slice(-2);
  assert.equal(clear.target.toLowerCase(), GUARD.toLowerCase());
  assert.deepEqual(decodeFunctionData({ abi: guardAbi, data: clear.callData }).args, [usdc.marketId]);
  assert.equal(zero.target, usdc.address);
  assert.deepEqual(decodeFunctionData({ abi: erc20, data: zero.callData }).args, [GUARD, 0n]);
});

test('an approval with no rule is still zeroed, without a clearRule; nothing to stop adds nothing', () => {
  const b = buildCloseLoan(PAYER, eurc, position, 2_000n, eurc.params, { hasRule: false, allowance: 1n });
  assert.equal(b.calls.at(-1).target, eurc.address);
  assert.ok(!b.calls.some((c) => c.target.toLowerCase() === GUARD.toLowerCase()));
  const plain = buildCloseLoan(PAYER, eurc, position, 2_000n, eurc.params);
  assert.ok(!plain.calls.some((c) => c.callData.includes(GUARD.slice(2).toLowerCase())));
});

test('withdraw only also stops the guard', () => {
  const b = buildCloseLoan(PAYER, usdc, { shares: 0n, collateral: 5_000n }, 0n, usdc.params, { hasRule: true, allowance: 0n });
  assert.equal(b.calls.length, 3);
});

test('buildEnrol goes to the current AdagBills only', () => {
  const call = buildEnrol(C.ADAG_BILLS);
  assert.equal(call.to, C.ADAG_BILLS);
  assert.equal(call.data, toFunctionSelector('enrol()'));
  assert.throws(() => buildEnrol(C.ADAG_BILLS_FIRST), /first deployment/);
  assert.throws(() => buildEnrol(GUARD), /not one of Adag/);
});
