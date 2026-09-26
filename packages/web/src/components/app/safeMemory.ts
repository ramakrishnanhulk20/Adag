import { getAddress, isAddress, isHex, type Address, type Hex } from "viem";

// A Safe proposal lives in the Safe's queue for days, so this browser remembers which one it made for which bills.
// Keyed by (Safe, contract, bill set); a page looks it up by (contract, bill set) and shows its status instead of
// offering to propose the same bills again. It is a convenience only: every fact shown is read again from Arc and
// from the Safe's service.
export type RememberedProposal = { safe: Address; safeTxHash: Hex; threshold: number };

const PREFIX = "adag-safe-proposal:";
const billSet = (contract: string, ids: readonly bigint[]) => `${contract.toLowerCase()}:${[...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(",")}`;

export function rememberProposal(contract: string, ids: readonly bigint[], p: RememberedProposal) {
  try {
    window.localStorage.setItem(`${PREFIX}${p.safe.toLowerCase()}:${billSet(contract, ids)}`, JSON.stringify({ ...p, at: Date.now() }));
  } catch {
    // Private windows may refuse storage; the proposal still stands in the Safe's queue.
  }
}

export function recallProposal(contract: string, ids: readonly bigint[]): RememberedProposal | null {
  if (ids.length === 0) return null;
  try {
    const suffix = `:${billSet(contract, ids)}`;
    let best: (RememberedProposal & { at: number }) | null = null;
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (!key?.startsWith(PREFIX) || !key.endsWith(suffix)) continue;
      const v = JSON.parse(window.localStorage.getItem(key) ?? "null") as { safe?: string; safeTxHash?: string; threshold?: number; at?: number } | null;
      if (!v || typeof v.safe !== "string" || !isAddress(v.safe) || typeof v.safeTxHash !== "string" || !isHex(v.safeTxHash) || v.safeTxHash.length !== 66) continue;
      const entry = { safe: getAddress(v.safe), safeTxHash: v.safeTxHash as Hex, threshold: Number(v.threshold) || 1, at: Number(v.at) || 0 };
      if (!best || entry.at > best.at) best = entry;
    }
    return best ? { safe: best.safe, safeTxHash: best.safeTxHash, threshold: best.threshold } : null;
  } catch {
    return null;
  }
}

export function forgetProposal(contract: string, ids: readonly bigint[], safe: string) {
  try {
    window.localStorage.removeItem(`${PREFIX}${safe.toLowerCase()}:${billSet(contract, ids)}`);
  } catch {
    // Nothing to forget.
  }
}
