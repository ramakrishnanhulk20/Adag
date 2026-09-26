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

function reasonOf(error: unknown) {
  const e = error as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage || e?.message || "The read failed.").split("\n")[0]!.slice(0, 160);
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

// Bills written across both deployments. Either failing makes the total unknown rather than smaller.
export async function readTotalBillCount(): Promise<{ ok: true; count: bigint } | { ok: false }> {
  const counts = await Promise.all(DEPLOYMENTS.map((d) => readBillCount(d.address)));
  if (counts.some((c) => !c.ok)) return { ok: false };
  return { ok: true, count: counts.reduce((s, c) => s + (c.ok ? c.count : 0n), 0n) };
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
