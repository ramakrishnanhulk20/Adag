import { decodeErrorResult, decodeEventLog, isAddressEqual, toHex, type Abi, type Address, type Hex } from "viem";
import { adagAbi, memoAbi } from "./abi";
import { RATE_LIMIT_WAIT_MS, SIM_MAX_RESPONSE_CHARS, SIM_RPC, SIM_SPACING_MS, SIM_TIMEOUT_MS } from "./constants";

export type Call = { from: Address; to: Address; data: Hex };
export type SimBlock = { time: bigint; overrides?: Record<string, { balance?: Hex; code?: Hex }>; calls: Call[] };
export type SimLog = { address: Address; data: Hex; topics: [Hex, ...Hex[]] };
export type SimResult = { ok: boolean; gas: bigint; returnData: Hex; logs: SimLog[]; revertData: Hex | undefined };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;

const isRateLimit = (status: number, err: { message?: string; code?: unknown } | undefined) =>
  status === 429 || /rate|limit|too many|exceeded/i.test(`${err?.message ?? ""} ${String(err?.code ?? "")}`);

// Spaced 1.5s apart and retried once after 5s on a rate limit, exactly as lib.mjs does, so a run never trips dRPC.
async function drpc(method: string, params: unknown[]): Promise<unknown> {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastCallAt + SIM_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    let status = 0;
    let json: { result?: unknown; error?: { message?: string; code?: unknown } } | null = null;
    try {
      const res = await fetch(SIM_RPC, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        signal: AbortSignal.timeout(SIM_TIMEOUT_MS),
        cache: "no-store",
      });
      status = res.status;
      const text = await res.text();
      if (text.length > SIM_MAX_RESPONSE_CHARS) throw new Error("dRPC answer was too large.");
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
      if (json && !json.error && res.ok) return json.result;
    } catch (e) {
      const name = (e as Error).name;
      throw new Error(`dRPC ${method}: ${name === "TimeoutError" ? `no answer in ${SIM_TIMEOUT_MS / 1000}s` : (e as Error).message.slice(0, 160)}`);
    }
    const err = json?.error ?? { message: `HTTP ${status}` };
    if (attempt === 0 && isRateLimit(status, err)) {
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }
    throw new Error(`dRPC ${method} failed: ${(err.message ?? JSON.stringify(err)).slice(0, 160)}`);
  }
  throw new Error(`dRPC ${method} failed twice.`);
}

export const simChainId = async () => Number(await drpc("eth_chainId", []));

// dRPC's own latest block, so a simulation pinned to it is sure to exist on the node that runs it.
export async function simHead(): Promise<{ number: bigint; timestamp: bigint }> {
  const blk = (await drpc("eth_getBlockByNumber", ["latest", false])) as { number?: string; timestamp?: string } | null;
  if (!blk?.number || !blk.timestamp) throw new Error("dRPC returned no latest block.");
  return { number: BigInt(blk.number), timestamp: BigInt(blk.timestamp) };
}

type RawCall = { status?: string; gasUsed?: string; returnData?: Hex; logs?: SimLog[]; error?: { data?: Hex } };

export async function simulate(blocks: SimBlock[], atBlock: bigint): Promise<SimResult[][]> {
  const blockStateCalls = blocks.map((b) => ({
    blockOverrides: { time: toHex(b.time) },
    calls: b.calls.map((c) => ({ from: c.from, to: c.to, data: c.data })),
    ...(b.overrides && Object.keys(b.overrides).length ? { stateOverrides: b.overrides } : {}),
  }));
  const result = (await drpc("eth_simulateV1", [{ blockStateCalls, validation: false, traceTransfers: false }, toHex(atBlock)])) as
    | { calls?: RawCall[] }[]
    | null;
  if (!Array.isArray(result) || result.length !== blocks.length) throw new Error("eth_simulateV1 returned an unexpected shape.");
  return result.map((blk, i) => {
    if (!Array.isArray(blk.calls) || blk.calls.length !== blocks[i]!.calls.length) throw new Error("eth_simulateV1 returned an unexpected shape.");
    return blk.calls.map((c) => ({
      ok: c.status === "0x1",
      gas: BigInt(c.gasUsed ?? "0x0"),
      returnData: c.returnData ?? "0x",
      logs: Array.isArray(c.logs) ? c.logs : [],
      revertData: c.returnData && c.returnData !== "0x" ? c.returnData : c.error?.data,
    }));
  });
}

const ERROR_ABIS: Abi[] = [adagAbi, memoAbi];

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
