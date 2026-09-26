import { readPending } from "@/lib/alerts/code";
import { InputError, json, readCappedJson } from "@/lib/alerts/http";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { KeyError, keys, normaliseCode } from "@/lib/store/keys";
import { allow, clientOf } from "@/lib/store/limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step two: once the person pressed Start, whoever holds the code learns which chat pressed it, so the wallet can
// sign a message that names that chat. The code is the only key; nothing here is looked up by wallet (C49).
export async function POST(request: Request) {
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!(await allow(store, keys.rate("link", clientOf(request)), 60, 600))) return json({ error: "Too many requests. Try again in a few minutes." }, 429);
  let code: string;
  try {
    code = normaliseCode((await readCappedJson(request)).code);
  } catch (error) {
    if (error instanceof InputError || error instanceof KeyError) return json({ error: error.message }, 400);
    throw error;
  }
  const pending = await readPending(store, code);
  return json(pending ? { state: "pressed", chatId: pending.chatId, chatHandle: pending.handle } : { state: "waiting" });
}
