import { isAddressEqual, type Block, type Hex, type PublicClient } from "viem";
import { LOG_MAX_PAGES, LOG_PAGE_BLOCKS } from "../arc/constants";
import { adagAbi } from "./abi";
import { BILL_STATUS, EXPLORER, requireDeployment } from "./constants";
import type { Bill } from "./build";

export type PaidTx =
  | { kind: "found"; txHash: Hex; logIndex: number; blockNumber: string; loanChecked: boolean; url: string }
  | { kind: "not-found" }
  | { kind: "unavailable" };

const MAX_PROBES = 8;

type Mark = { number: bigint; timestamp: bigint };
const mark = (b: Block): Mark => {
  if (b.number === null) throw new Error("Arc returned a block with no number.");
  return { number: b.number, timestamp: b.timestamp };
};

// C16: the paying transaction comes only from the BillPaid log of the bill's own contract for this id, matching the
// bill's payer, payee and amount. The other deployment's log for the same number is never a match (C33). The search
// narrows to the block whose time is paidAt by interpolating block times, then reads at most LOG_MAX_PAGES windows of
// 10,000 blocks (C19). The server page and the browser's export share this one search.
export async function searchBillPaid(client: PublicClient, bill: Bill): Promise<PaidTx> {
  if (bill.status !== BILL_STATUS.Paid) return { kind: "not-found" };
  try {
    const { address: contract, deployBlock } = requireDeployment(bill.contract);
    const [head, deploy] = await Promise.all([client.getBlock().then(mark), client.getBlock({ blockNumber: deployBlock }).then(mark)]);
    const paidAt = bill.paidAt;
    if (paidAt < deploy.timestamp || paidAt > head.timestamp) return { kind: "not-found" };

    // Several Arc blocks share one second, so a block stamped paidAt can sit before or after the payment. lo only
    // moves to blocks stamped before paidAt and hi only to blocks stamped after it, so the payment sits in [lo, hi].
    // A probe that lands exactly on paidAt is inside the run of blocks with that stamp, so the search then narrows to
    // one page around it.
    let lo: Mark = deploy;
    let hi: Mark = head;
    for (let i = 0; i < MAX_PROBES && hi.number - lo.number > LOG_PAGE_BLOCKS; i++) {
      const span = hi.timestamp - lo.timestamp;
      let guess = span > 0n ? lo.number + ((paidAt - lo.timestamp) * (hi.number - lo.number)) / span : lo.number + 1n;
      if (guess <= lo.number) guess = lo.number + 1n;
      if (guess >= hi.number) guess = hi.number - 1n;
      const probe = mark(await client.getBlock({ blockNumber: guess }));
      if (probe.timestamp < paidAt) lo = probe;
      else if (probe.timestamp > paidAt) hi = probe;
      else {
        const half = LOG_PAGE_BLOCKS / 2n;
        if (probe.number - half > lo.number) lo = { number: probe.number - half, timestamp: lo.timestamp };
        if (probe.number + half < hi.number) hi = { number: probe.number + half, timestamp: hi.timestamp };
        break;
      }
    }

    for (let page = 0, from = lo.number; page < LOG_MAX_PAGES && from <= hi.number; page++, from += LOG_PAGE_BLOCKS) {
      const to = from + LOG_PAGE_BLOCKS - 1n < hi.number ? from + LOG_PAGE_BLOCKS - 1n : hi.number;
      const logs = await client.getContractEvents({
        address: contract,
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
          isAddressEqual(log.address, contract) &&
          log.args.id === bill.id &&
          isAddressEqual(log.args.payer, bill.payer) &&
          isAddressEqual(log.args.payee, bill.payee) &&
          log.args.amount === bill.amount &&
          log.transactionHash !== null &&
          log.logIndex !== null,
      );
      if (match) {
        return {
          kind: "found",
          txHash: match.transactionHash!,
          logIndex: match.logIndex!,
          blockNumber: String(match.blockNumber),
          loanChecked: match.args.loanChecked,
          url: `${EXPLORER}/tx/${match.transactionHash}`,
        };
      }
    }
    return { kind: "not-found" };
  } catch {
    return { kind: "unavailable" };
  }
}
