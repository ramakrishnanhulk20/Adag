import { decodeEventLog, isAddressEqual, type Address, type Hex, type Log } from "viem";
import { adagAbi, erc20Abi, morphoAbi } from "./abi";
import { ADAG_BILLS, BILL_STATUS, MORPHO, requireDeployment } from "./constants";
import { guardAbi } from "../guard/abi";
import { ADAG_GUARD } from "../guard/constants";

export type BillPaidProof = { txHash: Hex; logIndex: number; payer: Address; payee: Address; amount: bigint; loanChecked: boolean };

type LogShape = { address: Address; topics: readonly Hex[]; data: Hex };

export type BillPaidArgs = { id: bigint; payer: Address; payee: Address; currency: Address; amount: bigint; loanChecked: boolean };

// The one parser for a BillPaid log: it must come from this bill's own AdagBills, carry this bill's id and, when a payer
// is named, that payer. Receipts and the pre-signing simulation both go through it, so they cannot disagree (C72, C71).
export function matchBillPaid(log: LogShape, contract: string, billId: bigint, payer?: string): BillPaidArgs | null {
  const { address } = requireDeployment(contract);
  if (!isAddressEqual(log.address, address)) return null;
  try {
    const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics as [Hex, ...Hex[]], strict: true });
    if (ev.eventName !== "BillPaid" || ev.args.id !== billId) return null;
    if (payer !== undefined && !isAddressEqual(ev.args.payer, payer as Address)) return null;
    return ev.args;
  } catch {
    return null;
  }
}

// C16: the only proof of payment is the BillPaid of the bill's own contract for this bill, tied to a hash and log
// index. The other deployment's event for the same number proves nothing (C33). Memo's event is ignored on purpose:
// anyone can emit one with any id.
// C72: pass `payer` (the connected account) for every payment that ran through a swap. A BillPaid for another payer
// is then not this payment, even when AdagBills emitted it, because other code runs in the same transaction.
export function billPaidIn(logs: readonly Log[], contract: string, billId: bigint, payer?: string): BillPaidProof | null {
  requireDeployment(contract);
  for (const log of logs) {
    if (log.removed || log.transactionHash === null || log.logIndex === null) continue;
    const ev = matchBillPaid(log, contract, billId, payer);
    if (!ev) continue;
    return {
      txHash: log.transactionHash,
      logIndex: log.logIndex,
      payer: ev.payer,
      payee: ev.payee,
      amount: ev.amount,
      loanChecked: ev.loanChecked,
    };
  }
  return null;
}

// Every bill in a basket, each proven by its own BillPaid from the basket's contract (C16). A missing id is simply absent.
export function billsPaidIn(logs: readonly Log[], contract: string, ids: readonly bigint[], payer?: string): Map<bigint, BillPaidProof> {
  const out = new Map<bigint, BillPaidProof>();
  for (const id of ids) {
    const proof = billPaidIn(logs, contract, id, payer);
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
  | { name: "Repay"; id: Hex; onBehalf: Address; assets: bigint; shares: bigint }
  | { name: "Borrow"; id: Hex; onBehalf: Address; receiver: Address; assets: bigint; shares: bigint };

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
      else if (ev.eventName === "Borrow")
        out.push({ name: ev.eventName, id: ev.args.id, onBehalf: ev.args.onBehalf, receiver: ev.args.receiver, assets: ev.args.assets, shares: ev.args.shares });
    } catch {
      // Morpho events this ABI does not list, such as AccrueInterest.
    }
  }
  return out;
}

// C72: what a conversion put into the payer's wallet, read from Transfer logs whose emitter is the fixed token and whose
// recipient is the payer. A transfer from the payer to the payer is left out: the batch's balance check is exactly that,
// and it moves nothing new. Logs from any other emitter, and transfers to anyone else, are not counted.
export function convertedInto(logs: readonly Log[], token: Address, payer: string): bigint {
  let total = 0n;
  for (const log of logs) {
    if (log.removed || !isAddressEqual(log.address, token)) continue;
    try {
      const ev = decodeEventLog({ abi: erc20Abi, data: log.data, topics: log.topics, strict: true });
      if (ev.eventName !== "Transfer") continue;
      if (!isAddressEqual(ev.args.to, payer as Address) || isAddressEqual(ev.args.from, payer as Address)) continue;
      total += ev.args.value;
    } catch {
      // Not a plain Transfer of this token.
    }
  }
  return total;
}

// Which card a bill's pay panel shows. Only an Open bill offers the pay options; any other status, an unknown one
// included, never does. This wallet's proven payment shows its receipt, a payment still reading its receipt keeps its
// progress on screen, and anything else says the bill's status.
export type PayPanel = "receipt" | "progress" | "closed" | "options";
export function payPanelFor(a: { status: number; paid: boolean; busy: boolean }): PayPanel {
  if (a.paid) return "receipt";
  if (a.status === BILL_STATUS.Open) return "options";
  return a.busy ? "progress" : "closed";
}

// Whether the bill page keeps this wallet's pay panel mounted. A payment under way keeps it: the page's own poll can
// refresh the bill to Paid before the payment has read its receipt, and a panel unmounted then loses the receipt card.
// Once this wallet has paid, or proposed a Safe payment, here, the panel stays for the result.
export function keepsPayPanel(a: { open: boolean; paying: boolean; actedHere: boolean; safeProposed: boolean }): boolean {
  return a.open || a.paying || a.actedHere || a.safeProposed;
}

// The converted amount, and what the swap returned beyond `spent` (the bills paid or the loan repaid), which stays in
// the wallet. The surplus is never negative: a swap that returned less than was spent would have reverted the batch.
export function conversionOutcome(logs: readonly Log[], input: { token: Address; payer: string; spent: bigint }): { converted: bigint; surplus: bigint } {
  const converted = convertedInto(logs, input.token, input.payer);
  return { converted, surplus: converted > input.spent ? converted - input.spent : 0n };
}
