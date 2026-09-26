import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, getAddress, keccak256, toHex } from 'viem';
import { startMockUpstash } from '../../store/test/mock-upstash.mjs';

process.env.NEXT_PUBLIC_ADAG_E2E = '1';
process.env.NEXT_PUBLIC_ADAG_GUARD_E2E = '0x00000000000000000000000000000000000Ada60';
const { runKeeper } = await import('../keeper.ts');
const { createStore } = await import('../../store/upstash.ts');
const { FEEDS, HOLDER_PAGE, PAGES_PER_RUN, MAX_SIMULATIONS_PER_RUN } = await import('../constants.ts');

const GUARD = getAddress('0x00000000000000000000000000000000000Ada60');
const USDC_MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const KEEPER = '0x000000000000000000000000000000000000beeF';
const addressOf = (i) => getAddress(`0x${keccak256(toHex(`holder ${i}`)).slice(-40)}`);

const mock = await startMockUpstash();
after(() => mock.close());

// A stand-in for the chain: 1,000 junk holders (a rule, then either no debt or no allowance) and one real one, last.
function fakeChain({ junk, realIndex }) {
  const holders = Array.from({ length: junk + 1 }, (_, i) => (i === realIndex ? addressOf('real') : addressOf(i)));
  const real = holders[realIndex];
  const seen = { simulations: 0, quotes: 0, quotedJunk: 0, positions: 0, allowances: 0 };
  const client = {
    getBlock: async () => ({ number: 1000n, baseFeePerGas: 1n }),
    readContract: async ({ address, functionName, args }) => {
      if (functionName === 'holderCount') return BigInt(holders.length);
      if (functionName === 'holders') return holders.slice(Number(args[0]), Number(args[0] + args[1]));
      if (functionName === 'aggregator') return FEEDS.find((f) => f.proxy === address).aggregator;
      throw new Error(`unexpected read ${functionName}`);
    },
    multicall: async ({ contracts }) =>
      contracts.map(({ functionName, args }) => {
        if (functionName === 'position') {
          seen.positions += 1;
          const [market, who] = args;
          const junkWithDebt = who !== real && holders.indexOf(who) % 2 === 0;
          const debt = market === USDC_MARKET && (who === real || junkWithDebt) ? 1_000n : 0n;
          return { status: 'success', result: [0n, debt, 1n] };
        }
        if (functionName === 'allowance') {
          seen.allowances += 1;
          return { status: 'success', result: args[0] === real ? 1_000_000n : 0n };
        }
        if (functionName === 'quote') {
          seen.quotes += 1;
          if (args[0] !== real) seen.quotedJunk += 1;
          return { status: 'success', result: args[0] === real ? [true, 500n, 620000000000000000n] : [false, 0n, 0n] };
        }
        throw new Error(`unexpected multicall ${functionName}`);
      }),
    call: async () => {
      seen.simulations += 1;
      return { data: encodeAbiParameters([{ type: 'uint256' }], [500n]) };
    },
    estimateGas: async () => 150_000n,
    waitForTransactionReceipt: async () => ({ status: 'success', logs: [] }),
  };
  return { client, seen, real, holders };
}

test('1,000 junk holders cost no quotes and no simulations, and the real holder is reached within one rotation', async () => {
  const { client, seen, real, holders } = fakeChain({ junk: 1000, realIndex: 1000 });
  const store = createStore({ url: mock.url, token: mock.token, namespace: 'test:rotation:' });
  const sent = [];
  const sender = { address: KEEPER, send: async (call) => (sent.push(call), `0x${'ab'.repeat(32)}`) };
  const lines = [];
  const slice = HOLDER_PAGE * PAGES_PER_RUN;
  const rotation = Math.ceil(holders.length / slice);

  let runs = 0;
  while (sent.length === 0 && runs < rotation + 1) {
    const result = await runKeeper({ client, store, sender, guard: GUARD, log: (l) => lines.push(l) });
    assert.equal(result.state, 'done');
    runs += 1;
    if (sent.length === 0) {
      assert.equal(result.counts.quoted, 0, `run ${runs} quoted junk`);
      assert.equal(result.counts.droppedNoDebt + result.counts.droppedNoAllowance, result.counts.holders * 2, 'every junk pair was dropped by the cheap reads');
    }
  }

  assert.equal(runs, rotation, `reached on run ${runs} of a ${rotation}-run rotation`);
  assert.equal(sent.length, 1);
  assert.ok(sent[0].data.toLowerCase().includes(real.slice(2).toLowerCase()), 'the call protects the real holder');
  assert.equal(seen.simulations, 1, 'only the real holder was simulated');
  assert.equal(seen.quotedJunk, 0, 'no junk holder was ever quoted');
  assert.ok(seen.quotes <= 2);
  assert.ok(lines.length === runs && lines.every((l) => !/0x[0-9a-fA-F]{40}/.test(l)), 'the log lines hold counts only');
  const first = JSON.parse(lines[0].slice(lines[0].indexOf('{')));
  assert.equal(first.holders, slice);
  assert.equal(first.droppedNoDebt + first.droppedNoAllowance, slice * 2);
  assert.ok(first.droppedNoAllowance > 0 && first.droppedNoDebt > 0, 'both filters dropped something');
});

test('the cursor wraps, so after the last page the next run starts again from the first', async () => {
  const { client } = fakeChain({ junk: 250, realIndex: 0 });
  const store = createStore({ url: mock.url, token: mock.token, namespace: 'test:wrap:' });
  const sender = { address: KEEPER, send: async () => `0x${'cd'.repeat(32)}` };
  const starts = [];
  for (let i = 0; i < 3; i++) starts.push((await runKeeper({ client, store, sender, guard: GUARD })).counts.start);
  assert.deepEqual(starts, [0, HOLDER_PAGE * PAGES_PER_RUN, 0]);
});

test('a second run while the first holds the lease does nothing', async () => {
  const { client } = fakeChain({ junk: 10, realIndex: 3 });
  const store = createStore({ url: mock.url, token: mock.token, namespace: 'test:lease:' });
  let release;
  const slowSender = { address: KEEPER, send: () => new Promise((r) => (release = () => r(`0x${'ef'.repeat(32)}`))) };
  const first = runKeeper({ client, store, sender: slowSender, guard: GUARD });
  while (!release) await new Promise((r) => setTimeout(r, 5));
  const second = await runKeeper({ client, store, sender: slowSender, guard: GUARD });
  assert.equal(second.state, 'busy');
  release();
  assert.equal((await first).state, 'done');
  assert.ok(MAX_SIMULATIONS_PER_RUN >= 1);
});
