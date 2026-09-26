import type { Address, PublicClient } from "viem";
import { adagAbi } from "./abi";
import { DEPLOYMENTS, type Deployment } from "./constants";
import { billFromRecord, type Bill } from "./build";

export const LIST_PAGE = 20;
// The contract serves at most 100 ids per call. Ten calls bound a list at the newest 1,000 bills per contract (C19).
const CHUNK = 100n;
const MAX_CHUNKS = 10n;

export type BillList = { total: bigint; bills: Bill[]; capped: boolean };

// Newest first, from one contract. Ids come from Adag's own lists and every record from bill(id) on that same
// contract, never from logs or an indexer (C16).
async function readOne(client: PublicClient, d: Deployment, kind: "wrote" | "paid", who: Address): Promise<BillList> {
  const fn = kind === "wrote" ? "billsOfPayee" : "paymentsOfPayer";
  const [, total] = await client.readContract({ address: d.address, abi: adagAbi, functionName: fn, args: [who, 0n, 1n] });
  const ids: bigint[] = [];
  let end = total;
  for (let i = 0n; i < MAX_CHUNKS && end > 0n; i++) {
    const start = end > CHUNK ? end - CHUNK : 0n;
    const [page] = await client.readContract({ address: d.address, abi: adagAbi, functionName: fn, args: [who, start, end - start] });
    ids.push(...[...page].reverse());
    end = start;
  }
  const bills: Bill[] = [];
  for (let i = 0; i < ids.length; i += Number(CHUNK)) {
    const slice = ids.slice(i, i + Number(CHUNK));
    const records = await client.multicall({
      allowFailure: false,
      contracts: slice.map((id) => ({ address: d.address, abi: adagAbi, functionName: "bill", args: [id] }) as const),
    });
    records.forEach((b, j) => bills.push(billFromRecord(d.address, slice[j]!, b)));
  }
  return { total, bills, capped: end > 0n };
}

// Both deployments, merged newest first: by the time written for "wrote" and the time paid for "paid". A failure on
// either contract fails the whole list, so a missing contract never reads as fewer bills.
export async function readBillList(client: PublicClient, kind: "wrote" | "paid", who: Address): Promise<BillList> {
  const lists = await Promise.all(DEPLOYMENTS.map((d) => readOne(client, d, kind, who)));
  const rank = (b: Bill) => DEPLOYMENTS.findIndex((d) => d.address.toLowerCase() === b.contract.toLowerCase());
  const at = (b: Bill) => (kind === "wrote" ? b.createdAt : b.paidAt);
  const bills = lists
    .flatMap((l) => l.bills)
    .sort((a, b) => (at(a) !== at(b) ? (at(b) > at(a) ? 1 : -1) : rank(a) !== rank(b) ? rank(a) - rank(b) : b.id > a.id ? 1 : b.id < a.id ? -1 : 0));
  return { total: lists.reduce((s, l) => s + l.total, 0n), bills, capped: lists.some((l) => l.capped) };
}
