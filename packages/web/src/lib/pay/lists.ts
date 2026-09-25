import { getAddress, type Address, type PublicClient } from "viem";
import { adagAbi } from "./abi";
import { ADAG_BILLS } from "./constants";
import type { Bill } from "./build";

export const LIST_PAGE = 20;
// The contract serves at most 100 ids per call. Ten calls bound a list at the newest 1,000 bills (C19).
const CHUNK = 100n;
const MAX_CHUNKS = 10n;

export type BillList = { total: bigint; bills: Bill[]; capped: boolean };

// Newest first. Ids come from Adag's own lists and every record from bill(id), never from logs or an indexer (C16).
export async function readBillList(client: PublicClient, kind: "wrote" | "paid", who: Address): Promise<BillList> {
  const fn = kind === "wrote" ? "billsOfPayee" : "paymentsOfPayer";
  const [, total] = await client.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: fn, args: [who, 0n, 1n] });
  const ids: bigint[] = [];
  let end = total;
  for (let i = 0n; i < MAX_CHUNKS && end > 0n; i++) {
    const start = end > CHUNK ? end - CHUNK : 0n;
    const [page] = await client.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: fn, args: [who, start, end - start] });
    ids.push(...[...page].reverse());
    end = start;
  }
  const bills: Bill[] = [];
  for (let i = 0; i < ids.length; i += Number(CHUNK)) {
    const slice = ids.slice(i, i + Number(CHUNK));
    const records = await client.multicall({
      allowFailure: false,
      contracts: slice.map((id) => ({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [id] }) as const),
    });
    records.forEach((b, j) =>
      bills.push({
        id: slice[j]!,
        payee: getAddress(b.payee),
        status: b.status,
        due: b.due,
        currency: getAddress(b.currency),
        createdAt: b.createdAt,
        amount: b.amount,
        payer: getAddress(b.payer),
        paidAt: b.paidAt,
        ref: b.ref,
      }),
    );
  }
  return { total, bills, capped: end > 0n };
}
