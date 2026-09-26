import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';

const { buildSafeEnrol } = await import('../build.ts');
const { assertSafeInnerCalls, decodeMultiSend } = await import('../../safe/multisend.ts');
const C = await import('../constants.ts');

const SAFE = '0x443525A2d5146A8b007754112DC182441cBa92Dc';
const MULTISEND_CALL_ONLY = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const enrol = toFunctionSelector('enrol()');
const pay = encodeFunctionData({ abi: parseAbi(['function pay(uint256 id)']), functionName: 'pay', args: [7n] });

test('the Safe enrol is one plain call to enrol() on the current AdagBills, through MultiSendCallOnly by delegatecall (C55, C51)', () => {
  const b = buildSafeEnrol(SAFE);
  assert.equal(b.to, MULTISEND_CALL_ONLY);
  assert.equal(b.operation, 1);
  assert.equal(b.value, 0n);
  const inner = decodeMultiSend(b.data);
  assert.equal(inner.length, 1);
  assert.equal(inner[0].to, C.ADAG_BILLS);
  assert.equal(inner[0].operation, 0);
  assert.equal(inner[0].value, 0n);
  assert.equal(inner[0].data, enrol);
});

test('enrol is refused next to any other call, and on the first deployment', () => {
  const call = (to, data) => ({ to, value: 0n, data, operation: 0 });
  assert.throws(() => assertSafeInnerCalls(SAFE, [call(C.ADAG_BILLS, enrol), call(C.ADAG_BILLS, pay)]), /alongside/);
  assert.throws(() => assertSafeInnerCalls(SAFE, [call(C.ADAG_BILLS, pay), call(C.ADAG_BILLS, enrol)]), /alongside/);
  assert.throws(() => assertSafeInnerCalls(SAFE, [call(C.ADAG_BILLS_FIRST, enrol)]), /calls/);
  assert.throws(() => assertSafeInnerCalls(SAFE, [call(C.ADAG_BILLS, `${enrol}00`)]), /alongside/);
  assert.throws(() => assertSafeInnerCalls(SAFE, [call(C.ADAG_BILLS, toFunctionSelector('voidBill(uint256)') + '0'.repeat(64))]), /other than paying/);
  assert.doesNotThrow(() => assertSafeInnerCalls(SAFE, [call(C.ADAG_BILLS, pay)]));
});
