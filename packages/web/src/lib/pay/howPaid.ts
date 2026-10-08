import { isAddressEqual, type Hex, type PublicClient, type TransactionReceipt } from "viem";
import { arcFallbackClient } from "../arc/client";
import { adagAbi } from "./abi";
import type { Bill } from "./build";
import { CURRENCIES, requireDeployment } from "./constants";
import type { PaidTx } from "./paidTx";
import { morphoEventsIn } from "./receipt";

export type HowPaid =
  | { kind: "balance" }
  | { kind: "bitcoin"; pledged: bigint; borrowed: { symbol: "USDC" | "EURC"; assets: bigint; ltvAfterWad: bigint | null }[] }
  | { kind: "unavailable" };

const isReceiptNotFound = (error: unknown): boolean => {
  for (let e = error as { name?: string; cause?: unknown } | undefined, i = 0; e && i < 6; e = e.cause as typeof e, i++) {
    if (e.name === "TransactionReceiptNotFoundError") return true;
  }
  return false;
};

// A node that has no record of the transaction answers null, which viem raises as "not found", and the fallback transport
// does not move on for that. So the fallback endpoint is asked next, and its answer is read with the same client. A
// second "not found" is the answer, and so is any other failure.
async function receiptWithFallback(client: PublicClient, fallback: PublicClient, hash: Hex): Promise<{ receipt: TransactionReceipt; source: PublicClient }> {
  try {
    return { receipt: await client.getTransactionReceipt({ hash }), source: client };
  } catch (error) {
    if (!isReceiptNotFound(error)) throw error;
    return { receipt: await fallback.getTransactionReceipt({ hash }), source: fallback };
  }
}

// How a paid bill was paid, from the paying transaction itself: the transaction is the one the bill's own contract's
// BillPaid names (C16), and inside it Morpho's own SupplyCollateral and Borrow events for the payer say what was
// pledged and borrowed. The loan-to-value after is the bill's contract's own reading at that block. Nothing is sold
// on this path, so bitcoin sold is always 0.
export async function readHowPaid(
  client: PublicClient,
  bill: Bill,
  paid: Extract<PaidTx, { kind: "found" }>,
  fallback: PublicClient = arcFallbackClient as PublicClient,
): Promise<HowPaid> {
  try {
    const { address } = requireDeployment(bill.contract);
    const { receipt, source } = await receiptWithFallback(client, fallback, paid.txHash);
    // Only Adag's two markets count: a batch someone built by hand could touch another Morpho market in the same transaction.
    const currencyOf = (id: string) => CURRENCIES.find((x) => x.marketId.toLowerCase() === id.toLowerCase());
    const events = morphoEventsIn(receipt.logs).filter((e) => isAddressEqual(e.onBehalf, bill.payer) && currencyOf(e.id) !== undefined);
    const borrows = events.filter((e) => e.name === "Borrow");
    if (borrows.length === 0) return { kind: "balance" };
    const pledged = events.reduce((s, e) => (e.name === "SupplyCollateral" ? s + e.assets : s), 0n);
    const borrowed = await Promise.all(
      borrows.map(async (b) => {
        const ltvAfterWad = await source
          .readContract({ address, abi: adagAbi, functionName: "loanToValue", args: [bill.payer, b.id], blockNumber: receipt.blockNumber })
          .catch(() => null);
        return { symbol: currencyOf(b.id)!.symbol, assets: b.assets, ltvAfterWad };
      }),
    );
    return { kind: "bitcoin", pledged, borrowed };
  } catch {
    return { kind: "unavailable" };
  }
}
