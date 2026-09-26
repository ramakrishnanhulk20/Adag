import { decodeEventLog, isAddressEqual, type Address, type Hex, type Log } from "viem";
import { adagAbi, morphoAbi } from "./abi";
import { ADAG_BILLS, MORPHO, requireDeployment } from "./constants";
import { guardAbi } from "../guard/abi";
import { ADAG_GUARD } from "../guard/constants";

export type BillPaidProof = { txHash: Hex; logIndex: number; payer: Address; payee: Address; amount: bigint; loanChecked: boolean };

// C16: the only proof of payment is the BillPaid of the bill's own contract for this bill, tied to a hash and log
// index. The other deployment's event for the same number proves nothing (C33). Memo's event is ignored on purpose:
// anyone can emit one with any id.
export function billPaidIn(logs: readonly Log[], contract: string, billId: bigint): BillPaidProof | null {
  const { address } = requireDeployment(contract);
  for (const log of logs) {
    if (log.removed || !isAddressEqual(log.address, address) || log.transactionHash === null || log.logIndex === null) continue;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics, strict: true });
      if (ev.eventName !== "BillPaid" || ev.args.id !== billId) continue;
      return {
        txHash: log.transactionHash,
        logIndex: log.logIndex,
        payer: ev.args.payer,
        payee: ev.args.payee,
        amount: ev.args.amount,
        loanChecked: ev.args.loanChecked,
      };
    } catch {
      // Not an Adag event this ABI knows; skip it.
    }
  }
  return null;
}

// Every bill in a basket, each proven by its own BillPaid from the basket's contract (C16). A missing id is simply absent.
export function billsPaidIn(logs: readonly Log[], contract: string, ids: readonly bigint[]): Map<bigint, BillPaidProof> {
  const out = new Map<bigint, BillPaidProof>();
  for (const id of ids) {
    const proof = billPaidIn(logs, contract, id);
    if (proof) out.set(id, proof);
  }
  return out;
}

export function billVoidedIn(logs: readonly Log[], contract: string, billId: bigint): boolean {
  const { address } = requireDeployment(contract);
  return logs.some((log) => {
    if (log.removed || !isAddressEqual(log.address, address)) return false;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics, strict: true });
      return ev.eventName === "BillVoided" && ev.args.id === billId;
    } catch {
      return false;
    }
  });
}

// C16: a new bill's number comes only from BillCreated on the current contract, the only one bills are written on.
export function billCreatedIn(logs: readonly Log[]): bigint | null {
  for (const log of logs) {
    if (log.removed || !isAddressEqual(log.address, ADAG_BILLS)) continue;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics, strict: true });
      if (ev.eventName === "BillCreated") return ev.args.id;
    } catch {
      // Not an Adag event this ABI knows; skip it.
    }
  }
  return null;
}

// C60: a close that stopped the guard is proven by AdagGuard's own RuleCleared for this wallet and market.
export function ruleClearedIn(logs: readonly Log[], borrower: string, market: string): boolean {
  if (!ADAG_GUARD) return false;
  return logs.some((log) => {
    if (log.removed || !isAddressEqual(log.address, ADAG_GUARD!)) return false;
    try {
      const ev = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics, strict: true });
      return ev.eventName === "RuleCleared" && isAddressEqual(ev.args.borrower, borrower as Address) && ev.args.marketId.toLowerCase() === market.toLowerCase();
    } catch {
      return false;
    }
  });
}

export type MorphoEvent =
  | { name: "SupplyCollateral"; id: Hex; onBehalf: Address; assets: bigint }
  | { name: "WithdrawCollateral"; id: Hex; onBehalf: Address; receiver: Address; assets: bigint }
  | { name: "Repay"; id: Hex; onBehalf: Address; assets: bigint; shares: bigint };

// Loan actions are proven by Morpho's own events, from Morpho's address only.
export function morphoEventsIn(logs: readonly Log[]): MorphoEvent[] {
  const out: MorphoEvent[] = [];
  for (const log of logs) {
    if (log.removed || !isAddressEqual(log.address, MORPHO)) continue;
    try {
      const ev = decodeEventLog({ abi: morphoAbi, data: log.data, topics: log.topics, strict: true });
      if (ev.eventName === "SupplyCollateral") out.push({ name: ev.eventName, id: ev.args.id, onBehalf: ev.args.onBehalf, assets: ev.args.assets });
      else if (ev.eventName === "WithdrawCollateral")
        out.push({ name: ev.eventName, id: ev.args.id, onBehalf: ev.args.onBehalf, receiver: ev.args.receiver, assets: ev.args.assets });
      else if (ev.eventName === "Repay") out.push({ name: ev.eventName, id: ev.args.id, onBehalf: ev.args.onBehalf, assets: ev.args.assets, shares: ev.args.shares });
    } catch {
      // Morpho events this ABI does not list, such as Borrow or AccrueInterest.
    }
  }
  return out;
}
