// Covers lib/wallet/send.ts's pure decisions: what a failed transfer trace means for the signature (C71), and which batches
// the adapter reset may send (C67). The reset sender is also called with a bad batch and with no wallet connected, to show
// it refuses before any wallet or node is touched.
// Does NOT cover a real wallet or node (scripts/e2e.mjs drives those) or the conversion path's other gates.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData } from 'viem';
import { A, C, PAYER, ATTACKER } from './fixtures.mjs';

const { simulationVerdict, EFFECTS_UNAVAILABLE, assertAdapterReset, sendAdapterReset } = await import('../../wallet/send.ts');
const { buildAdapterReset, decodeBatch } = await import('../../pay/build.ts');

test('the sentence for a conversion that could not be double-checked is the fixed one', () => {
  assert.equal(EFFECTS_UNAVAILABLE, 'We could not double-check this conversion just now. Nothing was sent. Try again in a minute.');
});

test('C71: a node with no trace, an unreachable node and a timeout each mean "no answer"', () => {
  const noAnswer = [
    { code: -32601, message: 'Method not found' },
    { code: -32004, message: 'Method not supported' },
    { name: 'HttpRequestError', message: 'HTTP request failed.' },
    { name: 'TimeoutError', message: 'The request timed out.' },
    { message: 'wrapped', cause: { message: 'the method eth_simulateV1 does not exist' } },
    { message: 'wrapped', cause: { cause: { name: 'TimeoutError' } } },
  ];
  for (const error of noAnswer) {
    assert.equal(simulationVerdict(error, true), 'refuse', JSON.stringify(error));
    assert.equal(simulationVerdict(error, false), 'go on unchecked', JSON.stringify(error));
  }
});

test('C71: a node that ran the batch and found it failing gave an answer, whether or not the check is required', () => {
  const reverted = [{ name: 'ContractFunctionRevertedError', message: 'execution reverted' }, { code: 3, message: 'execution reverted: 0x1234' }, new Error('anything else')];
  for (const error of reverted) {
    assert.equal(simulationVerdict(error, true), 'revert');
    assert.equal(simulationVerdict(error, false), 'revert');
  }
});

const multicall = (calls) => encodeFunctionData({ abi: A.multicall3FromAbi, functionName: 'aggregate3', args: [calls] });
const approve = (token, spender, amount) => ({ target: token, allowFailure: false, callData: encodeFunctionData({ abi: A.erc20Abi, functionName: 'approve', args: [spender, amount] }) });
const deauthorize = { target: C.MORPHO, allowFailure: false, callData: encodeFunctionData({ abi: A.morphoAbi, functionName: 'setAuthorization', args: [C.CIRCLE_SWAP_ADAPTER, false] }) };
const zero = (token) => approve(token, C.CIRCLE_SWAP_ADAPTER, 0n);

test('C67: the reset the builder writes, with all three approvals and the authorisation, is allowed', () => {
  const full = buildAdapterReset(PAYER, { tokens: [C.USDC, C.EURC, C.CIRBTC], deauthorize: true });
  assertAdapterReset(full.to, full.data);
  const one = buildAdapterReset(PAYER, { tokens: [C.EURC], deauthorize: false });
  assertAdapterReset(one.to, one.data);
  const authOnly = buildAdapterReset(PAYER, { tokens: [], deauthorize: true });
  assertAdapterReset(authOnly.to, authOnly.data);
});

test('C67: a batch with anything beyond the reset is refused, each way tried', () => {
  const good = [zero(C.USDC), deauthorize];
  const bad = {
    'an approval above 0': [approve(C.USDC, C.CIRCLE_SWAP_ADAPTER, 1n)],
    'an approval to another spender': [approve(C.USDC, ATTACKER, 0n)],
    'an approval to the bill contract': [approve(C.USDC, C.ADAG_BILLS, 0n)],
    'a reset plus a transfer': [...good, { target: C.USDC, allowFailure: false, callData: encodeFunctionData({ abi: A.erc20Abi, functionName: 'transfer', args: [ATTACKER, 1n] }) }],
    'a reset plus a payment': [...good, approve(C.USDC, C.ADAG_BILLS, 5n)],
    'the authorisation switched on': [{ ...deauthorize, callData: encodeFunctionData({ abi: A.morphoAbi, functionName: 'setAuthorization', args: [C.CIRCLE_SWAP_ADAPTER, true] }) }],
    'the authorisation of another address': [{ ...deauthorize, callData: encodeFunctionData({ abi: A.morphoAbi, functionName: 'setAuthorization', args: [ATTACKER, false] }) }],
    'a call to the adapter': [{ target: C.CIRCLE_SWAP_ADAPTER, allowFailure: false, callData: '0x12345678' }],
    'an approval that is allowed to fail': [{ ...zero(C.USDC), allowFailure: true }],
    'the same approval twice': [zero(C.USDC), zero(C.USDC)],
    'a zero approval on a token that is not one of the three': [approve(C.MEMO, C.CIRCLE_SWAP_ADAPTER, 0n)],
    'trailing bytes after the approval': [{ ...zero(C.USDC), callData: `${zero(C.USDC).callData}00` }],
    'no calls at all': [],
    'five calls': [zero(C.USDC), zero(C.EURC), zero(C.CIRBTC), deauthorize, deauthorize],
    'a batch inside the batch': [{ target: C.MULTICALL3_FROM, allowFailure: false, callData: multicall([zero(C.USDC)]) }],
  };
  for (const [name, calls] of Object.entries(bad)) {
    assert.throws(() => assertAdapterReset(C.MULTICALL3_FROM, multicall(calls)), /does not allow|not a batch/, name);
  }
  assert.throws(() => assertAdapterReset(C.MEMO, multicall(good)), /Multicall3From/, 'sent to another contract');
  assert.throws(() => assertAdapterReset(C.MULTICALL3_FROM, `${multicall(good)}00`), /not a batch/, 'bytes after the batch');
  assert.throws(() => assertAdapterReset(C.MULTICALL3_FROM, '0x095ea7b3'), /not a batch/, 'not a batch at all');
  assert.ok(decodeBatch(multicall(good)), 'the good batch above does decode, so the refusals are about what is inside');
});

test('C67: the reset sender refuses a bad batch before it looks at any wallet or node, and a good one with no wallet', async () => {
  const sneaky = multicall([zero(C.USDC), approve(C.USDC, C.ADAG_BILLS, 5n)]);
  const refused = await sendAdapterReset({ account: PAYER, to: C.MULTICALL3_FROM, data: sneaky });
  assert.equal(refused.ok, false);
  assert.equal(refused.stage, 'refused');
  assert.match(refused.error.text, /Nothing was sent\./);

  const good = buildAdapterReset(PAYER, { tokens: [C.USDC], deauthorize: true });
  const steps = [];
  const noWallet = await sendAdapterReset({ account: PAYER, to: good.to, data: good.data, onStep: (s) => steps.push(s) });
  assert.equal(noWallet.ok, false);
  assert.equal(noWallet.stage, 'failed');
  assert.match(noWallet.message, /not on Arc mainnet with this address/);
  assert.deepEqual(steps, ['checking'], 'it stopped at the wallet gate, before signing');
});
