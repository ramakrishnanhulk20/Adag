import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics, getAddress, keccak256, parseAbi, toHex } from 'viem';
import { startMockUpstash } from '../../store/test/mock-upstash.mjs';

const { readPaidWith, DIRECT_NOTE, DIRECT_MAX_BILLS, SAFE_MARGIN_BLOCKS } = await import('../paidIndex.ts');
const { createStore } = await import('../../store/upstash.ts');
const { keys } = await import('../../store/keys.ts');
const { LOG_PAGE_BLOCKS } = await import('../constants.ts');

const USDC = '0x3600000000000000000000000000000000000000';
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const addr = (label) => getAddress(`0x${keccak256(toHex(label)).slice(-40)}`);
const CONTRACT = addr('adag under test');
const OTHER = addr('someone else');
const PAYER = addr('payer');
const PAYEE = addr('payee');
const DEPLOY = 1_000n;

const eventAbi = parseAbi(['event BillPaid(uint256 indexed id, address indexed payer, address indexed payee, address currency, uint256 amount, bool loanChecked)']);
const otherEventAbi = parseAbi(['event BillCreated(uint256 indexed id, address indexed payee, address indexed currency, uint256 amount, uint64 due, bytes ref)']);

let txCounter = 0;
function paidLog({ id, block, amount = 1_000_000n, currency = USDC, address = CONTRACT, loanChecked = true, txHash, logIndex = 0 }) {
  return {
    address,
    topics: encodeEventTopics({ abi: eventAbi, eventName: 'BillPaid', args: { id, payer: PAYER, payee: PAYEE } }),
    data: encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }, { type: 'bool' }], [currency, amount, loanChecked]),
    transactionHash: txHash === undefined ? keccak256(toHex(`tx ${txCounter++}`)) : txHash,
    logIndex,
    blockNumber: block,
    removed: false,
  };
}

const mock = await startMockUpstash();
after(() => mock.close());
let namespace = 0;
const freshStore = () => createStore({ url: mock.url, token: mock.token, namespace: `t${namespace++}:` });

// A fake chain: the log reader returns every log in its window whatever the address or topic, so the index's own
// filters are what the tests exercise. Each read waits a little, so concurrent calls really overlap.
function deps({ store, logs, head = DEPLOY + 3n * LOG_PAGE_BLOCKS, delayMs = 15 }) {
  let owner = 0;
  const state = { head, reads: 0 };
  return {
    state,
    deps: {
      store,
      targets: [{ address: CONTRACT, deployBlock: DEPLOY }],
      head: async () => state.head,
      logs: async ({ fromBlock, toBlock }) => {
        state.reads++;
        await new Promise((r) => setTimeout(r, delayMs));
        return logs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock);
      },
      paidLog: async () => [],
      blockTime: async (n) => n * 2n,
      billCount: async () => 0n,
      bills: async () => [],
      owner: () => `owner-${owner++}`,
      now: () => Date.now(),
    },
  };
}

const goodLogs = () => [
  paidLog({ id: 1n, block: DEPLOY + 5n, amount: 1_000_000n }),
  paidLog({ id: 2n, block: DEPLOY + LOG_PAGE_BLOCKS + 7n, amount: 2_500_000n, loanChecked: false }),
  paidLog({ id: 3n, block: DEPLOY + 2n * LOG_PAGE_BLOCKS + 9n, amount: 700_000n, currency: EURC }),
];

test('two calls racing on the same range count each log once', async () => {
  const store = freshStore();
  const logs = goodLogs();
  const a = deps({ store, logs });
  const [one, two] = await Promise.all([readPaidWith(a.deps), readPaidWith(a.deps)]);
  for (const r of [one, two]) assert.ok(r.totals.count <= 3, 'no call may report more logs than exist');
  const settled = await readPaidWith(a.deps);
  assert.equal(settled.source, 'index');
  assert.equal(settled.totals.count, 3);
  assert.equal(settled.totals.usdc, 3_500_000n);
  assert.equal(settled.totals.eurc, 700_000n);
  assert.deepEqual(settled.latest.map((r) => r.id), [3n, 2n, 1n]);
  assert.equal(settled.latest[0].paidAt, (DEPLOY + 2n * LOG_PAGE_BLOCKS + 9n) * 2n);
});

test('even with an expired lease, the write checks the cursor it started from, so a range is never added twice', async () => {
  const real = freshStore();
  // Every lease request succeeds, as if each earlier lease had timed out mid-scan.
  const store = { ...real, set: (key, value, options) => (String(key).includes(':paid:lease:') ? Promise.resolve(true) : real.set(key, value, options)) };
  const a = deps({ store, logs: goodLogs(), delayMs: 25 });
  const both = await Promise.all([readPaidWith(a.deps), readPaidWith(a.deps), readPaidWith(a.deps)]);
  for (const r of both) assert.ok(r.totals.count <= 3);
  const settled = await readPaidWith(a.deps);
  assert.equal(settled.totals.count, 3);
  assert.equal(settled.totals.usdc, 3_500_000n);
});

test('a scan whose starting cursor was moved by another run is dropped, never written over it', async () => {
  const real = freshStore();
  const someoneElse = JSON.stringify({ v: 1, cursor: String(DEPLOY + 5n), usdc: '1000000', eurc: '0', count: 1, latest: [] });
  let indexReads = 0;
  let indexWrites = 0;
  const store = {
    ...real,
    // The first read sees an empty index; the re-read just before writing sees another run's progress.
    get: (key) => (String(key).includes(':paid:index:') ? Promise.resolve(indexReads++ === 0 ? null : someoneElse) : real.get(key)),
    set: (key, value, options) => {
      if (String(key).includes(':paid:index:')) indexWrites++;
      return real.set(key, value, options);
    },
  };
  const r = await readPaidWith(deps({ store, logs: goodLogs() }).deps);
  assert.equal(indexWrites, 0);
  assert.equal(r.throughBlock, DEPLOY + 5n);
  assert.equal(r.totals.count, 1);
});

test('a log from another address, with another topic, or without a transaction hash is skipped', async () => {
  const store = freshStore();
  const created = {
    address: CONTRACT,
    topics: encodeEventTopics({ abi: otherEventAbi, eventName: 'BillCreated', args: { id: 9n, payee: PAYEE, currency: USDC } }),
    data: encodeAbiParameters([{ type: 'uint256' }, { type: 'uint64' }, { type: 'bytes' }], [5_000_000n, 0n, '0x']),
    transactionHash: keccak256(toHex('created')),
    logIndex: 0,
    blockNumber: DEPLOY + 11n,
    removed: false,
  };
  const logs = [
    paidLog({ id: 1n, block: DEPLOY + 5n }),
    paidLog({ id: 7n, block: DEPLOY + 6n, amount: 9_000_000n, address: OTHER }),
    created,
    paidLog({ id: 8n, block: DEPLOY + 12n, amount: 9_000_000n, txHash: null }),
    { ...paidLog({ id: 10n, block: DEPLOY + 13n, amount: 9_000_000n }), removed: true },
  ];
  const r = await readPaidWith(deps({ store, logs }).deps);
  assert.equal(r.totals.count, 1);
  assert.equal(r.totals.usdc, 1_000_000n);
  assert.deepEqual(r.latest.map((x) => x.id), [1n]);
  for (const row of r.latest) assert.equal('reference' in row || 'ref' in row, false, 'a paid row never carries a reference');
});

test('the cursor never moves backwards, even when the RPC reports an older head', async () => {
  const store = freshStore();
  const a = deps({ store, logs: goodLogs() });
  const first = await readPaidWith(a.deps);
  const cursor = first.throughBlock;
  assert.equal(cursor, a.state.head - SAFE_MARGIN_BLOCKS);
  a.state.head = DEPLOY + 10n;
  const second = await readPaidWith(a.deps);
  assert.equal(second.throughBlock, cursor);
  assert.equal(second.totals.count, 3);
  const stored = JSON.parse(mock.raw(`t${namespace - 1}:${keys.paidIndex(CONTRACT)}`));
  assert.equal(BigInt(stored.cursor), cursor);
});

test('each call scans at most LOG_MAX_PAGES windows and resumes where it stopped', async () => {
  const store = freshStore();
  const far = DEPLOY + 45n * LOG_PAGE_BLOCKS;
  const logs = [paidLog({ id: 1n, block: DEPLOY + 1n }), paidLog({ id: 2n, block: far - SAFE_MARGIN_BLOCKS - 5n })];
  const a = deps({ store, logs, head: far, delayMs: 0 });
  const one = await readPaidWith(a.deps);
  assert.equal(a.state.reads, 20);
  assert.equal(one.totals.count, 1);
  assert.equal(one.throughBlock, DEPLOY - 1n + 20n * LOG_PAGE_BLOCKS);
  assert.match(one.note ?? '', /catching up/);
  await readPaidWith(a.deps);
  const three = await readPaidWith(a.deps);
  assert.equal(three.throughBlock, far - SAFE_MARGIN_BLOCKS);
  assert.equal(three.totals.count, 2);
  assert.equal(three.note, null);
});

// C64: one endpoint answers both the head and the logs. It lags the real chain, and like a real lagging node it
// answers a range past its own head with fewer logs and no error.
function laggingEndpoint(store, chainLogs) {
  const node = { head: 0n, failOnWindow: null, windows: 0 };
  const { deps: base } = deps({ store, logs: [], delayMs: 0 });
  return {
    node,
    deps: {
      ...base,
      head: async () => node.head,
      logs: async ({ fromBlock, toBlock }) => {
        node.windows++;
        if (node.failOnWindow !== null && node.windows === node.failOnWindow) throw new Error('the endpoint dropped the request');
        return chainLogs.filter((l) => l.blockNumber >= fromBlock && l.blockNumber <= toBlock && l.blockNumber <= node.head);
      },
    },
  };
}

test('a payment in blocks the endpoint had not reached yet is counted once it catches up, never skipped', async () => {
  const store = freshStore();
  const payAt = DEPLOY + 5_000n;
  const chainLogs = [paidLog({ id: 1n, block: DEPLOY + 10n }), paidLog({ id: 2n, block: payAt, amount: 4_000_000n })];
  const { node, deps: d } = laggingEndpoint(store, chainLogs);
  node.head = payAt - 3n;
  const early = await readPaidWith(d);
  assert.equal(early.totals.count, 1);
  assert.ok(early.throughBlock <= node.head - SAFE_MARGIN_BLOCKS, 'the cursor stays below the lagging head');
  assert.ok(early.throughBlock < payAt, 'the unseen payment block is not marked as scanned');
  node.head = payAt + 200n;
  const later = await readPaidWith(d);
  assert.equal(later.totals.count, 2);
  assert.equal(later.totals.usdc, 5_000_000n);
  assert.equal(later.throughBlock, node.head - SAFE_MARGIN_BLOCKS);
});

test('the cursor never passes the head minus the safety margin', async () => {
  const store = freshStore();
  const { node, deps: d } = laggingEndpoint(store, goodLogs());
  for (const head of [DEPLOY + 5n, DEPLOY + 25n, DEPLOY + 700n, DEPLOY + LOG_PAGE_BLOCKS + 3n, DEPLOY + 3n * LOG_PAGE_BLOCKS]) {
    node.head = head;
    const r = await readPaidWith(d);
    assert.ok(r.throughBlock <= head - SAFE_MARGIN_BLOCKS || r.throughBlock === DEPLOY - 1n, `head ${head}: cursor ${r.throughBlock}`);
  }
});

test('a failure mid-scan keeps the cursor at the last complete window, and the next read counts that window once', async () => {
  const store = freshStore();
  const { node, deps: d } = laggingEndpoint(store, goodLogs());
  node.head = DEPLOY + 3n * LOG_PAGE_BLOCKS + 100n;
  node.failOnWindow = 3;
  const broken = await readPaidWith(d);
  assert.equal(broken.throughBlock, DEPLOY - 1n + 2n * LOG_PAGE_BLOCKS);
  assert.equal(broken.totals.count, 2, 'only the two windows read in full are counted');
  node.failOnWindow = null;
  const mended = await readPaidWith(d);
  assert.equal(mended.totals.count, 3);
  assert.equal(mended.totals.eurc, 700_000n);
  assert.equal(mended.throughBlock, node.head - SAFE_MARGIN_BLOCKS);
});

function directDeps(total, statusOf) {
  const reads = [];
  return {
    reads,
    deps: {
      store: null,
      targets: [{ address: CONTRACT, deployBlock: DEPLOY }],
      head: async () => 50_000n,
      logs: async () => [],
      paidLog: async ({ billId }) => [paidLog({ id: billId, block: 40_000n + billId })],
      blockTime: async (n) => n,
      billCount: async () => total,
      bills: async (_c, ids) => {
        reads.push(ids.length);
        return ids.map((id) => ({ status: statusOf(id), currency: USDC, amount: 1_000_000n, payer: PAYER, payee: PAYEE, paidAt: 1_000n + id }));
      },
      owner: () => 'x',
      now: () => Date.now(),
    },
  };
}

test('direct mode sums only status Paid and says so when a contract has more than 400 bills', async () => {
  const d = directDeps(450n, (id) => (id % 3n === 0n ? 2 : id % 3n === 1n ? 1 : 3));
  const r = await readPaidWith(d.deps);
  assert.equal(r.source, 'direct');
  const paidInWindow = Array.from({ length: DIRECT_MAX_BILLS }, (_, i) => 450n - BigInt(i)).filter((id) => id % 3n === 0n).length;
  assert.equal(r.totals.count, paidInWindow);
  assert.equal(r.totals.usdc, BigInt(paidInWindow) * 1_000_000n);
  assert.equal(r.note, DIRECT_NOTE);
  assert.deepEqual(d.reads, [100, 100, 100, 100]);
  assert.equal(r.latest[0].id, 450n);
  assert.ok(r.latest.length <= 8);
});

test('direct mode under 400 bills reads them all and adds no note', async () => {
  const d = directDeps(5n, (id) => (id === 2n || id === 5n ? 2 : 1));
  const r = await readPaidWith(d.deps);
  assert.equal(r.totals.count, 2);
  assert.equal(r.note, null);
  assert.deepEqual(r.latest.map((x) => x.id), [5n, 2n]);
});
