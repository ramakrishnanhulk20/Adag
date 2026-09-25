// A lever for the end-to-end run only: NEXT_PUBLIC_ADAG_E2E is set at build time for the fork build and nowhere else,
// so in a real build this whole branch is compiled away. It can only shrink a pledge, never raise or redirect anything.
export function e2ePledge(pledge: bigint): bigint {
  if (process.env.NEXT_PUBLIC_ADAG_E2E !== "1") return pledge;
  const pct = (window as { __adagE2EPledgePercent?: unknown }).__adagE2EPledgePercent;
  if (typeof pct !== "number" || !Number.isInteger(pct) || pct <= 0 || pct >= 100) return pledge;
  return (pledge * BigInt(pct)) / 100n;
}
