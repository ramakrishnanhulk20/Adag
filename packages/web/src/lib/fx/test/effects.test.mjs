// Covers lib/fx/plan.ts's checkEffects (C71): one rule over every Transfer log a simulation shows. The logs here are
// written by hand in the shape the node returned for a real run (scripts/check-fx.mjs F9 runs the rule on live logs).
// Does NOT cover the RPC call itself in lib/wallet/send.ts, which needs a wallet and a node.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, PAYER, PAYEE, ATTACKER, TOTAL, builtBill, builtClose, honestLogs, transferLog, nativeLog, billPaidLog } from './fixtures.mjs';

const { checkEffects, PlanError } = await import('../plan.ts');

const conversion = () => builtBill().conversion;
const refused = (logs, reason, c = conversion()) => assert.throws(() => checkEffects(logs, c), (e) => e instanceof PlanError && reason.test(e.message));

test('the logs of an honest run pass: the pledge, the amount sold, the floor, the bill, and its BillPaid', () => {
  const c = conversion();
  checkEffects(honestLogs(c), c);
});

test('the same run with the node’s native-value mirror logs, in either order, passes', () => {
  const c = conversion();
  const logs = honestLogs(c);
  const swapped = [...logs];
  [swapped[3], swapped[4]] = [swapped[4], swapped[3]];
  checkEffects(swapped, c);
  checkEffects(logs.map((l) => (l.address === '0xfffffffffffffffffffffffffffffffffffffffe' ? { ...l, address: '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE' } : l)), c);
});

test('C71: money out of the payer to anyone else is refused, in the sold currency, the bill currency or cirBTC', () => {
  const c = conversion();
  const logs = honestLogs(c);
  refused([...logs, transferLog(C.EURC, PAYER, ATTACKER, 1n)], /not one of your bills/, c);
  refused([...logs, transferLog(C.USDC, PAYER, ATTACKER, 1n)], /not one of your bills/, c);
  refused([...logs, transferLog(C.CIRBTC, PAYER, ATTACKER, 1n)], /not one of your bills/, c);
  refused([...logs, transferLog(C.USDC, PAYER, PAYEE, TOTAL + 1n)], /not one of your bills/, c);
});

test('C71: more than the amount converted to the adapter, or more cirBTC than the pledge to Morpho, is refused', () => {
  const c = conversion();
  const logs = honestLogs(c);
  refused([...logs, transferLog(C.EURC, PAYER, C.CIRCLE_SWAP_ADAPTER, 1n)], /more than the amount being converted/i, c);
  refused([...logs, transferLog(C.CIRBTC, PAYER, C.MORPHO, 1n)], /more cirBTC than the pledge/i, c);
  refused([...logs, transferLog(C.USDC, PAYER, C.CIRCLE_SWAP_ADAPTER, 1n)], /not one of your bills/, c);
});

test('C71: a bill amount to a payee other than the bill’s own, or twice, is refused', () => {
  const c = conversion();
  const logs = honestLogs(c);
  refused(logs.map((l, i) => (i === 4 ? transferLog(C.USDC, PAYER, ATTACKER, TOTAL) : l)), /not one of your bills/, c);
  refused([...logs, transferLog(C.USDC, PAYER, PAYEE, TOTAL)], /not one of your bills/, c);
});

test('C71: the balance check must have run exactly as built, once', () => {
  const c = conversion();
  const logs = honestLogs(c);
  refused(logs.filter((_, i) => i !== 2), /balance check at the end/, c);
  refused([...logs, logs[2]], /balance check at the end/, c);
  refused(logs.map((l, i) => (i === 2 ? transferLog(C.USDC, PAYER, PAYER, c.floor - 1n) : l)), /unexpected transfer/, c);
  refused(logs.map((l, i) => (i === 2 ? transferLog(C.EURC, PAYER, PAYER, c.floor) : l)), /unexpected transfer/, c);
});

test('C71: a bill that would not receive its amount is refused', () => {
  const c = conversion();
  const toPayee = (l) => l.topics.length === 3 && l.topics[2].toLowerCase().endsWith(PAYEE.slice(2).toLowerCase());
  assert.equal(honestLogs(c).filter(toPayee).length, 2, 'the token log and its native mirror');
  refused(honestLogs(c).filter((l) => !toPayee(l)), /would not receive its amount/, c);
});

test('C71, C72: each bill must show a BillPaid from its own contract, for its id, with this payer', () => {
  const c = conversion();
  const without = honestLogs(c).filter((l) => l.address !== C.ADAG_BILLS);
  const logs = honestLogs(c);
  const at = logs.findIndex((l) => l.address === C.ADAG_BILLS);
  const swap = (replacement) => logs.map((l, i) => (i === at ? replacement : l));
  refused(without, /would not show a payment/, c);
  refused(swap(billPaidLog({ contract: C.CIRCLE_SWAP_ADAPTER })), /would not show a payment/, c);
  refused(swap(billPaidLog({ contract: ATTACKER })), /would not show a payment/, c);
  refused(swap(billPaidLog({ id: 8n })), /would not show a payment/, c);
  refused(swap(billPaidLog({ payer: ATTACKER })), /would not show a payment/, c);
  refused(swap(billPaidLog({ contract: C.ADAG_BILLS_FIRST })), /would not show a payment/, c);
});

test('C71: native value leaving the payer with no matching USDC transfer is refused', () => {
  const c = conversion();
  const logs = honestLogs(c);
  refused([...logs, nativeLog(PAYER, ATTACKER, 10n ** 12n)], /Native value would leave/, c);
  refused([...logs, nativeLog(PAYER, PAYEE, TOTAL * 10n ** 12n)], /Native value would leave/, c);
  refused([...logs, nativeLog(PAYER, PAYEE, TOTAL * 10n ** 12n + 1n)], /Native value would leave/, c);
});

test('C71: a Transfer with a fourth topic (an NFT), or data that is not one amount, from the payer is refused', () => {
  const c = conversion();
  const logs = honestLogs(c);
  const nft = { ...transferLog(ATTACKER, PAYER, ATTACKER, 1n), topics: [...transferLog(ATTACKER, PAYER, ATTACKER, 1n).topics, `0x${'00'.repeat(31)}01`], data: '0x' };
  refused([...logs, nft], /plain token amount/, c);
  refused([...logs, { ...transferLog(C.USDC, PAYER, PAYEE, 1n), data: '0x01' }], /plain token amount/, c);
});

test('logs that are about other wallets, and other events, are none of its business', () => {
  const c = conversion();
  const logs = honestLogs(c);
  checkEffects([transferLog(C.EURC, ATTACKER, PAYER, 5n), transferLog(C.USDC, C.MORPHO, PAYER, 7n), { address: C.MEMO, topics: ['0x1234'], data: '0x' }, ...logs], c);
});

test('a malformed log is a refusal to read it, not a pass', () => {
  const c = conversion();
  const bad = { address: 'not an address', topics: honestLogs(c)[0].topics, data: honestLogs(c)[0].data };
  assert.throws(() => checkEffects([bad, ...honestLogs(c)], c));
});

test('C75: a close accepts the amount sold, the repayment to Morpho and the floor, and refuses a bigger repayment', () => {
  const c = builtClose().conversion;
  const logs = [
    transferLog(c.tokenIn, PAYER, C.CIRCLE_SWAP_ADAPTER, c.amountIn),
    transferLog(c.tokenOut, PAYER, PAYER, c.floor),
    transferLog(c.tokenOut, PAYER, C.MORPHO, c.repay.max),
  ];
  checkEffects(logs, c);
  refused([...logs, transferLog(c.tokenOut, PAYER, C.MORPHO, 1n)], /loan repayment/, c);
  refused([...logs, transferLog(c.tokenOut, PAYER, ATTACKER, 1n)], /not one of your bills/, c);
});
