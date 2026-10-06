// Plain TypeScript with relative imports only. What Circle's swap adapter may already do with the payer's wallet before a
// conversion starts, and whether it has been left with nothing afterwards (C67).
import type { Address, PublicClient } from "viem";
import { erc20Abi, morphoAbi } from "../pay/abi";
import { buildAdapterReset, type Batch } from "../pay/build";
import { CIRBTC, CIRCLE_SWAP_ADAPTER, EURC, MORPHO, USDC } from "../pay/constants";

export type AdapterExposure = { allowances: { USDC: bigint; EURC: bigint; cirBTC: bigint }; authorized: boolean };

const TOKENS: readonly { symbol: "USDC" | "EURC" | "cirBTC"; address: Address }[] = [
  { symbol: "USDC", address: USDC },
  { symbol: "EURC", address: EURC },
  { symbol: "cirBTC", address: CIRBTC },
];

// The payer's allowances to the adapter for all three tokens, and whether the payer has authorised it on Morpho (which
// would let it borrow and take collateral as the payer). A failed read is null, never "all zero".
export async function readAdapterExposure(client: Pick<PublicClient, "readContract">, payer: Address): Promise<AdapterExposure | null> {
  try {
    const [usdc, eurc, btc, authorized] = await Promise.all([
      ...TOKENS.map((t) => client.readContract({ address: t.address, abi: erc20Abi, functionName: "allowance", args: [payer, CIRCLE_SWAP_ADAPTER] })),
      client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "isAuthorized", args: [payer, CIRCLE_SWAP_ADAPTER] }),
    ]);
    if (typeof usdc !== "bigint" || typeof eurc !== "bigint" || typeof btc !== "bigint" || typeof authorized !== "boolean") return null;
    return { allowances: { USDC: usdc, EURC: eurc, cirBTC: btc }, authorized };
  } catch {
    return null;
  }
}

// True only when the adapter holds no allowance in any of the three tokens and no Morpho authorization. Used on the
// read-back after a conversion: it must be true again, whatever the batch did.
export const exposureIsClear = (e: AdapterExposure | null): boolean =>
  e !== null && e.allowances.USDC === 0n && e.allowances.EURC === 0n && e.allowances.cirBTC === 0n && !e.authorized;

export type Preflight =
  | { state: "clear" }
  | { state: "blocked"; blockers: string[]; reset: Batch }
  | { state: "unreadable"; text: string };

export const ADAPTER_UNREADABLE =
  "Adag could not read what Circle's swap adapter is allowed to do with your wallet, so it cannot offer a conversion. Try again in a moment.";

// Before a conversion is offered: every allowance to the adapter other than the one this batch sets itself must read 0,
// and the adapter must not be authorised on Morpho. Anything else blocks with a plain sentence and a batch that clears it.
// The loan currency's own allowance is not a blocker: the batch overwrites it with exactly the amount sold, then sets 0.
export function adapterPreflight(payer: Address, exposure: AdapterExposure | null, loanToken: Address): Preflight {
  if (!exposure) return { state: "unreadable", text: ADAPTER_UNREADABLE };
  const blockers: string[] = [];
  const tokens: Address[] = [];
  for (const t of TOKENS) {
    if (t.address.toLowerCase() === loanToken.toLowerCase() || exposure.allowances[t.symbol] === 0n) continue;
    blockers.push(`Circle's swap adapter can already spend your ${t.symbol}: an earlier approval is still open. A conversion waits until it is set to 0.`);
    tokens.push(t.address);
  }
  if (exposure.authorized) {
    blockers.push("Circle's swap adapter is authorised to act on your Morpho loans. A conversion waits until that is withdrawn.");
  }
  if (blockers.length === 0) return { state: "clear" };
  return { state: "blocked", blockers, reset: buildAdapterReset(payer, { tokens, deauthorize: exposure.authorized }) };
}

export async function checkAdapterPreflight(client: Pick<PublicClient, "readContract">, payer: Address, loanToken: Address): Promise<Preflight> {
  return adapterPreflight(payer, await readAdapterExposure(client, payer), loanToken);
}
