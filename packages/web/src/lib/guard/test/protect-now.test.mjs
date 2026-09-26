import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, parseAbi } from 'viem';

process.env.NEXT_PUBLIC_ADAG_E2E = '1';
process.env.NEXT_PUBLIC_ADAG_GUARD_E2E = '0x00000000000000000000000000000000000Ada60';
const { buildProtectNow, assertProtectNow, GuardBuildError } = await import('../build.ts');

const GUARD = '0x00000000000000000000000000000000000AdA60';
const USDC_MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const EURC_MARKET = '0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4';
const OWNER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const OTHER = '0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B';
const abi = parseAbi(['function protect(address borrower, bytes32 marketId) returns (uint256 repaid)', 'function clearRule(bytes32 marketId)']);
const protect = (borrower, market) => encodeFunctionData({ abi, functionName: 'protect', args: [borrower, market] });

test('Repay it now is one plain call: protect(the signer, a fixed market) on AdagGuard, with no value', () => {
  for (const market of [USDC_MARKET, EURC_MARKET]) {
    const tx = buildProtectNow(OWNER, OWNER.toLowerCase(), market.toUpperCase().replace('0X', '0x'));
    assert.equal(tx.to, GUARD);
    assert.equal(tx.value, 0n);
    const { functionName, args } = decodeFunctionData({ abi, data: tx.data });
    assert.equal(functionName, 'protect');
    assert.equal(args[0], OWNER);
    assert.equal(args[1], market);
  }
});

test('it never sets off another wallet\'s guard, nor a market outside the two', () => {
  assert.throws(() => buildProtectNow(OWNER, OTHER, USDC_MARKET), GuardBuildError);
  assert.throws(() => buildProtectNow(OWNER, OWNER, `0x${'11'.repeat(32)}`), /USDC and EURC markets/);
  assert.throws(() => buildProtectNow('not an address', OWNER, USDC_MARKET), GuardBuildError);
});

test('the assertion refuses every other shape of transaction', () => {
  const good = { to: GUARD, data: protect(OWNER, USDC_MARKET), value: 0n };
  assert.doesNotThrow(() => assertProtectNow(OWNER, good));
  assert.throws(() => assertProtectNow(OWNER, { ...good, to: OTHER }), /instead of AdagGuard/);
  assert.throws(() => assertProtectNow(OWNER, { ...good, value: 1n }), /sends value/);
  assert.throws(() => assertProtectNow(OWNER, { ...good, data: encodeFunctionData({ abi, functionName: 'clearRule', args: [USDC_MARKET] }) }), /other than protect/);
  assert.throws(() => assertProtectNow(OWNER, { ...good, data: `${good.data}00` }), /wrong length/);
  assert.throws(() => assertProtectNow(OWNER, { ...good, data: protect(OTHER, USDC_MARKET) }), /another wallet/);
  assert.throws(() => assertProtectNow(OTHER, good), /another wallet/, 'the signer, not the calldata, decides whose loan');
  assert.throws(() => assertProtectNow(OWNER, { ...good, data: protect(OWNER, `0x${'22'.repeat(32)}`) }), /USDC and EURC markets/);
});
