import { isAddressEqual, recoverTypedDataAddress, type PublicClient } from "viem";
import { arcClient } from "@/lib/arc/client";
import { assertSafeTxShape } from "@/lib/safe/multisend";
import { InputError, proposeBody, readCappedJson } from "@/lib/safe/parse";
import { NOT_CONFIGURED, json, safeService, serviceError, withTimeout } from "@/lib/safe/service";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { TOO_MANY, limitRoute } from "@/lib/store/limit";
import { safeTxHash, safeTxTypedData, safeTxToJson } from "@/lib/safe/typedData";
import { onChainSafeTxHash, verifySafe } from "@/lib/safe/verify";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Proposes a payment to a Safe's queue. Nothing from the browser is trusted: the shape is checked again (C51), the Safe
// and the owner are read from the chain (C52), the hash is re-derived from the fields and compared with the Safe's own
// getTransactionHash, and the signature must recover to that owner. Only then does the server call the service, and
// afterwards it checks the service's echo of the same hash.
export async function POST(request: Request) {
  const service = safeService();
  if (!service) return json({ error: NOT_CONFIGURED }, 503);
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!(await limitRoute(store, request, "safe-propose", 10, 100))) return json({ error: TOO_MANY }, 429);

  let body;
  try {
    body = proposeBody(await readCappedJson(request));
  } catch (error) {
    return json({ error: error instanceof InputError ? error.message : "The request could not be read." }, 400);
  }
  const { safe, owner, tx, signature } = body;

  try {
    assertSafeTxShape(safe, tx);
  } catch (error) {
    return json({ error: (error as Error).message }, 422);
  }

  const client = arcClient as PublicClient;
  try {
    const info = await verifySafe(client, safe, owner);
    if (tx.nonce !== info.nonce) return json({ error: "The nonce is not the Safe's current one. Build the payment again." }, 422);
    const local = safeTxHash(safe, tx);
    const chain = await onChainSafeTxHash(client, safe, tx);
    if (local.toLowerCase() !== body.safeTxHash || chain.toLowerCase() !== body.safeTxHash) {
      return json({ error: "The signed hash does not match this payment." }, 422);
    }
    const signer = await recoverTypedDataAddress({ ...safeTxTypedData(safe, tx), signature });
    if (!isAddressEqual(signer, owner)) return json({ error: "The signature is not from this owner." }, 422);
  } catch (error) {
    return json({ error: (error as Error).message.slice(0, 200) }, 422);
  }

  try {
    const fields = safeTxToJson(tx);
    await withTimeout(
      service.proposeTransaction({
        safeAddress: safe,
        safeTransactionData: { ...fields, nonce: Number(fields.nonce) },
        safeTxHash: body.safeTxHash,
        senderAddress: owner,
        senderSignature: signature,
        origin: "Adag",
      }),
    );
    const echo = await withTimeout(service.getTransaction(body.safeTxHash));
    // C52: the service must hold exactly what was signed.
    if (echo.safeTxHash.toLowerCase() !== body.safeTxHash || String(echo.nonce) !== fields.nonce || echo.data?.toLowerCase() !== tx.data.toLowerCase()) {
      return json({ error: "The Safe service's copy of the proposal does not match what was signed." }, 502);
    }
    return json({ ok: true, safeTxHash: body.safeTxHash, confirmations: echo.confirmations?.length ?? 0, threshold: echo.confirmationsRequired });
  } catch (error) {
    const e = serviceError(error);
    return json({ error: e.message }, e.status);
  }
}
