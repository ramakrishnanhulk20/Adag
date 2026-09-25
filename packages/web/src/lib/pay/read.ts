import { getAddress, isAddressEqual, type Block, type Hex } from "viem";
import { arcClient } from "../arc/client";
import { LOG_MAX_PAGES, LOG_PAGE_BLOCKS } from "../arc/constants";
import { adagAbi } from "./abi";
import { ADAG_BILLS, ADAG_DEPLOY_BLOCK, BILL_STATUS, CHAIN_ID, EXPLORER } from "./constants";
import type { Bill } from "./build";

export type BillRead =
  | { kind: "found"; bill: Bill }
  | { kind: "none" }
  | { kind: "unavailable"; reason: string };

export type PaidTx =
  | { kind: "found"; txHash: Hex; logIndex: number; blockNumber: string; loanChecked: boolean; url: string }
  | { kind: "not-found" }
  | { kind: "unavailable" };

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
const MAX_PROBES = 8;

type Mark = { number: bigint; timestamp: bigint };
const mark = (b: Block): Mark => {
  if (b.number === null) throw new Error("Arc returned a block with no number.");
  return { number: b.number, timestamp: b.timestamp };
};

// C16: the paying transaction comes only from Adag's own BillPaid log for this id. The search narrows to the block
// whose time is paidAt by interpolating block times, then reads at most LOG_MAX_PAGES windows of 10,000 blocks (C19).
export async function findPaidTx(bill: Bill): Promise<PaidTx> {
  if (bill.status !== BILL_STATUS.Paid) return { kind: "not-found" };
  const cached = paidCache.get(bill.id.toString());
  if (cached) return cached;
  try {
    const [head, deploy] = await Promise.all([
      arcClient.getBlock().then(mark),
      arcClient.getBlock({ blockNumber: ADAG_DEPLOY_BLOCK }).then(mark),
    ]);
    const paidAt = bill.paidAt;
    if (paidAt < deploy.timestamp || paidAt > head.timestamp) return { kind: "not-found" };

    // lo is always a block before paidAt; hi is always a block at or after it, so the payment sits in (lo, hi].
    let lo: Mark = deploy;
    let hi: Mark = head;
    if (lo.timestamp >= paidAt) hi = lo;
    for (let i = 0; i < MAX_PROBES && hi.number - lo.number > LOG_PAGE_BLOCKS; i++) {
      const span = hi.timestamp - lo.timestamp;
      let guess = span > 0n ? lo.number + ((paidAt - lo.timestamp) * (hi.number - lo.number)) / span : lo.number + 1n;
      if (guess <= lo.number) guess = lo.number + 1n;
      if (guess >= hi.number) guess = hi.number - 1n;
      const probe = mark(await arcClient.getBlock({ blockNumber: guess }));
      if (probe.timestamp < paidAt) lo = probe;
      else hi = probe;
    }

    for (let page = 0, from = lo.number; page < LOG_MAX_PAGES && from <= hi.number; page++, from += LOG_PAGE_BLOCKS) {
      const to = from + LOG_PAGE_BLOCKS - 1n < hi.number ? from + LOG_PAGE_BLOCKS - 1n : hi.number;
      const logs = await arcClient.getContractEvents({
        address: ADAG_BILLS,
        abi: adagAbi,
        eventName: "BillPaid",
        args: { id: bill.id },
        fromBlock: from,
        toBlock: to,
        strict: true,
      });
      const match = logs.find(
        (log) =>
          !log.removed &&
          isAddressEqual(log.address, ADAG_BILLS) &&
          log.args.id === bill.id &&
          isAddressEqual(log.args.payer, bill.payer) &&
          isAddressEqual(log.args.payee, bill.payee) &&
          log.args.amount === bill.amount &&
          log.transactionHash !== null &&
          log.logIndex !== null,
      );
      if (match) {
        const found = {
          kind: "found" as const,
          txHash: match.transactionHash!,
          logIndex: match.logIndex!,
          blockNumber: String(match.blockNumber),
          loanChecked: match.args.loanChecked,
          url: `${EXPLORER}/tx/${match.transactionHash}`,
        };
        paidCache.set(bill.id.toString(), found);
        return found;
      }
    }
    return { kind: "not-found" };
  } catch {
    return { kind: "unavailable" };
  }
}
