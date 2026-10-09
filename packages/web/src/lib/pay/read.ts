import type { PublicClient } from "viem";
import { arcClient } from "../arc/client";
import { adagAbi } from "./abi";
import { BILL_STATUS, CHAIN_ID, DEPLOYMENTS, requireDeployment } from "./constants";
import { billFromRecord, type Bill } from "./build";
import type { BillRef } from "./billId";
import { searchBillPaid, type PaidTx } from "./paidTx";

export type { PaidTx } from "./paidTx";

export type BillRead =
  | { kind: "found"; bill: Bill }
  | { kind: "none" }
  | { kind: "unavailable"; reason: string };

// C62: only a sentence this code wrote reaches the page. viem wraps every RPC failure in its own error type, whose
// text can hold a node's words, so those become a fixed sentence and their short message goes to the log instead.
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.constructor === Error && !("shortMessage" in error)) return error.message.split("\n")[0]!.slice(0, 160);
  const e = error as { shortMessage?: string; name?: string } | undefined;
  console.warn(`Arc read failed: ${e?.shortMessage ?? e?.name ?? "unknown"}`);
  return "Arc did not answer. Try again in a moment.";
}

async function onArc() {
  const id = await arcClient.getChainId();
  if (id !== CHAIN_ID) throw new Error(`The RPC answered for chain ${id}, not Arc mainnet.`);
}

// C19: an RPC failure is "unavailable", never "no such bill" and never "unpaid". C33: the read goes to the contract
// the parser named, and the Bill carries it on.
export async function readBill(ref: BillRef): Promise<BillRead> {
  try {
    const { address } = requireDeployment(ref.contract);
    const [, b] = await Promise.all([onArc(), arcClient.readContract({ address, abi: adagAbi, functionName: "bill", args: [ref.id] })]);
    if (b.status === BILL_STATUS.None) return { kind: "none" };
    if (b.status !== BILL_STATUS.Open && b.status !== BILL_STATUS.Paid && b.status !== BILL_STATUS.Void) {
      return { kind: "unavailable", reason: `Arc returned an unknown status ${b.status}.` };
    }
    return { kind: "found", bill: billFromRecord(address, ref.id, b) };
  } catch (error) {
    return { kind: "unavailable", reason: reasonOf(error) };
  }
}

export async function readBillCount(contract: string): Promise<{ ok: true; count: bigint } | { ok: false }> {
  try {
    const { address } = requireDeployment(contract);
    const [, count] = await Promise.all([onArc(), arcClient.readContract({ address, abi: adagAbi, functionName: "billCount" })]);
    return { ok: true, count };
  } catch {
    return { ok: false };
  }
}

export type BillCounts = { ok: true; total: bigint; current: bigint; first: bigint } | { ok: false };

// Either deployment failing makes the counts unknown rather than smaller.
export function sumBillCounts(reads: { label: "current" | "first"; result: Awaited<ReturnType<typeof readBillCount>> }[]): BillCounts {
  let current = 0n;
  let first = 0n;
  for (const { label, result } of reads) {
    if (!result.ok) return { ok: false };
    if (label === "current") current += result.count;
    else first += result.count;
  }
  return { ok: true, total: current + first, current, first };
}

// Bills written on each deployment, and in all.
export async function readTotalBillCount(): Promise<BillCounts> {
  const reads = await Promise.all(DEPLOYMENTS.map(async (d) => ({ label: d.label, result: await readBillCount(d.address) })));
  return sumBillCounts(reads);
}

// A found payment never changes, so it is kept for the life of the server process, keyed by contract and id.
const paidCache = new Map<string, Extract<PaidTx, { kind: "found" }>>();

export async function findPaidTx(bill: Bill): Promise<PaidTx> {
  const key = `${bill.contract.toLowerCase()}:${bill.id}`;
  const cached = paidCache.get(key);
  if (cached) return cached;
  const found = await searchBillPaid(arcClient as PublicClient, bill);
  if (found.kind === "found") paidCache.set(key, found);
  return found;
}
