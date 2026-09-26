import { decodeErrorResult, decodeEventLog, isAddressEqual, toHex, type Abi, type Address, type Hex } from "viem";
import { adagAbi, guardErrorsAbi, memoAbi } from "./abi";
import { SuiteError } from "./errors";
import {
  RATE_LIMIT_WAIT_MS,
  SIM_MAX_RESPONSE_CHARS,
  SIM_RPC,
  SIM_SPACING_MS,
  SIM_TIMED_OUT,
  SIM_TIMEOUT_MS,
  type ProviderName,
} from "./constants";

export type Call = { from: Address; to: Address; data: Hex };
export type SimBlock = { time: bigint; overrides?: Record<string, { balance?: Hex; code?: Hex }>; calls: Call[] };
export type SimLog = { address: Address; data: Hex; topics: [Hex, ...Hex[]] };
export type SimResult = { ok: boolean; gas: bigint; returnData: Hex; logs: SimLog[]; revertData: Hex | undefined };

type Provider = { name: ProviderName; url: string; host: string };

// Server only. The paid endpoint's URL carries its key, so it is read here and nowhere else: only its provider name
// ever leaves this file, and every error text is scrubbed of the URL and host before it is thrown.
function providers(): Provider[] {
  const drpc: Provider = { name: "dRPC's public endpoint", url: SIM_RPC, host: new URL(SIM_RPC).host };
  const raw = process.env.ARC_RPC_URL;
  if (raw) {
    try {
      const u = new URL(raw);
      if (u.protocol === "https:" && u.host !== drpc.host) {
        const name: ProviderName = /(^|\.)quiknode\.pro$/i.test(u.hostname) ? "QuickNode" : "the server's own RPC";
        return [{ name, url: raw, host: u.host }, drpc];
      }
    } catch {
      // Not a URL: fall through to the public endpoint.
    }
  }
  return [drpc];
}

const scrub = (text: string, p: Provider) => text.split(p.url).join(p.name).split(p.host).join(p.name);

const used = new Set<ProviderName>();
export const primaryProvider = (): ProviderName => providers()[0]!.name;
export const startUsage = () => used.clear();
export const providersUsed = (): ProviderName[] => [...used];

class TimedOut extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

const isRateLimit = (status: number, err: { message?: string; code?: unknown } | undefined) =>
  status === 429 || /rate|limit|too many|exceeded/i.test(`${err?.message ?? ""} ${String(err?.code ?? "")}`);
const isTimeout = (status: number, err: { message?: string } | undefined) => status === 408 || status === 504 || /time(d)? ?out/i.test(err?.message ?? "");

// One endpoint: spaced 1.5s apart and retried once after 5s on a rate limit, as lib.mjs does. A timeout is thrown
// as TimedOut so the caller can try again.
async function once(p: Provider, method: string, params: unknown[]): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastCallAt + SIM_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    let status = 0;
    let json: { result?: unknown; error?: { message?: string; code?: unknown } } | null = null;
    try {
      const res = await fetch(p.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(SIM_TIMEOUT_MS),
        cache: "no-store",
      });
      status = res.status;
      const text = await res.text();
      if (text.length > SIM_MAX_RESPONSE_CHARS) throw new SuiteError(`${p.name} sent an answer that was too large.`);
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (json && !json.error && res.ok) {
        used.add(p.name);
        return json.result;
      }
    } catch (e) {
      const name = (e as Error).name;
      if (name === "TimeoutError" || name === "AbortError") throw new TimedOut(`${p.name} ${method}: no answer in ${SIM_TIMEOUT_MS / 1000}s`);
      // C62: the library's own words stay in the server log, scrubbed of the endpoint; the page gets a fixed sentence.
      console.warn(scrub(`[break] ${p.name} ${method}: ${String((e as Error).message).slice(0, 160)}`, p));
      throw new SuiteError(`${p.name} did not answer ${method}, try again`);
    }
    const err = json?.error ?? { message: `HTTP ${status}` };
    if (isTimeout(status, err)) throw new TimedOut(`${p.name} ${method} timed out`);
    if (attempt === 0 && isRateLimit(status, err)) {
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }
    console.warn(scrub(`[break] ${p.name} ${method} refused: ${String(err.message ?? JSON.stringify(err)).slice(0, 160)}`, p));
    throw new SuiteError(`${p.name} refused ${method}, try again`);
  }
  throw new SuiteError(`${p.name} ${method} failed twice.`);
}

// A timed-out call is tried once more on the same endpoint, then once on the other. If that also times out, the
// check says so in plain words; it is never turned into a verdict (C19).
async function rpc(method: string, params: unknown[]): Promise<unknown> {
  const [first, second] = providers();
  const tries: Provider[] = [first!, first!, ...(second ? [second] : [])];
  for (const p of tries) {
    try {
      return await once(p, method, params);
    } catch (e) {
      if (!(e instanceof TimedOut)) throw e;
    }
  }
  throw new SuiteError(SIM_TIMED_OUT);
}

export const simChainId = async () => Number(await rpc("eth_chainId", []));

// The simulating node's own latest block, so a simulation pinned to it is sure to exist on the node that runs it.
export async function simHead(): Promise<{ number: bigint; timestamp: bigint }> {
  const blk = (await rpc("eth_getBlockByNumber", ["latest", false])) as { number?: string; timestamp?: string } | null;
  if (!blk?.number || !blk.timestamp) throw new SuiteError("The simulating node returned no latest block.");
  return { number: BigInt(blk.number), timestamp: BigInt(blk.timestamp) };
}

type RawCall = { status?: string; gasUsed?: string; returnData?: Hex; logs?: SimLog[]; error?: { data?: Hex } };

export async function simulate(blocks: SimBlock[], atBlock: bigint): Promise<SimResult[][]> {
  const blockStateCalls = blocks.map((b) => ({
    blockOverrides: { time: toHex(b.time) },
    calls: b.calls.map((c) => ({ from: c.from, to: c.to, data: c.data })),
    ...(b.overrides && Object.keys(b.overrides).length ? { stateOverrides: b.overrides } : {}),
  }));
  const result = (await rpc("eth_simulateV1", [{ blockStateCalls, validation: false, traceTransfers: false }, toHex(atBlock)])) as
    | { calls?: RawCall[] }[]
    | null;
  if (!Array.isArray(result) || result.length !== blocks.length) throw new SuiteError("eth_simulateV1 returned an unexpected shape.");
  return result.map((blk, i) => {
    if (!Array.isArray(blk.calls) || blk.calls.length !== blocks[i]!.calls.length) throw new SuiteError("eth_simulateV1 returned an unexpected shape.");
    return blk.calls.map((c) => ({
      ok: c.status === "0x1",
      gas: BigInt(c.gasUsed ?? "0x0"),
      returnData: c.returnData ?? "0x",
      logs: Array.isArray(c.logs) ? c.logs : [],
      revertData: c.returnData && c.returnData !== "0x" ? c.returnData : c.error?.data,
    }));
  });
}

const ERROR_ABIS: Abi[] = [adagAbi, guardErrorsAbi, memoAbi];

// Names a revert, unwrapping Memo's MemoFailed so Adag's or Morpho's own reason shows through.
export function decodeRevert(data: Hex | undefined): string {
  if (!data || data === "0x") return "reverted with no reason";
  for (const abi of ERROR_ABIS) {
    try {
      const r = decodeErrorResult({ abi, data });
      const args = (r.args ?? []) as readonly unknown[];
      if (r.errorName === "MemoFailed") return `MemoFailed(${decodeRevert(args[0] as Hex)})`;
      if (r.errorName === "Error") return `"${String(args[0])}"`;
      if (r.errorName === "Panic") return `Panic(0x${(args[0] as bigint).toString(16)})`;
      return `${r.errorName}(${args.map(String).join(", ")})`;
    } catch {}
  }
  return `unknown error ${data.slice(0, 10)}`;
}

// Events are only trusted from the contract that is supposed to emit them (C16).
export function findBillPaid(logs: SimLog[], emitter: Address): { loanChecked: boolean } | null {
  for (const log of logs) {
    if (!isAddressEqual(log.address, emitter)) continue;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics });
      if (ev.eventName === "BillPaid") return { loanChecked: ev.args.loanChecked };
    } catch {}
  }
  return null;
}
