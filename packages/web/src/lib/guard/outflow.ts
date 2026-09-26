// Plain TypeScript with relative imports only. Browser-safe.
import type { Address, PublicClient } from "viem";
import { MARKET_EURC, MARKET_USDC } from "../arc/constants";
import { guardAbi } from "./abi";
import { ADAG_GUARD } from "./constants";

// C45: a rule that would act now will pull this much of the wallet's USDC and EURC within minutes. The pay screens
// count it as already spent when they check the wallet can cover a payment and its fee. A failed read is not zero:
// the caller gets null and should say the check could not be made.
export async function pendingGuardOutflow(client: Pick<PublicClient, "readContract">, owner: Address): Promise<{ usdc: bigint; eurc: bigint } | null> {
  if (!ADAG_GUARD) return { usdc: 0n, eurc: 0n };
  try {
    const [usdc, eurc] = await Promise.all(
      [MARKET_USDC, MARKET_EURC].map((market) => client.readContract({ address: ADAG_GUARD!, abi: guardAbi, functionName: "quote", args: [owner, market] })),
    );
    return { usdc: usdc![0] ? usdc![1] : 0n, eurc: eurc![0] ? eurc![1] : 0n };
  } catch {
    return null;
  }
}
