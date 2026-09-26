// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { decodeEventLog, decodeFunctionResult, isAddressEqual, type Address, type Hex } from "viem";
import { keys } from "../store/keys";
import type { Store } from "../store/upstash";
import { guardAbi, protectAbi } from "./abi";
import { buildProtectCall, type ProtectCall } from "./call";
import {
  BACKOFF_SECONDS,
  GAS_HEADROOM_PERCENT,
  HOURLY_FEE_CAP_WEI,
  LEASE_MS,
  MAX_ACTIONS_PER_RUN,
  MAX_SIMULATIONS_PER_RUN,
  MIN_MAX_FEE,
  PRIORITY_FEE,
  RECEIPT_TIMEOUT_MS,
  RUN_BUDGET_MS,
} from "./constants";
import { readHolderPage, readLiveLoans, readMovedFeeds, readQuotes, type KeeperClient, type Quote } from "./read";

// The keeper wallet can only send a ProtectCall (C39); everything else about it lives in wallet.ts.
export type Sender = {
  address: Address;
  send(call: ProtectCall, fees: { gas: bigint; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }): Promise<Hex>;
};

export type Protection = { borrower: Address; market: Hex; repaid: bigint; ltvBeforeWad: bigint; ltvAfterWad: bigint; hash: Hex };
export type Attempt = { market: Hex; outcome: "protected" | "no-op" | "reverted" | "failed" | "fee-cap" | "out-of-time"; hash?: Hex };
export type Counts = { holders: number; total: number; start: number; droppedNoDebt: number; droppedNoAllowance: number; unreadable: number; quoted: number; due: number };

export type RunResult =
  | { state: "busy" }
  | { state: "done"; block: bigint; counts: Counts; attempts: Attempt[]; protections: Protection[]; movedFeeds: Address[] };

type Deps = { client: KeeperClient; store: Store; sender: Sender; guard: Address; now?: () => number; log?: (line: string) => void };

// Fees are counted in units of 1e12 wei (a millionth of a USDC), so an hour's total stays an exact integer in the store.
const FEE_UNIT = 1_000_000_000_000n;

export async function runKeeper({ client, store, sender, guard, now = Date.now, log = () => {} }: Deps): Promise<RunResult> {
  const started = now();
  const owner = `${started}-${Math.random().toString(36).slice(2)}`;
  // Single flight (C42): a second run while this one holds the lease does nothing, and the lease expires on its own.
  if (!(await store.set(keys.lease(), owner, { nx: true, px: LEASE_MS }))) return { state: "busy" };

  try {
    const block = await client.getBlock({ blockTag: "latest" });
    const blockNumber = block.number;

    const saved = await store.get(keys.cursor());
    const cursor = saved && /^[0-9]{1,12}$/.test(saved) ? BigInt(saved) : 0n;
    const page = await readHolderPage(client, guard, cursor, blockNumber);
    await store.set(keys.cursor(), page.next.toString());

    const [movedFeeds, filtered] = await Promise.all([readMovedFeeds(client, blockNumber), readLiveLoans(client, guard, page.holders, blockNumber, true)]);
    const quotes = await readQuotes(client, guard, filtered.loans, blockNumber);

    const due: Quote[] = [];
    for (const quote of quotes.filter((q) => q.wouldAct)) {
      if ((await store.get(keys.backoff(quote.borrower, quote.market))) === null) due.push(quote);
    }
    // Riskiest first among this run's survivors, and only a fixed number simulated; the next run takes the rest.
    due.sort((a, b) => (a.ltvWad === b.ltvWad ? 0 : a.ltvWad > b.ltvWad ? -1 : 1));
    const chosen = due.slice(0, Math.min(MAX_SIMULATIONS_PER_RUN, MAX_ACTIONS_PER_RUN));

    const counts: Counts = {
      holders: page.holders.length,
      total: Number(page.total),
      start: Number(page.start),
      droppedNoDebt: filtered.dropped.noDebt,
      droppedNoAllowance: filtered.dropped.noAllowance,
      unreadable: filtered.dropped.unreadable,
      quoted: quotes.length,
      due: due.length,
    };
    log(`keeper block ${blockNumber}: ${JSON.stringify(counts)}`);

    const attempts: Attempt[] = [];
    const protections: Protection[] = [];
    const backoff = (q: Quote) => store.set(keys.backoff(q.borrower, q.market), "1", { px: BACKOFF_SECONDS * 1000 });
    let capped = false;

    for (const quote of chosen) {
      if (capped) {
        attempts.push({ market: quote.market, outcome: "fee-cap" });
        continue;
      }
      if (now() - started > RUN_BUDGET_MS) {
        attempts.push({ market: quote.market, outcome: "out-of-time" });
        continue;
      }
      const call = buildProtectCall(quote.borrower, quote.market);
      try {
        // Acting only on what protect would do at the latest block (C40): a simulation that repays nothing sends nothing.
        const simulated = await client.call({ account: sender.address, to: call.to, data: call.data, blockTag: "latest" });
        const repaid = simulated.data ? decodeFunctionResult({ abi: protectAbi, functionName: "protect", data: simulated.data }) : 0n;
        if (repaid === 0n) {
          await backoff(quote);
          attempts.push({ market: quote.market, outcome: "no-op" });
          continue;
        }

        const estimate = await client.estimateGas({ account: sender.address, to: call.to, data: call.data, value: 0n });
        const gas = (estimate * GAS_HEADROOM_PERCENT) / 100n;
        const latest = await client.getBlock({ blockTag: "latest" });
        const doubled = (latest.baseFeePerGas ?? 0n) * 2n + PRIORITY_FEE;
        const maxFeePerGas = doubled > MIN_MAX_FEE ? doubled : MIN_MAX_FEE;

        // The worst this can cost is gas times maxFeePerGas; it is reserved against the hour before anything is sent.
        const hour = Math.floor(now() / 3_600_000);
        const units = (gas * maxFeePerGas + FEE_UNIT - 1n) / FEE_UNIT;
        const spent = await store.incrby(keys.feeHour(hour), Number(units), 7_200);
        if (BigInt(spent) * FEE_UNIT > HOURLY_FEE_CAP_WEI) {
          capped = true;
          attempts.push({ market: quote.market, outcome: "fee-cap" });
          continue;
        }

        const hash = await sender.send(call, { gas, maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE });
        const receipt = await client.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
        if (receipt.status !== "success") {
          await backoff(quote);
          attempts.push({ market: quote.market, outcome: "reverted", hash });
          continue;
        }
        for (const entry of receipt.logs) {
          if (!isAddressEqual(entry.address, guard)) continue;
          try {
            const event = decodeEventLog({ abi: guardAbi, eventName: "Protected", data: entry.data, topics: entry.topics });
            const { borrower, marketId, repaid: paid, ltvBeforeWad, ltvAfterWad } = event.args;
            protections.push({ borrower, market: marketId, repaid: paid, ltvBeforeWad, ltvAfterWad, hash });
          } catch {
            // Not a Protected log.
          }
        }
        attempts.push({ market: quote.market, outcome: "protected", hash });
      } catch {
        await backoff(quote);
        attempts.push({ market: quote.market, outcome: "failed" });
      }
    }

    return { state: "done", block: blockNumber, counts, attempts, protections, movedFeeds };
  } finally {
    await store.delIfEquals(keys.lease(), owner).catch(() => false);
  }
}
