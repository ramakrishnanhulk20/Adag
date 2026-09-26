import { InputError, json, readCappedJson } from "@/lib/alerts/http";
import { unbind } from "@/lib/alerts/links";
import { checkSignedWrite } from "@/lib/alerts/signed";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { keys } from "@/lib/store/keys";
import { allow, clientOf } from "@/lib/store/limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// { wallet, nonce, expiry, signature }. The answer is the same whether or not the wallet was linked (C49).
export async function POST(request: Request) {
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!(await allow(store, keys.rate("signed", clientOf(request)), 30, 600))) return json({ error: "Too many requests. Try again in a few minutes." }, 429);
  let body: Record<string, unknown>;
  try {
    body = await readCappedJson(request);
  } catch (error) {
    if (error instanceof InputError) return json({ error: error.message }, 400);
    throw error;
  }
  const check = await checkSignedWrite(
    store,
    { action: "unlink", wallet: String(body.wallet ?? ""), nonce: String(body.nonce ?? ""), expiry: body.expiry as number },
    body.signature,
  );
  if (!check.ok) return json({ error: check.error }, check.status);
  await unbind(store, check.wallet);
  return json({ ok: true });
}
