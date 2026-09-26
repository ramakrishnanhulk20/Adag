import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, parseAbi } from 'viem';

const { assertSafeAmounts, AMOUNTS_MISMATCH } = await import('../../safe/multisend.ts');
const { morphoAbi, erc20Abi } = await import('../../pay/abi.ts');
const C = await import('../../pay/constants.ts');

const SAFE = '0x443525A2d5146A8b007754112DC182441cBa92Dc';
const usdc = C.CURRENCIES.find((c) => c.symbol === 'USDC');
const eurc = C.CURRENCIES.find((c) => c.symbol === 'EURC');
const call = (to, data) => ({ to, value: 0n, data, operation: 0 });
const approve = (token, spender, amount) => call(token, encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [spender, amount] }));
const pledge = (params, amount) => call(C.MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: 'supplyCollateral', args: [params, amount, SAFE, '0x'] }));
const borrow = (params, assets) => call(C.MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: 'borrow', args: [params, assets, 0n, SAFE, SAFE] }));
const payBill = (id) => call(C.ADAG_BILLS, encodeFunctionData({ abi: parseAbi(['function pay(uint256 id)']), functionName: 'pay', args: [id] }));

const bills = new Map([
  [7n, { currency: usdc.address, amount: 1_000_000n }],
  [9n, { currency: eurc.address, amount: 250_000n }],
]);
// The builder's shape with both currencies paid from bitcoin: approve cirBTC, pledge, borrow, per currency.
const good = [
  approve(C.CIRBTC, C.MORPHO, 5000n),
  pledge(usdc.params, 5000n),
  borrow(usdc.params, 1_000_000n),
  approve(C.CIRBTC, C.MORPHO, 3000n),
  pledge(eurc.params, 3000n),
  borrow(eurc.params, 250_000n),
  approve(usdc.address, C.ADAG_BILLS, 1_000_000n),
  approve(eurc.address, C.ADAG_BILLS, 250_000n),
  payBill(7n),
  payBill(9n),
];
const swap = (i, replacement) => good.map((c, j) => (j === i ? replacement : c));
const refuse = (calls, why) => assert.throws(() => assertSafeAmounts(calls, bills), (e) => e.message === AMOUNTS_MISMATCH, why);

test('C51: the cirBTC approval to Morpho equals the pledge it is spent on, in the same batch', () => {
  assert.doesNotThrow(() => assertSafeAmounts(good, bills));
  refuse(swap(0, approve(C.CIRBTC, C.MORPHO, 5001n)), 'an approval one unit larger than the pledge');
  refuse(swap(0, approve(C.CIRBTC, C.MORPHO, 4999n)), 'an approval one unit smaller than the pledge');
  refuse(swap(4, pledge(eurc.params, 3001n)), 'a pledge one unit larger than its approval');
});

test('no cirBTC approval is left standing, overwritten, or missing', () => {
  refuse([approve(C.CIRBTC, C.MORPHO, 1n), ...good], 'an extra approval with no pledge after it');
  refuse([...good, approve(C.CIRBTC, C.MORPHO, 1n)], 'an approval left standing at the end');
  refuse(good.filter((_, i) => i !== 3), 'a second pledge with no approval of its own');
  refuse([good[0], good[3], good[1], good[4], ...good.slice(5)].concat([good[2]]), 'two approvals before either pledge');
});

test('a batch that pays from balance only needs no cirBTC approval at all', () => {
  assert.doesNotThrow(() => assertSafeAmounts([approve(usdc.address, C.ADAG_BILLS, 1_000_000n), payBill(7n)], new Map([[7n, bills.get(7n)]])));
});
