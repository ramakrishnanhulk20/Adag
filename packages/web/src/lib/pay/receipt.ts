import { decodeEventLog, isAddressEqual, type Address, type Hex, type Log } from "viem";
import { adagAbi } from "./abi";
import { ADAG_BILLS } from "./constants";

export type BillPaidProof = { txHash: Hex; logIndex: number; payer: Address; payee: Address; amount: bigint; loanChecked: boolean };

// C16: the only proof of payment is Adag's own BillPaid for this bill, from Adag's address, tied to a hash and log index.
// Memo's event is ignored on purpose: anyone can emit one with any id.
export function billPaidIn(logs: readonly Log[], billId: bigint): BillPaidProof | null {
  for (const log of logs) {
    if (log.removed || !isAddressEqual(log.address, ADAG_BILLS) || log.transactionHash === null || log.logIndex === null) continue;
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

export function billVoidedIn(logs: readonly Log[], billId: bigint): boolean {
  return logs.some((log) => {
    if (log.removed || !isAddressEqual(log.address, ADAG_BILLS)) return false;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics, strict: true });
      return ev.eventName === "BillVoided" && ev.args.id === billId;
    } catch {
      return false;
    }
  });
}
