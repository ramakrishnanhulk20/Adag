import type { PublicClient } from "viem";
import { arcClient } from "@/lib/arc/client";
import { safeAbi } from "@/lib/safe/abi";
import { InputError, address, hash32 } from "@/lib/safe/parse";
import { NOT_CONFIGURED, json, safeService, serviceError, withTimeout } from "@/lib/safe/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Signatures so far out of the threshold, for the "waiting for your other owners" card. Whether the bill is paid never
// comes from here (C53): the page reads bill(id) from AdagBills for that.
export async function GET(request: Request) {
  const service = safeService();
  if (!service) return json({ error: NOT_CONFIGURED }, 503);
  let safe;
  let safeTxHash;
  try {
    const url = new URL(request.url);
    safe = address(url.searchParams.get("safe"), "The Safe");
    safeTxHash = hash32(url.searchParams.get("safeTxHash"), "The Safe transaction hash");
  } catch (error) {
    return json({ error: error instanceof InputError ? error.message : "The request could not be read." }, 400);
  }
  try {
    const [tx, chainNonce] = await Promise.all([
      withTimeout(service.getTransaction(safeTxHash)),
      withTimeout((arcClient as PublicClient).readContract({ address: safe, abi: safeAbi, functionName: "nonce" })),
    ]);
    if (tx.safe.toLowerCase() !== safe.toLowerCase()) return json({ error: "That transaction belongs to another Safe." }, 422);
    return json({
      confirmations: tx.confirmations?.length ?? 0,
      threshold: tx.confirmationsRequired,
      isExecuted: tx.isExecuted,
      transactionHash: tx.transactionHash ?? null,
      nonce: String(tx.nonce),
      // The Safe moved past this nonce: executed, or replaced by another transaction.
      nonceUsed: chainNonce > BigInt(tx.nonce),
    });
  } catch (error) {
    const e = serviceError(error);
    return json({ error: e.message }, e.status);
  }
}
