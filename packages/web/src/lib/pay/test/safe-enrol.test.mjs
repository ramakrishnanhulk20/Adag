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

const { assertSafeAmounts, AMOUNTS_MISMATCH } = await import('../../safe/multisend.ts');
const { morphoAbi, erc20Abi } = await import('../abi.ts');
const usdc = C.CURRENCIES.find((c) => c.symbol === 'USDC');
const eurc = C.CURRENCIES.find((c) => c.symbol === 'EURC');
const call = (to, data) => ({ to, value: 0n, data, operation: 0 });
const approve = (token, spender, amount) => call(token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }));
const pledge = (params, amount) => call(C.MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: 'supplyCollateral', args: [params, amount, SAFE, '0x'] }));
const borrow = (params, assets, shares = 0n) => call(C.MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: 'borrow', args: [params, assets, shares, SAFE, SAFE] }));
const payBill = (id) => call(C.ADAG_BILLS, encodeFunctionData({ abi: parseAbi(['function pay(uint256 id)']), functionName: 'pay', args: [id] }));

test('C51: a Morpho pledge or borrow on any market but Adag\'s two is refused, one changed field is enough', () => {
  const fake = { ...usdc.params, oracle: '0x000000000000000000000000000000000000dEaD' };
  assert.doesNotThrow(() => assertSafeInnerCalls(SAFE, [pledge(usdc.params, 1000n), borrow(usdc.params, 1n), pledge(eurc.params, 1000n), borrow(eurc.params, 1n)]));
  assert.throws(() => assertSafeInnerCalls(SAFE, [pledge(fake, 1000n)]), /not one of Adag's two/);
  assert.throws(() => assertSafeInnerCalls(SAFE, [borrow(fake, 1n)]), /not one of Adag's two/);
  assert.throws(() => assertSafeInnerCalls(SAFE, [borrow({ ...eurc.params, lltv: eurc.params.lltv + 1n }, 1n)]), /not one of Adag's two/);
});

test('C51 on the server: approvals to AdagBills and borrows must equal the bills as AdagBills records them', () => {
  const bills = new Map([
    [7n, { currency: usdc.address, amount: 1_000_000n }],
    [8n, { currency: usdc.address, amount: 500_000n }],
    [9n, { currency: eurc.address, amount: 250_000n }],
  ]);
  const good = [
    approve(C.CIRBTC, C.MORPHO, 5000n),
    pledge(usdc.params, 5000n),
    borrow(usdc.params, 1_500_000n),
    approve(usdc.address, C.ADAG_BILLS, 1_500_000n),
    approve(eurc.address, C.ADAG_BILLS, 250_000n),
    payBill(7n),
    payBill(8n),
    payBill(9n),
  ];
  assert.doesNotThrow(() => assertSafeAmounts(good, bills));
  const swap = (i, replacement) => good.map((c, j) => (j === i ? replacement : c));
  const refuse = (calls, why) => assert.throws(() => assertSafeAmounts(calls, bills), (e) => e.message === AMOUNTS_MISMATCH, why);
  refuse(swap(3, approve(usdc.address, C.ADAG_BILLS, 1_500_001n)), 'an approval one unit too large');
  refuse(swap(4, approve(eurc.address, C.ADAG_BILLS, 249_999n)), 'an approval one unit too small');
  refuse(swap(2, borrow(usdc.params, 1_500_001n)), 'a borrow one unit too large');
  refuse(swap(2, borrow(usdc.params, 0n, 1n)), 'a borrow by shares');
  refuse([...good, approve(C.CIRBTC, C.ADAG_BILLS, 1n)], 'a token with no bills approved to AdagBills');
  refuse([...good, borrow(eurc.params, 1n)], 'a borrow in the other currency, which is paid from balance here');
  refuse([...good, payBill(10n)], 'a bill that was not read');
});
