import { isAddressEqual, type PublicClient } from "viem";
import { adagAbi } from "./abi";
import type { Bill } from "./build";
import { CURRENCIES, requireDeployment } from "./constants";
import type { PaidTx } from "./paidTx";
import { morphoEventsIn } from "./receipt";

export type HowPaid =
  | { kind: "balance" }
  | { kind: "bitcoin"; pledged: bigint; borrowed: { symbol: "USDC" | "EURC"; assets: bigint; ltvAfterWad: bigint | null }[] }
  | { kind: "unavailable" };

// How a paid bill was paid, from the paying transaction itself: the transaction is the one the bill's own contract's
// BillPaid names (C16), and inside it Morpho's own SupplyCollateral and Borrow events for the payer say what was
// pledged and borrowed. The loan-to-value after is the bill's contract's own reading at that block. Nothing is sold
// on this path, so bitcoin sold is always 0.
export async function readHowPaid(client: PublicClient, bill: Bill, paid: Extract<PaidTx, { kind: "found" }>): Promise<HowPaid> {
  try {
    const { address } = requireDeployment(bill.contract);
    const receipt = await client.getTransactionReceipt({ hash: paid.txHash });
    // Only Adag's two markets count: a batch someone built by hand could touch another Morpho market in the same transaction.
    const currencyOf = (id: string) => CURRENCIES.find((x) => x.marketId.toLowerCase() === id.toLowerCase());
    const events = morphoEventsIn(receipt.logs).filter((e) => isAddressEqual(e.onBehalf, bill.payer) && currencyOf(e.id) !== undefined);
    const borrows = events.filter((e) => e.name === "Borrow");
    if (borrows.length === 0) return { kind: "balance" };
    const pledged = events.reduce((s, e) => (e.name === "SupplyCollateral" ? s + e.assets : s), 0n);
    const borrowed = await Promise.all(
      borrows.map(async (b) => {
        const ltvAfterWad = await client
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
