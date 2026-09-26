import { consumePending, readPending } from "@/lib/alerts/code";
import { InputError, json, readCappedJson } from "@/lib/alerts/http";
import { bind } from "@/lib/alerts/links";
import { checkSignedWrite } from "@/lib/alerts/signed";
import { TELEGRAM_MISSING, telegramFromEnv } from "@/lib/alerts/telegram";
import { linkedText, movedText, refusedText } from "@/lib/alerts/text";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { KeyError, keys, normaliseAddress, normaliseCode } from "@/lib/store/keys";
import { allow, clientOf } from "@/lib/store/limit";
import { siteUrl } from "@/lib/wallet/site";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step three: { wallet, code, expiry, signature }. The chat comes from the store, where only a verified Telegram
// request could have put it, never from this form (C46). The code is spent in the same step that binds.
export async function POST(request: Request) {
  const telegram = telegramFromEnv();
  if (!telegram) return json({ error: TELEGRAM_MISSING }, 503);
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!(await allow(store, keys.rate("link", clientOf(request)), 20, 600))) return json({ error: "Too many attempts. Try again in a few minutes." }, 429);

  let wallet: string;
  let code: string;
  let body: Record<string, unknown>;
  try {
    body = await readCappedJson(request);
    wallet = normaliseAddress(body.wallet);
    code = normaliseCode(body.code);
  } catch (error) {
    if (error instanceof InputError || error instanceof KeyError) return json({ error: error.message }, 400);
    throw error;
  }
  if (!(await allow(store, keys.rate("link", code), 5, 600))) return json({ error: "Too many attempts with this code." }, 429);

  const pending = await readPending(store, code);
  if (!pending) return json({ error: "This code has expired or was already used. Start again." }, 410);
  const check = await checkSignedWrite(
    store,
    { action: "link", wallet, code, chatId: pending.chatId, chatHandle: pending.handle, expiry: body.expiry as number },
    body.signature,
  );
  if (!check.ok) return json({ error: check.error }, check.status);

  const spent = await consumePending(store, code);
  if (!spent || spent.chatId !== pending.chatId) return json({ error: "This code has expired or was already used. Start again." }, 410);
  // The code stays spent whatever happens next, so a refused attempt cannot be replayed.
  const bound = await bind(store, check.wallet, spent.chatId);
  if (!bound.ok && bound.reason === "chat-taken") {
    await telegram.send(spent.chatId, refusedText(check.wallet));
    return json({ error: "That chat already gets Adag alerts for another wallet. Send /stop in that chat, then link again." }, 409);
  }
  if (!bound.ok) return json({ error: "Alerts are full right now. Try again later." }, 503);
  await telegram.send(spent.chatId, linkedText(siteUrl(), check.wallet));
  if (bound.previousChat) await telegram.send(bound.previousChat, movedText(check.wallet));
  return json({ linked: true });
}
