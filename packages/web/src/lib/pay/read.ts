import { getAddress, type PublicClient } from "viem";
import { arcClient } from "../arc/client";
import { adagAbi } from "./abi";
import { ADAG_BILLS, BILL_STATUS, CHAIN_ID } from "./constants";
import type { Bill } from "./build";
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

// C19: an RPC failure is "unavailable", never "no such bill" and never "unpaid".
export async function readBill(id: bigint): Promise<BillRead> {
  try {
    const [, b] = await Promise.all([onArc(), arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [id] })]);
    if (b.status === BILL_STATUS.None) return { kind: "none" };
    if (b.status !== BILL_STATUS.Open && b.status !== BILL_STATUS.Paid && b.status !== BILL_STATUS.Void) {
      return { kind: "unavailable", reason: `Arc returned an unknown status ${b.status}.` };
    }
    return {
      kind: "found",
      bill: {
        id,
        payee: getAddress(b.payee),
        status: b.status,
        due: b.due,
        currency: getAddress(b.currency),
        createdAt: b.createdAt,
        amount: b.amount,
        payer: getAddress(b.payer),
        paidAt: b.paidAt,
        ref: b.ref,
      },
    };
  } catch (error) {
    return { kind: "unavailable", reason: reasonOf(error) };
  }
}

export async function readBillCount(): Promise<{ ok: true; count: bigint } | { ok: false }> {
  try {
    const [, count] = await Promise.all([onArc(), arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "billCount" })]);
    return { ok: true, count };
  } catch {
    return { ok: false };
  }
}

// A found payment never changes, so it is kept for the life of the server process.
const paidCache = new Map<string, Extract<PaidTx, { kind: "found" }>>();

export async function findPaidTx(bill: Bill): Promise<PaidTx> {
  const cached = paidCache.get(bill.id.toString());
  if (cached) return cached;
  const found = await searchBillPaid(arcClient as PublicClient, bill);
  if (found.kind === "found") paidCache.set(bill.id.toString(), found);
  return found;
}
