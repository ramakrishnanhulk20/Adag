import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, parseAbi, toFunctionSelector } from 'viem';

// The guard address is fixed at build time; here the end-to-end override stands in for the deployed one.
process.env.NEXT_PUBLIC_ADAG_E2E = '1';
process.env.NEXT_PUBLIC_ADAG_GUARD_E2E = '0x00000000000000000000000000000000000Ada60';
const { buildProtectCall, assertProtectCall, CallError } = await import('../call.ts');
const constants = await import('../constants.ts');
const callModule = await import('../call.ts');

const GUARD = '0x00000000000000000000000000000000000Ada60';
const USDC_MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const EURC_MARKET = '0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4';
const BORROWER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const protectAbi = parseAbi(['function protect(address borrower, bytes32 marketId) returns (uint256 repaid)']);

test('the builder makes protect(borrower, market) to AdagGuard with zero value, and nothing else', () => {
  for (const market of [USDC_MARKET, EURC_MARKET, USDC_MARKET.toUpperCase().replace('0X', '0x')]) {
    const call = buildProtectCall(BORROWER.toLowerCase(), market);
    assert.equal(call.to, constants.ADAG_GUARD);
    assert.equal(call.to.toLowerCase(), GUARD.toLowerCase());
    assert.equal(call.value, 0n);
    assert.equal(call.data.slice(0, 10), toFunctionSelector('protect(address,bytes32)'));
    const { functionName, args } = decodeFunctionData({ abi: protectAbi, data: call.data });
    assert.equal(functionName, 'protect');
    assert.deepEqual(args, [BORROWER, market.toLowerCase()]);
    assert.ok(Object.isFrozen(call));
  }
});

test('the module can only build protect: it exports no other builder, and takes no target, selector or value', () => {
  assert.deepEqual(Object.keys(callModule).sort(), ['CallError', 'assertProtectCall', 'buildProtectCall']);
  assert.equal(buildProtectCall.length, 2, 'two parameters: borrower and market');
  const call = buildProtectCall(BORROWER, USDC_MARKET, '0x000000000000000000000000000000000000dEaD', 5n, '0xa9059cbb');
  assert.equal(call.to, constants.ADAG_GUARD, 'extra arguments cannot move the target');
  assert.equal(call.value, 0n);
  assert.equal(call.data.slice(0, 10), toFunctionSelector('protect(address,bytes32)'));
});

test('any other market, a zero or malformed borrower is refused', () => {
  for (const market of ['0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566', '0x' + '00'.repeat(32), 'USDC', undefined, 1]) {
    assert.throws(() => buildProtectCall(BORROWER, market), CallError, String(market));
  }
  for (const borrower of ['0x0000000000000000000000000000000000000000', '0x1234', '', null, 7]) {
    assert.throws(() => buildProtectCall(borrower, USDC_MARKET), CallError, String(borrower));
  }
});

test('a call reshaped after building is caught again before signing', () => {
  const good = buildProtectCall(BORROWER, USDC_MARKET);
  const transfer = encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256)']), functionName: 'transfer', args: [BORROWER, 1n] });
  const otherMarket = encodeFunctionData({ abi: protectAbi, functionName: 'protect', args: [BORROWER, '0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566'] });
  const cases = [
    { ...good, to: '0x000000000000000000000000000000000000dEaD' },
    { ...good, value: 1n },
    { ...good, data: transfer },
    { ...good, data: otherMarket },
    { ...good, data: `${good.data}00` },
    { ...good, data: `${good.data.slice(0, 10)}` },
  ];
  for (const bad of cases) assert.throws(() => assertProtectCall(bad), CallError);
  assert.doesNotThrow(() => assertProtectCall(good));
});
