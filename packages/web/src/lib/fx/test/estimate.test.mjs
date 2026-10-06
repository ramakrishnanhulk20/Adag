// Covers lib/fx/estimate.ts (C69, C70): the amount converted, its ceiling, the 96-hour freshness rule, the worst-case
// rate and the one loan-market decision. Reads are served by stub clients. Does NOT cover the screen text (next order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, A, CHAIN_TIME, usdc, eurc, RATE } from './fixtures.mjs';

const E = await import('../estimate.ts');
const { EstimateError } = E;

const price = (answer) => ({ answer, decimals: 8, updatedAt: CHAIN_TIME - 60n });
const two = price(200_000_000n);

test('wanting dollars sells euros at the euro price, wanting euros sells dollars, both rounded up', () => {
  assert.equal(E.amountToSell(100_000_000n, 'USDC', two, 0n), 50_000_000n);
  assert.equal(E.amountToSell(100_000_000n, 'EURC', two, 0n), 200_000_000n);
  assert.equal(E.amountToSell(100_000_000n, 'USDC', two, 150n), 50_750_000n);
  assert.equal(E.amountToSell(100_000_000n, 'EURC', two, 150n), 203_000_000n);
  assert.equal(E.amountToSell(100_000_000n, 'USDC', price(300_000_000n), 0n), 33_333_334n, 'a third of a unit rounds up, never down');
  assert.equal(E.amountToSell(1n, 'EURC', price(100_000_001n), 0n), 2n);
});

test('the amount for a 100 USDC bill at today’s euro price and a 0.4% buffer is what scripts/check-fx.mjs sold on Arc', () => {
  assert.equal(E.amountToSell(100_000_000n, 'USDC', RATE, 40n), 89_083_698n);
});

test('C70: the buffer is a whole number of basis points from 0 to 150, and nothing else', () => {
  E.amountToSell(100_000_000n, 'USDC', two, 0n);
  E.amountToSell(100_000_000n, 'USDC', two, 150n);
  for (const bad of [151n, -1n, 10_000n]) assert.throws(() => E.amountToSell(100_000_000n, 'USDC', two, bad), EstimateError);
  assert.throws(() => E.amountToSell(100_000_000n, 'USDC', two, 1.5), EstimateError);
  assert.throws(() => E.amountToSell(100_000_000n, 'USDC', two, '40'), EstimateError);
});

test('C70: the ceiling is the same amount at the largest buffer, and a smaller buffer sits under it', () => {
  const ceiling = E.maxAmountToSell(100_000_000n, 'USDC', RATE);
  assert.equal(ceiling, E.amountToSell(100_000_000n, 'USDC', RATE, C.MAX_BUFFER_BPS));
  assert.ok(E.amountToSell(100_000_000n, 'USDC', RATE, 149n) <= ceiling);
  assert.ok(E.amountToSell(100_000_000n, 'USDC', RATE, 150n) === ceiling);
});

test('an amount that is zero or negative is refused', () => {
  assert.throws(() => E.amountToSell(0n, 'USDC', two, 40n), EstimateError);
  assert.throws(() => E.amountToSell(-1n, 'EURC', two, 40n), EstimateError);
  assert.throws(() => E.amountToSell(100_000_000n, 'USDC', { ...two, answer: 0n }, 40n), EstimateError);
});

test('C70: the euro price is fresh for exactly 96 hours on Arc’s clock, as AdagBills reads it', () => {
  const at = (age) => ({ answer: 112_703_000n, decimals: 8, updatedAt: CHAIN_TIME - age });
  E.assertEurUsdFresh(at(0n), CHAIN_TIME);
  E.assertEurUsdFresh(at(96n * 3600n), CHAIN_TIME);
  assert.throws(() => E.assertEurUsdFresh(at(96n * 3600n + 1n), CHAIN_TIME), /more than 96 hours old/);
  assert.throws(() => E.assertEurUsdFresh(at(-1n), CHAIN_TIME), /future/);
  assert.throws(() => E.assertEurUsdFresh({ ...at(0n), answer: 0n }, CHAIN_TIME), /not positive/);
  assert.throws(() => E.assertEurUsdFresh({ ...at(0n), answer: -5n }, CHAIN_TIME), /not positive/);
  assert.throws(() => E.assertEurUsdFresh({ ...at(0n), decimals: 37 }, CHAIN_TIME), /scale/);
  assert.throws(() => E.assertEurUsdFresh({ ...at(0n), decimals: 1.5 }, CHAIN_TIME), /scale/);
});

test('the worst-case rate is the bill divided by what is sold, in WAD, rounded down', () => {
  assert.equal(E.worstCaseRate(100_000_000n, 89_083_698n), (100_000_000n * 10n ** 18n) / 89_083_698n);
  assert.equal(E.worstCaseRate(3n, 2n), 1_500_000_000_000_000_000n);
  assert.equal(E.worstCaseRate(1n, 3n), 333_333_333_333_333_333n);
  assert.throws(() => E.worstCaseRate(0n, 5n), EstimateError);
  assert.throws(() => E.worstCaseRate(5n, 0n), EstimateError);
});

test('C69: the loan currency is the other one, decided in one place', () => {
  assert.equal(E.loanCurrencyFor('USDC'), eurc);
  assert.equal(E.loanCurrencyFor('EURC'), usdc);
  assert.equal(E.loanCurrencyFor('USDC').marketId, C.MARKET_EURC);
  assert.equal(E.loanCurrencyFor('EURC').marketId, C.MARKET_USDC);
});

// A client that answers the way viem's would, and records what was asked.
function client({ block = { number: 500n, timestamp: CHAIN_TIME }, updatedAt = CHAIN_TIME - 600n, answer = 112_703_000n, fail = false } = {}) {
  const asked = [];
  return {
    asked,
    getBlock: async () => block,
    readContract: async (args) => {
      asked.push(args);
      if (fail) throw new Error('RPC SECRET http://node.example failed');
      if (args.functionName === 'QUOTE_FEED_1') return '0x00000000000000000000000000000000000f0fed';
      if (args.functionName === 'latestRoundData') return [1n, answer, 0n, updatedAt, 1n];
      if (args.functionName === 'decimals') return 8;
      if (args.functionName === 'priceStatus') return [fail ? false : true, 1n, 2n];
      throw new Error(`unexpected ${args.functionName}`);
    },
  };
}

test('the euro price is read the way AdagBills reads it: the EURC oracle’s QUOTE_FEED_1, then that feed’s latestRoundData, at one block', async () => {
  const c = client();
  const out = await E.readEurUsd(c);
  assert.deepEqual(out.reading, { answer: 112_703_000n, decimals: 8, updatedAt: CHAIN_TIME - 600n });
  assert.equal(out.chainTime, CHAIN_TIME);
  assert.equal(c.asked[0].address, C.EURC_MARKET_ORACLE);
  assert.equal(c.asked[0].functionName, 'QUOTE_FEED_1');
  assert.equal(c.asked[1].address, '0x00000000000000000000000000000000000f0fed');
  assert.ok(c.asked.every((a) => a.blockNumber === 500n));
});

test('C70: a euro feed past the 96-hour window means nothing is offered', async () => {
  await assert.rejects(E.readEurUsd(client({ updatedAt: CHAIN_TIME - 96n * 3600n - 1n })), (e) => e instanceof EstimateError && /96 hours/.test(e.message));
});

test('a failed read is one of our sentences, never the node’s words', async () => {
  await assert.rejects(E.readEurUsd(client({ fail: true })), (e) => e instanceof EstimateError && !/SECRET|node\.example/.test(e.message));
});

test('C69: price status is read for the loan market, and a failed read is not "fresh"', async () => {
  const c = client();
  assert.equal(await E.readLoanPriceFresh(c, C.ADAG_BILLS, 'USDC'), true);
  assert.deepEqual(c.asked[0].args, [C.MARKET_EURC]);
  assert.equal(await E.readLoanPriceFresh(c, C.ADAG_BILLS, 'EURC'), true);
  assert.deepEqual(c.asked[1].args, [C.MARKET_USDC]);
  assert.equal(await E.readLoanPriceFresh(client({ fail: true }), C.ADAG_BILLS, 'USDC'), null);
  assert.equal(await E.readLoanPriceFresh(c, '0x0000000000000000000000000000000000000001', 'USDC'), null, 'only Adag’s own contracts');
});
