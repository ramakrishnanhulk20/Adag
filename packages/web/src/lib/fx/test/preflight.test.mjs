// Covers lib/fx/preflight.ts and build.ts's buildAdapterReset (C67): what is read before a conversion, what blocks it,
// and the one batch that clears it. Reads are stubbed. Does NOT cover the read-back after a real conversion (check-fx F9).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData } from 'viem';
import { C, A, PAYER, ATTACKER, build } from './fixtures.mjs';

const P = await import('../preflight.ts');

const clear = { allowances: { USDC: 0n, EURC: 0n, cirBTC: 0n }, authorized: false };
const exposed = (over) => ({ ...clear, ...over, allowances: { ...clear.allowances, ...over?.allowances } });

function stubClient(values, { fail = false } = {}) {
  const asked = [];
  return {
    asked,
    readContract: async (args) => {
      asked.push(args);
      if (fail) throw new Error('node said no');
      if (args.functionName === 'isAuthorized') return values.authorized;
      return values[args.address === C.USDC ? 'usdc' : args.address === C.EURC ? 'eurc' : 'btc'];
    },
  };
}

test('with nothing open, a conversion is clear', () => {
  assert.deepEqual(P.adapterPreflight(PAYER, clear, C.EURC), { state: 'clear' });
});

test('C67: an open allowance to the adapter in a token other than the loan currency blocks, with a plain sentence and a reset', () => {
  const out = P.adapterPreflight(PAYER, exposed({ allowances: { USDC: 1n } }), C.EURC);
  assert.equal(out.state, 'blocked');
  assert.equal(out.blockers.length, 1);
  assert.match(out.blockers[0], /can already spend your USDC/);
  assert.equal(out.reset.calls.length, 1);
  assert.deepEqual(decodeFunctionData({ abi: A.erc20Abi, data: out.reset.calls[0].callData }).args, [C.CIRCLE_SWAP_ADAPTER, 0n]);
  assert.equal(out.reset.calls[0].target, C.USDC);
});

test('C67: cirBTC, EURC and the Morpho authorization each block, and one reset clears them all', () => {
  const out = P.adapterPreflight(PAYER, exposed({ allowances: { cirBTC: 5n, EURC: 7n }, authorized: true }), C.USDC);
  assert.equal(out.state, 'blocked');
  assert.equal(out.blockers.length, 3);
  assert.match(out.blockers.join(' '), /cirBTC/);
  assert.match(out.blockers.join(' '), /EURC/);
  assert.match(out.blockers.join(' '), /authorised to act on your Morpho loans/);
  const targets = out.reset.calls.map((c) => c.target);
  assert.deepEqual(targets, [C.EURC, C.CIRBTC, C.MORPHO]);
  const last = decodeFunctionData({ abi: A.morphoAbi, data: out.reset.calls[2].callData });
  assert.equal(last.functionName, 'setAuthorization');
  assert.deepEqual(last.args, [C.CIRCLE_SWAP_ADAPTER, false]);
});

test('the loan currency’s own allowance is not a blocker: the batch overwrites it with exactly the amount sold', () => {
  assert.deepEqual(P.adapterPreflight(PAYER, exposed({ allowances: { EURC: 12345n } }), C.EURC), { state: 'clear' });
  assert.equal(P.adapterPreflight(PAYER, exposed({ allowances: { USDC: 12345n } }), C.EURC).state, 'blocked');
});

test('a read that failed is "unreadable", never clear', async () => {
  assert.equal(P.adapterPreflight(PAYER, null, C.EURC).state, 'unreadable');
  assert.match(P.adapterPreflight(PAYER, null, C.EURC).text, /could not read/);
  assert.equal(await P.readAdapterExposure(stubClient({}, { fail: true }), PAYER), null);
  assert.equal(await P.readAdapterExposure(stubClient({ usdc: 'x', eurc: 0n, btc: 0n, authorized: false }), PAYER), null);
  assert.equal((await P.checkAdapterPreflight(stubClient({}, { fail: true }), PAYER, C.EURC)).state, 'unreadable');
});

test('all three allowances and Morpho’s isAuthorized are read for this payer and this adapter', async () => {
  const c = stubClient({ usdc: 1n, eurc: 2n, btc: 3n, authorized: true });
  assert.deepEqual(await P.readAdapterExposure(c, PAYER), { allowances: { USDC: 1n, EURC: 2n, cirBTC: 3n }, authorized: true });
  assert.equal(c.asked.length, 4);
  for (const a of c.asked.filter((x) => x.functionName === 'allowance')) assert.deepEqual(a.args, [PAYER, C.CIRCLE_SWAP_ADAPTER]);
  const auth = c.asked.find((x) => x.functionName === 'isAuthorized');
  assert.equal(auth.address, C.MORPHO);
  assert.deepEqual(auth.args, [PAYER, C.CIRCLE_SWAP_ADAPTER]);
});

test('C67: after a conversion the read-back must show nothing open, and a failed read-back is not clear', () => {
  assert.equal(P.exposureIsClear(clear), true);
  assert.equal(P.exposureIsClear(exposed({ allowances: { EURC: 1n } })), false);
  assert.equal(P.exposureIsClear(exposed({ authorized: true })), false);
  assert.equal(P.exposureIsClear(null), false);
});

test('the reset batch is zero approvals and one Morpho de-authorisation, and nothing else; it is not a way into a normal batch', () => {
  const reset = build.buildAdapterReset(PAYER, { tokens: [C.USDC, C.EURC, C.CIRBTC], deauthorize: true });
  assert.equal(reset.to, C.MULTICALL3_FROM);
  assert.equal(reset.calls.length, 4);
  for (const c of reset.calls.slice(0, 3)) assert.equal(decodeFunctionData({ abi: A.erc20Abi, data: c.callData }).args[1], 0n);
  // A normal batch may not carry any of it: an approval to the adapter is refused without a conversion.
  assert.throws(() => build.assertCalls(reset.calls), /Refusing an approval to/);
});

test('the reset refuses anything but an approval of the three tokens, each once, and an empty reset', () => {
  assert.throws(() => build.buildAdapterReset(PAYER, { tokens: [ATTACKER], deauthorize: false }), /Only USDC, EURC and cirBTC/);
  assert.throws(() => build.buildAdapterReset(PAYER, { tokens: [C.USDC, C.USDC], deauthorize: false }), /once/);
  assert.throws(() => build.buildAdapterReset(PAYER, { tokens: [], deauthorize: false }), /nothing to reset/);
  assert.throws(() => build.buildAdapterReset('nope', { tokens: [C.USDC], deauthorize: false }), /not a valid address/);
});
