// Server only. Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { decodeEventLog, getAbiItem, getAddress, isAddressEqual, toEventSelector, type Address, type Hex } from "viem";
import { DEPLOYMENTS } from "../pay/constants";
import { MULTICALL3 } from "../guard/constants";
import { storeFromEnv } from "../store/env";
import { keys } from "../store/keys";
import type { Store } from "../store/upstash";
import { adagAbi, BILL_STATUS_PAID } from "./abi";
import { arcClient, arcPrimaryClient } from "./client";
import { EURC, LOG_MAX_PAGES, LOG_PAGE_BLOCKS, USDC } from "./constants";

// The landing page's paid figures and its newest payments. They come only from each contract's own BillPaid event
// (C16), never from a bill's reference, so nobody can put words on the home page, and junk bills written for a
// fraction of a cent can neither blank it nor push real payments off it.

export type PaidRow = {
  contract: Address;
  id: bigint;
  currency: Address;
  amount: bigint;
  payer: Address;
  payee: Address;
  txHash: Hex;
  logIndex: number;
  blockNumber: bigint;
  paidAt: bigint;
  loanChecked: boolean;
};

export type PaidRead = {
  source: "index" | "direct";
  throughBlock: bigint;
  totals: { usdc: bigint; eurc: bigint; count: number };
  latest: PaidRow[];
  note: string | null;
};

export type RawLog = {
  address: string;
  topics: readonly Hex[];
  data: Hex;
  transactionHash: Hex | null;
  logIndex: number | null;
  blockNumber: bigint | null;
  removed?: boolean;
};

export type BillRecord = { status: number; currency: Address; amount: bigint; payer: Address; payee: Address; paidAt: bigint };
export type Target = { address: Address; deployBlock: bigint };

export type PaidDeps = {
  store: Store | null;
  targets: readonly Target[];
  head: () => Promise<bigint>;
  logs: (q: { address: Address; fromBlock: bigint; toBlock: bigint }) => Promise<RawLog[]>;
  // Direct mode only: one bill's BillPaid log, searched in bounded windows around the moment it was paid.
  paidLog: (q: { address: Address; billId: bigint; paidAt: bigint; head: bigint }) => Promise<RawLog[]>;
  blockTime: (blockNumber: bigint) => Promise<bigint>;
  billCount: (contract: Address) => Promise<bigint>;
  bills: (contract: Address, ids: readonly bigint[]) => Promise<BillRecord[]>;
  owner: () => string;
  now: () => number;
};

export const LATEST_SIZE = 8;
export const DIRECT_MAX_BILLS = 400;
export const DIRECT_CHUNK = 100;
export const DIRECT_NOTE = `In the newest ${DIRECT_MAX_BILLS} bills of each contract`;
const LEASE_MS = 60_000;
// Well inside the lease, so a slow RPC cannot outlive it while still writing.
const SCAN_BUDGET_MS = 25_000;
// About 10 seconds of Arc blocks: a scan stops this far below the endpoint's own head, so blocks that node has only
// just seen, or not yet fully indexed, are never marked as scanned (C64).
export const SAFE_MARGIN_BLOCKS = 20n;
const BILL_PAID = getAbiItem({ abi: adagAbi, name: "BillPaid" });
const BILL_PAID_TOPIC = toEventSelector(BILL_PAID);
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;

// One deployment's index as stored: the last block fully scanned, the running totals, and the newest rows.
type IndexState = { cursor: bigint; usdc: bigint; eurc: bigint; count: number; latest: PaidRow[] };

const rowKey = (r: PaidRow) => `${r.contract.toLowerCase()}:${r.txHash.toLowerCase()}:${r.logIndex}`;
const newestFirst = (a: PaidRow, b: PaidRow) =>
  a.blockNumber === b.blockNumber ? b.logIndex - a.logIndex : a.blockNumber > b.blockNumber ? -1 : 1;

function mergeLatest(rows: PaidRow[]): PaidRow[] {
  const seen = new Set<string>();
  const out: PaidRow[] = [];
  for (const r of [...rows].sort(newestFirst)) {
    const k = rowKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
    if (out.length === LATEST_SIZE) break;
  }
  return out;
}

// C16: a log counts only if Adag's own contract emitted it, its topic is BillPaid, it names a supported currency,
// and it is tied to a transaction hash and a log index. Anything else is skipped, never guessed at.
export function paidFromLog(log: RawLog, contract: Address): Omit<PaidRow, "paidAt"> | null {
  if (log.removed) return null;
  if (typeof log.address !== "string" || !isAddressEqual(log.address as Address, contract)) return null;
  if (!Array.isArray(log.topics) || log.topics[0]?.toLowerCase() !== BILL_PAID_TOPIC) return null;
  if (typeof log.transactionHash !== "string" || !TX_HASH.test(log.transactionHash)) return null;
  if (typeof log.logIndex !== "number" || !Number.isSafeInteger(log.logIndex) || log.logIndex < 0) return null;
  if (typeof log.blockNumber !== "bigint") return null;
  let ev;
  try {
    ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
  } catch {
    return null;
  }
  if (ev.eventName !== "BillPaid") return null;
  const currency = getAddress(ev.args.currency);
  if (!isAddressEqual(currency, USDC) && !isAddressEqual(currency, EURC)) return null;
  return {
    contract: getAddress(contract),
    id: ev.args.id,
    currency,
    amount: ev.args.amount,
    payer: getAddress(ev.args.payer),
    payee: getAddress(ev.args.payee),
    txHash: log.transactionHash as Hex,
    logIndex: log.logIndex,
    blockNumber: log.blockNumber,
    loanChecked: ev.args.loanChecked,
  };
}

function encodeState(s: IndexState): string {
  return JSON.stringify({
    v: 1,
    cursor: s.cursor.toString(),
    usdc: s.usdc.toString(),
    eurc: s.eurc.toString(),
    count: s.count,
    latest: s.latest.map((r) => ({ ...r, id: r.id.toString(), amount: r.amount.toString(), blockNumber: r.blockNumber.toString(), paidAt: r.paidAt.toString() })),
  });
}

const DIGITS = /^\d{1,78}$/;
const big = (v: unknown): bigint => {
  if (typeof v !== "string" || !DIGITS.test(v)) throw new Error("bad number");
  return BigInt(v);
};
const addr = (v: unknown): Address => {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error("bad address");
  return getAddress(v);
};

// A record that does not parse is thrown away whole and rebuilt from the deploy block, so totals and cursor always
// move together and nothing is ever counted twice.
function decodeState(text: string | null, contract: Address): IndexState | null {
  if (text === null) return null;
  try {
    const raw = JSON.parse(text) as Record<string, unknown>;
    if (raw.v !== 1 || !Array.isArray(raw.latest) || typeof raw.count !== "number" || !Number.isSafeInteger(raw.count) || raw.count < 0) return null;
    const latest = (raw.latest as Record<string, unknown>[]).slice(0, LATEST_SIZE).map((r): PaidRow => {
      if (typeof r.txHash !== "string" || !TX_HASH.test(r.txHash) || typeof r.logIndex !== "number" || typeof r.loanChecked !== "boolean") throw new Error("bad row");
      const row: PaidRow = {
        contract: addr(r.contract),
        id: big(r.id),
        currency: addr(r.currency),
        amount: big(r.amount),
        payer: addr(r.payer),
        payee: addr(r.payee),
        txHash: r.txHash as Hex,
        logIndex: r.logIndex,
        blockNumber: big(r.blockNumber),
        paidAt: big(r.paidAt),
        loanChecked: r.loanChecked,
      };
      if (!isAddressEqual(row.contract, contract)) throw new Error("row from another contract");
      return row;
    });
    return { cursor: big(raw.cursor), usdc: big(raw.usdc), eurc: big(raw.eurc), count: raw.count, latest };
  } catch {
    return null;
  }
}

async function withTimes(rows: Omit<PaidRow, "paidAt">[], deps: PaidDeps): Promise<PaidRow[]> {
  return Promise.all(rows.map(async (r) => ({ ...r, paidAt: await deps.blockTime(r.blockNumber) })));
}

// Moves one deployment's cursor forward by at most LOG_MAX_PAGES windows, under its lease. Whoever does not hold
// the lease reads the record as it stands. The write also checks that the cursor it started from is still the
// stored one, so even a lease that expired mid-scan cannot let two runs add the same logs.
async function advance(target: Target, store: Store, deps: PaidDeps): Promise<IndexState> {
  const indexKey = keys.paidIndex(target.address);
  const leaseKey = keys.paidLease(target.address);
  const fresh = (): IndexState => ({ cursor: target.deployBlock - 1n, usdc: 0n, eurc: 0n, count: 0, latest: [] });
  const owner = deps.owner();

  if (!(await store.set(leaseKey, owner, { nx: true, px: LEASE_MS }))) {
    return decodeState(await store.get(indexKey), target.address) ?? fresh();
  }
  try {
    const start = decodeState(await store.get(indexKey), target.address) ?? fresh();
    // C64: the head and every log below come from one endpoint (deps.head and deps.logs share it), and the scan ends
    // SAFE_MARGIN_BLOCKS below that head. A failed window stops the scan with the cursor at the last complete one.
    const safeHead = (await deps.head()) - SAFE_MARGIN_BLOCKS;
    const began = deps.now();
    let cursor = start.cursor;
    const found: Omit<PaidRow, "paidAt">[] = [];
    const seen = new Set<string>();
    for (let page = 0; page < LOG_MAX_PAGES && cursor < safeHead && deps.now() - began < SCAN_BUDGET_MS; page++) {
      const fromBlock = cursor + 1n;
      const toBlock = fromBlock + LOG_PAGE_BLOCKS - 1n < safeHead ? fromBlock + LOG_PAGE_BLOCKS - 1n : safeHead;
      let logs: RawLog[];
      try {
        logs = await deps.logs({ address: target.address, fromBlock, toBlock });
      } catch {
        break;
      }
      for (const log of logs) {
        const row = paidFromLog(log, target.address);
        if (!row || row.blockNumber < fromBlock || row.blockNumber > toBlock) continue;
        const k = `${row.txHash.toLowerCase()}:${row.logIndex}`;
        if (seen.has(k)) continue;
        seen.add(k);
        found.push(row);
      }
      cursor = toBlock;
    }
    if (cursor === start.cursor) return start;

    const rows = await withTimes(found, deps);
    const next: IndexState = {
      cursor,
      usdc: start.usdc + rows.filter((r) => isAddressEqual(r.currency, USDC)).reduce((t, r) => t + r.amount, 0n),
      eurc: start.eurc + rows.filter((r) => isAddressEqual(r.currency, EURC)).reduce((t, r) => t + r.amount, 0n),
      count: start.count + rows.length,
      latest: mergeLatest([...rows, ...start.latest]),
    };
    const stored = decodeState(await store.get(indexKey), target.address) ?? fresh();
    if (stored.cursor !== start.cursor) return stored;
    await store.set(indexKey, encodeState(next));
    return next;
  } finally {
    await store.delIfEquals(leaseKey, owner).catch(() => false);
  }
}

async function readIndexed(deps: PaidDeps & { store: Store }): Promise<PaidRead> {
  const states = await Promise.all(deps.targets.map((t) => advance(t, deps.store, deps)));
  const throughBlock = states.reduce((low, s) => (s.cursor < low ? s.cursor : low), states[0]!.cursor);
  const head = await deps.head().catch(() => throughBlock);
  return {
    source: "index",
    throughBlock,
    totals: {
      usdc: states.reduce((t, s) => t + s.usdc, 0n),
      eurc: states.reduce((t, s) => t + s.eurc, 0n),
      count: states.reduce((t, s) => t + s.count, 0),
    },
    latest: mergeLatest(states.flatMap((s) => s.latest)),
    // A few blocks behind is normal (the chain moved while this read ran); only a real backlog is worth saying.
    note: throughBlock + LOG_PAGE_BLOCKS < head ? `Still catching up: counted through block ${throughBlock}, and newer payments are added on the next reads.` : null,
  };
}

// No store: read the newest bills straight from each contract, a bounded number per call, and say so when the
// window does not cover every bill.
async function readDirect(deps: PaidDeps): Promise<PaidRead> {
  const head = await deps.head();
  let usdc = 0n;
  let eurc = 0n;
  let count = 0;
  let clipped = false;
  const candidates: { contract: Address; id: bigint; bill: BillRecord }[] = [];

  for (const target of deps.targets) {
    const total = await deps.billCount(target.address);
    if (total > BigInt(DIRECT_MAX_BILLS)) clipped = true;
    const low = total > BigInt(DIRECT_MAX_BILLS) ? total - BigInt(DIRECT_MAX_BILLS) + 1n : 1n;
    for (let top = total; top >= low; top -= BigInt(DIRECT_CHUNK)) {
      const ids: bigint[] = [];
      for (let id = top; id >= low && ids.length < DIRECT_CHUNK; id--) ids.push(id);
      const bills = await deps.bills(target.address, ids);
      bills.forEach((b, i) => {
        if (b.status !== BILL_STATUS_PAID) return;
        if (isAddressEqual(b.currency, USDC)) usdc += b.amount;
        else if (isAddressEqual(b.currency, EURC)) eurc += b.amount;
        else return;
        count++;
        candidates.push({ contract: getAddress(target.address), id: ids[i]!, bill: b });
      });
    }
  }

  // The newest payments by paidAt, each tied to its own BillPaid log before it is shown (C16).
  candidates.sort((a, b) => (a.bill.paidAt === b.bill.paidAt ? (a.id > b.id ? -1 : 1) : a.bill.paidAt > b.bill.paidAt ? -1 : 1));
  const latest: PaidRow[] = [];
  for (const c of candidates.slice(0, LATEST_SIZE)) {
    const logs = await deps.paidLog({ address: c.contract, billId: c.id, paidAt: c.bill.paidAt, head }).catch(() => [] as RawLog[]);
    const row = logs.map((l) => paidFromLog(l, c.contract)).find((r) => r !== null && r.id === c.id) ?? null;
    if (row) latest.push({ ...row, paidAt: c.bill.paidAt });
  }

  return { source: "direct", throughBlock: head, totals: { usdc, eurc, count }, latest: mergeLatest(latest), note: clipped ? DIRECT_NOTE : null };
}

export async function readPaidWith(deps: PaidDeps): Promise<PaidRead> {
  if (!deps.store) return readDirect(deps);
  try {
    return await readIndexed(deps as PaidDeps & { store: Store });
  } catch {
    const direct = await readDirect(deps);
    return { ...direct, note: direct.note ? `${direct.note}. The index store did not answer.` : "The index store did not answer, so this is read straight from Arc." };
  }
}

const blockTimes = new Map<bigint, bigint>();

const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);

// Direct mode only: estimates the block from paidAt and the chain's own pace, then widens outwards window by
// window, never past LOG_MAX_PAGES windows of the RPC's 10,000-block limit (C19).
async function searchPaidLog(address: Address, billId: bigint, paidAt: bigint, head: bigint): Promise<RawLog[]> {
  const deployBlock = DEPLOYMENTS.find((d) => isAddressEqual(d.address, address))?.deployBlock;
  if (deployBlock === undefined || head <= deployBlock) return [];
  const [first, last] = await Promise.all([blockTimeOf(deployBlock), blockTimeOf(head)]);
  const span = last - first;
  const centre = span > 0n ? clamp(deployBlock + ((paidAt - first) * (head - deployBlock)) / span, deployBlock, head) : head;
  const half = LOG_PAGE_BLOCKS / 2n;
  let low = clamp(centre - half, deployBlock, head);
  let high = clamp(centre + half - 1n, deployBlock, head);
  const windows: [bigint, bigint][] = [[low, high]];
  while (windows.length < LOG_MAX_PAGES && (low > deployBlock || high < head)) {
    if (high < head) {
      const from = high + 1n;
      high = clamp(from + LOG_PAGE_BLOCKS - 1n, deployBlock, head);
      windows.push([from, high]);
    }
    if (windows.length < LOG_MAX_PAGES && low > deployBlock) {
      const to = low - 1n;
      low = clamp(to - LOG_PAGE_BLOCKS + 1n, deployBlock, head);
      windows.push([low, to]);
    }
  }
  for (const [fromBlock, toBlock] of windows) {
    const logs = await arcClient.getLogs({ address, event: BILL_PAID, args: { id: billId }, fromBlock, toBlock, strict: true });
    if (logs.length) return logs as unknown as RawLog[];
  }
  return [];
}

async function blockTimeOf(n: bigint): Promise<bigint> {
  const known = blockTimes.get(n);
  if (known !== undefined) return known;
  const t = (await arcClient.getBlock({ blockNumber: n })).timestamp;
  blockTimes.set(n, t);
  return t;
}

export function liveDeps(): PaidDeps {
  return {
    store: storeFromEnv(),
    targets: DEPLOYMENTS.map((d) => ({ address: d.address, deployBlock: d.deployBlock })),
    // One endpoint, no fallback, for both: a lagging node must never supply the logs for a head another node reported.
    head: () => arcPrimaryClient.getBlockNumber({ cacheTime: 0 }),
    logs: async ({ address, fromBlock, toBlock }) =>
      (await arcPrimaryClient.getLogs({ address, event: BILL_PAID, fromBlock, toBlock, strict: true })) as unknown as RawLog[],
    paidLog: ({ address, billId, paidAt, head }) => searchPaidLog(address, billId, paidAt, head),
    blockTime: blockTimeOf,
    billCount: (contract) => arcClient.readContract({ address: contract, abi: adagAbi, functionName: "billCount" }),
    bills: async (contract, ids) => {
      const out = await arcClient.multicall({
        multicallAddress: MULTICALL3,
        allowFailure: false,
        contracts: ids.map((id) => ({ address: contract, abi: adagAbi, functionName: "bill" as const, args: [id] as const })),
      });
      return out.map((b) => ({ status: b.status, currency: getAddress(b.currency), amount: b.amount, payer: getAddress(b.payer), payee: getAddress(b.payee), paidAt: b.paidAt }));
    },
    owner: () => `${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2)}`,
    now: () => Date.now(),
  };
}

// One bill's own BillPaid event, for a page that states facts about that bill (the "Check it yourself" strip).
export async function findBillPaid(contract: Address, billId: bigint, paidAt: bigint): Promise<PaidRow | null> {
  const head = await arcClient.getBlockNumber({ cacheTime: 0 });
  const logs = await searchPaidLog(contract, billId, paidAt, head);
  const row = logs.map((l) => paidFromLog(l, contract)).find((r) => r !== null && r.id === billId) ?? null;
  return row ? { ...row, paidAt } : null;
}

const SHARED_MS = 10_000;
let shared: { at: number; run: Promise<PaidRead> } | null = null;

// /api/live and /api/pledge both need these figures; one read serves both for a few seconds.
export function readPaid(): Promise<PaidRead> {
  if (shared && Date.now() - shared.at < SHARED_MS) return shared.run;
  const run = readPaidWith(liveDeps());
  shared = { at: Date.now(), run };
  run.catch(() => {
    if (shared?.run === run) shared = null;
  });
  return run;
}
