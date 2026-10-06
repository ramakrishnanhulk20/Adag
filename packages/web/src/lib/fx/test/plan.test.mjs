// Covers lib/fx/plan.ts's checkPlan (C65, C66), floorSlack, claimPlan (C74) and conversionUsdcOut (C25). Does NOT cover
// the batch rules in build.ts's assertCalls (build.test.mjs) or the log rule checkEffects (effects.test.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseGwei } from 'viem';
import { C, A, PAYER, ATTACKER, CHAIN_TIME, SIGNATURE, ZERO, planParams, rawExecute, oneInput } from './fixtures.mjs';

const { checkPlan, floorSlack, claimPlan, conversionUsdcOut, encodeExecute, PlanError, EXECUTE_SELECTOR } = await import('../plan.ts');

const AMOUNT_IN = 89_083_698n;
const MIN_OUT = 100_000_000n;
const expected = (over = {}) => ({ account: PAYER, tokenIn: C.EURC, tokenOut: C.USDC, amountIn: AMOUNT_IN, minOut: MIN_OUT, latestBlockTimestamp: CHAIN_TIME, ...over });
const params = (over = {}) => planParams({ tokenIn: C.EURC, tokenOut: C.USDC, amountIn: AMOUNT_IN, minOut: MIN_OUT, ...over });
const good = () => encodeExecute(params(), C.EURC, AMOUNT_IN, SIGNATURE);
// Each refusal must be for the stated reason, so a test cannot pass because something else in the plan was wrong.
const refused = (calldata, reason, e = expected()) => assert.throws(() => checkPlan(calldata, e), (error) => error instanceof PlanError && reason.test(error.message));

test('a plan shaped like Circle’s passes, and comes back decoded', () => {
  const plan = checkPlan(good(), expected());
  assert.equal(plan.tokenInputs.length, 1);
  assert.equal(plan.params.instructions.length, 2);
  assert.equal(plan.signature, SIGNATURE);
  assert.equal(good().slice(0, 10), EXECUTE_SELECTOR);
});

test('C65: trailing bytes on the plan are refused, even all zeros', () => {
  refused(`${good()}00`, /extra or reshaped bytes/);
  refused(`${good()}${'00'.repeat(32)}`, /extra or reshaped bytes/);
});

test('C65: another selector is refused', () => {
  refused(`0x095ea7b3${good().slice(10)}`, /not a call to the adapter/);
  refused(`0x00000000${good().slice(10)}`, /not a call to the adapter/);
});

test('C65: a padding byte changed inside an address word is refused, so the bytes checked are the bytes sent', () => {
  const hex = good();
  const needle = PAYER.slice(2).toLowerCase();
  const at = hex.indexOf(needle);
  assert.ok(at > 24);
  const flipped = `${hex.slice(0, at - 2)}01${hex.slice(at)}`;
  refused(flipped, /extra or reshaped bytes|could not be read/);
});

test('C65: calldata that is not bytes, or is over the size cap, is refused', () => {
  refused('0x', /not a call to the adapter/);
  refused('not hex', /not readable bytes/);
  refused(`${good()}${'00'.repeat(C.PLAN_MAX_CALLDATA_BYTES)}`, /over 24576 bytes/);
});

test('C66: two token inputs are refused', () => {
  const inputs = [...oneInput(C.EURC, AMOUNT_IN), ...oneInput(C.EURC, 1n)];
  refused(rawExecute(params(), inputs), /exactly one token/);
  refused(rawExecute(params(), []), /exactly one token/);
});

test('C66: permit type 1 and permit data are refused', () => {
  refused(rawExecute(params(), [{ permitType: 1, token: C.EURC, amount: AMOUNT_IN, permitCalldata: '0x' }]), /asks for a permit/);
  refused(rawExecute(params(), [{ permitType: 0, token: C.EURC, amount: AMOUNT_IN, permitCalldata: '0x00' }]), /carries permit data/);
});

test('C66: a different token or a different amount in the token input is refused', () => {
  refused(rawExecute(params(), oneInput(C.USDC, AMOUNT_IN)), /different currency/);
  refused(rawExecute(params(), oneInput(C.CIRBTC, AMOUNT_IN)), /different currency/);
  refused(rawExecute(params(), oneInput(C.EURC, AMOUNT_IN + 1n)), /different amount/);
  refused(rawExecute(params(), oneInput(C.EURC, AMOUNT_IN - 1n)), /different amount/);
});

test('C66: a beneficiary that is not the payer is refused, even when only one of them is', () => {
  const p = params();
  refused(rawExecute({ ...p, tokens: [{ token: C.EURC, beneficiary: ATTACKER }, p.tokens[1]] }, oneInput(C.EURC, AMOUNT_IN)), /not your wallet/);
  refused(rawExecute({ ...p, tokens: [p.tokens[0], { token: C.USDC, beneficiary: ATTACKER }] }, oneInput(C.EURC, AMOUNT_IN)), /not your wallet/);
  refused(rawExecute({ ...p, tokens: [{ token: C.USDC, beneficiary: ZERO }] }, oneInput(C.EURC, AMOUNT_IN)), /not your wallet/);
});

test('C66: a plan that does not send the bought currency back to the payer is refused', () => {
  const p = params();
  refused(rawExecute({ ...p, tokens: [p.tokens[0]] }, oneInput(C.EURC, AMOUNT_IN)), /bought currency/);
});

test('C66: a nonzero value on any instruction is refused', () => {
  const p = params();
  for (const at of [0, 1]) {
    const instructions = p.instructions.map((i, j) => (j === at ? { ...i, value: 1n } : i));
    refused(rawExecute({ ...p, instructions }, oneInput(C.EURC, AMOUNT_IN)), /native value/);
  }
});

test('C66: a deadline under 120 seconds from the chain’s timestamp is refused, and exactly 120 passes', () => {
  refused(encodeExecute(params({ deadline: CHAIN_TIME + 119n }), C.EURC, AMOUNT_IN, SIGNATURE), /expires in under 120 seconds/);
  refused(encodeExecute(params({ deadline: CHAIN_TIME - 1n }), C.EURC, AMOUNT_IN, SIGNATURE), /expires in under 120 seconds/);
  checkPlan(encodeExecute(params({ deadline: CHAIN_TIME + 120n }), C.EURC, AMOUNT_IN, SIGNATURE), expected());
  // The clock that counts is the one passed in, never the browser's.
  refused(good(), /expires in under 120 seconds/, expected({ latestBlockTimestamp: CHAIN_TIME + 481n }));
});

test('C66: a minimum below what the payment needs, or on another token, is refused', () => {
  const p = params();
  const low = p.instructions.map((i, j) => (j === 1 ? { ...i, minTokenOut: MIN_OUT - 1n } : i));
  refused(rawExecute({ ...p, instructions: low }, oneInput(C.EURC, AMOUNT_IN)), /does not guarantee at least/);
  const wrongToken = p.instructions.map((i, j) => (j === 1 ? { ...i, tokenOut: C.CIRBTC } : i));
  refused(rawExecute({ ...p, instructions: wrongToken }, oneInput(C.EURC, AMOUNT_IN)), /does not guarantee at least/);
  // The check follows what this payment needs, not what the plan promises.
  refused(good(), /does not guarantee at least/, expected({ minOut: MIN_OUT + 6_261n }));
});

test('C66: too many instructions, or none, is refused', () => {
  const p = params();
  const many = Array.from({ length: C.PLAN_MAX_INSTRUCTIONS + 1 }, () => p.instructions[0]);
  refused(rawExecute({ ...p, instructions: [...many, p.instructions[1]] }, oneInput(C.EURC, AMOUNT_IN)), /steps; Adag accepts 1 to 6/);
  refused(rawExecute({ ...p, instructions: [] }, oneInput(C.EURC, AMOUNT_IN)), /steps; Adag accepts 1 to 6/);
});

test('what the caller expects is itself checked', () => {
  refused(good(), /amount to swap/, expected({ amountIn: 0n }));
  refused(good(), /least the swap may return/, expected({ minOut: 0n }));
  refused(good(), /two different currencies/, expected({ tokenOut: C.EURC }));
  refused(good(), /not a valid address/, expected({ account: 'nope' }));
  refused(good(), /chain time/, expected({ latestBlockTimestamp: 0n }));
});

test('C68, C71: the gas slack is ceil(FX_GAS_CAP x maxFee / 1e12), the one figure the builder and the sender share', () => {
  assert.equal(floorSlack(parseGwei('41')), 102_500n);
  assert.equal(floorSlack(parseGwei('25')), 62_500n);
  assert.equal(floorSlack(20_000_000_001n), 50_001n);
  assert.throws(() => floorSlack(0n), PlanError);
  assert.throws(() => floorSlack(-1n), PlanError);
});

test('C74: a plan’s id can be claimed once, and a second claim is refused', () => {
  assert.equal(claimPlan(0xfeedn), true);
  assert.equal(claimPlan(0xfeedn), false);
  assert.equal(claimPlan(0xfeee00n), true);
});

test('C25: USDC approved to the adapter counts as outflow and only USDC borrowed for it is credited', () => {
  const base = { tokenIn: C.USDC, amountIn: 5_000_000n, borrowedUsdc: 5_000_000n };
  assert.equal(conversionUsdcOut(base), 0n);
  assert.equal(conversionUsdcOut({ ...base, borrowedUsdc: 0n }), 5_000_000n, 'a close sells wallet USDC, borrowed for nothing');
  assert.equal(conversionUsdcOut({ ...base, borrowedUsdc: 4_999_999n }), 1n);
  assert.equal(conversionUsdcOut({ ...base, tokenIn: C.EURC, borrowedUsdc: 0n }), 0n, 'EURC sold counts nothing against USDC');
});
