import { InputError, json, readCappedJson } from "@/lib/alerts/http";
import { checkLevels, MessageError } from "@/lib/alerts/message";
import { checkSignedWrite } from "@/lib/alerts/signed";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { keys } from "@/lib/store/keys";
import { allow, clientOf } from "@/lib/store/limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// { wallet, nonce, expiry, levelsWad: ["600000000000000000", ...], signature }. Levels are whole WAD integers,
// checked for range, step and order before the signature is (C47). The answer never says whether the wallet is linked.
export async function POST(request: Request) {
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!(await allow(store, keys.rate("signed", clientOf(request)), 30, 600))) return json({ error: "Too many requests. Try again in a few minutes." }, 429);
  let body: Record<string, unknown>;
  let levels: bigint[];
  try {
    body = await readCappedJson(request);
    levels = checkLevels(body.levelsWad);
  } catch (error) {
    if (error instanceof InputError || error instanceof MessageError) return json({ error: error.message }, 400);
    throw error;
  }
  const check = await checkSignedWrite(
    store,
    { action: "thresholds", wallet: String(body.wallet ?? ""), nonce: String(body.nonce ?? ""), expiry: body.expiry as number, levelsWad: levels },
    body.signature,
  );
  if (!check.ok) return json({ error: check.error }, check.status);
  await store.set(keys.thresholds(check.wallet), JSON.stringify(levels.map(String)));
  return json({ ok: true });
}
