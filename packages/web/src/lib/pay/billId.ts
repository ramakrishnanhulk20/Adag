import type { Address } from "viem";
import { ADAG_BILLS, ADAG_BILLS_FIRST, requireDeployment } from "./constants";

// C33: a bill is the pair (contract, id). This file is the only place a route, a link or pasted text becomes a pair,
// and every page, read and transaction uses its output. Anything that does not resolve to exactly one pair is refused.
export type BillRef = { contract: Address; id: bigint };

const CANONICAL_ID = /^[1-9]\d{0,77}$/;

// The route segments after /bill/: ["12"] is bill 12 on the current contract, ["first", "12"] is bill 12 on the
// first deployment. Only the canonical number is accepted, so /bill/01 and /bill/1 never both exist.
export function parseBillRoute(segments: readonly string[]): BillRef | null {
  if (segments.length === 1 && CANONICAL_ID.test(segments[0]!)) return { contract: ADAG_BILLS, id: BigInt(segments[0]!) };
  if (segments.length === 2 && segments[0] === "first" && CANONICAL_ID.test(segments[1]!)) return { contract: ADAG_BILLS_FIRST, id: BigInt(segments[1]!) };
  return null;
}

// Every link to a bill is made here and nowhere else.
export function billHref(contract: string, id: bigint): string {
  const d = requireDeployment(contract);
  if (typeof id !== "bigint" || id < 1n) throw new Error("A bill number must be a whole number of 1 or more.");
  return d.label === "first" ? `/bill/first/${id}` : `/bill/${id}`;
}

export const sameBill = (a: BillRef, b: BillRef) => a.id === b.id && a.contract.toLowerCase() === b.contract.toLowerCase();
export const billKey = (b: BillRef) => `${b.contract.toLowerCase()}:${b.id}`;

// A typed number is always the current contract. "#12", "No. 12" and "bill 12" read as 12.
const BARE = /^(?:#|no\.?\s*|bill\s*#?\s*)?(\d{1,78})$/i;
const ROUTE_TAIL = /^([^?#]*)/;

// One pasted token: a number, or a link with exactly one /bill/ path in it. Nothing else in a link is read (C3).
export function parseBillInput(input: string): BillRef | null {
  const text = input.trim();
  if (!text) return null;
  const bare = BARE.exec(text)?.[1];
  if (bare) {
    const id = BigInt(bare);
    return id >= 1n ? { contract: ADAG_BILLS, id } : null;
  }
  const parts = text.split("/bill/");
  if (parts.length !== 2) return null;
  const path = ROUTE_TAIL.exec(parts[1]!)![1]!.replace(/\/$/, "");
  return parseBillRoute(path.split("/"));
}

export const MAX_BASKET = 10;

// A basket covers one contract. Its link carries the ids and, for the first deployment, deployment=first.
export function basketHref(contract: string, ids: readonly bigint[]): string {
  const d = requireDeployment(contract);
  const list = ids.map((id) => id.toString()).join(",");
  return d.label === "first" ? `/pay/basket?bills=${list}&deployment=first` : `/pay/basket?bills=${list}`;
}

// The basket page's query: each id goes through parseBillRoute with the marker, so a basket id and a bill link can
// never disagree about which contract a number means.
export function parseBasketQuery(bills: string, deployment: string | null): { refs: BillRef[]; dropped: string[]; droppedCount: number } {
  const marker = deployment === "first" ? "first" : deployment === null || deployment === "" ? null : undefined;
  const refs: BillRef[] = [];
  const dropped: string[] = [];
  let droppedCount = 0;
  const drop = (token: string) => {
    droppedCount++;
    if (dropped.length < MAX_DROPPED_SHOWN) dropped.push(token.length > MAX_DROPPED_CHARS ? `${token.slice(0, MAX_DROPPED_CHARS)}…` : token);
  };
  if (marker === undefined) {
    drop(`deployment=${deployment}`);
    return { refs, dropped, droppedCount };
  }
  for (const token of bills.split(/(?:,|%2C|\s)+/i)) {
    if (!token) continue;
    const ref = parseBillRoute(marker ? [marker, token] : [token]);
    if (!ref) drop(token);
    else if (!refs.some((r) => sameBill(r, ref))) refs.push(ref);
  }
  if (refs.length > MAX_BASKET) {
    throw new Error(`That is ${refs.length} bills. One signature pays at most ${MAX_BASKET}; split them into two baskets.`);
  }
  return { refs, dropped, droppedCount };
}

// A basket link pasted back in: its own query is read with parseBasketQuery.
const BASKET_LINK = /\S*\/pay\/basket\?(\S*)/gi;

// A basket link is attacker-writable text shown on a genuine Adag page, so only a sample of what was rejected is
// kept, short enough that it cannot carry a sentence: at most 3 entries of 24 characters, plus a count.
export const MAX_DROPPED_SHOWN = 3;
export const MAX_DROPPED_CHARS = 24;

export const MIXED_CONTRACTS =
  "These bills sit on two different AdagBills contracts, and one signature pays bills of one contract. Pay the first-deployment bills separately.";

// Numbers, bill links or basket links, separated by commas, spaces or new lines. Duplicates collapse to the first
// one. A sample of anything that is not a bill comes back in `dropped`, and `droppedCount` counts them all. More
// than MAX_BASKET bills, or bills on two contracts, throws.
export function parseBillList(input: string): { refs: BillRef[]; dropped: string[]; droppedCount: number } {
  const refs: BillRef[] = [];
  const dropped: string[] = [];
  let droppedCount = 0;
  const add = (ref: BillRef) => {
    if (!refs.some((r) => sameBill(r, ref))) refs.push(ref);
  };
  const drop = (token: string) => {
    droppedCount++;
    if (dropped.length < MAX_DROPPED_SHOWN) dropped.push(token.length > MAX_DROPPED_CHARS ? `${token.slice(0, MAX_DROPPED_CHARS)}…` : token);
  };
  const rest = input.replace(BASKET_LINK, (_match, query: string) => {
    const params = new URLSearchParams(query);
    const inner = parseBasketQuery(params.get("bills") ?? "", params.get("deployment"));
    inner.refs.forEach(add);
    inner.dropped.forEach(drop);
    droppedCount += inner.droppedCount - inner.dropped.length;
    if (inner.refs.length === 0 && inner.droppedCount === 0) drop(_match);
    return " ";
  });
  for (const token of rest.split(/[\s,]+/)) {
    if (!token) continue;
    const ref = parseBillInput(token);
    if (ref) add(ref);
    else drop(token);
  }
  if (refs.length > MAX_BASKET) {
    throw new Error(`That is ${refs.length} bills. One signature pays at most ${MAX_BASKET}; split them into two baskets.`);
  }
  if (new Set(refs.map((r) => r.contract.toLowerCase())).size > 1) throw new Error(MIXED_CONTRACTS);
  return { refs, dropped, droppedCount };
}
