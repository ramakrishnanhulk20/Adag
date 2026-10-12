import { jsonError } from "@/i18n/server";
import { consumePending, readPending } from "@/lib/alerts/code";
import { InputError, json, readCappedJson } from "@/lib/alerts/http";
import { bind, langOfChat } from "@/lib/alerts/links";
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
// request could have put it, never from this form (C46). The code is spent in the same step that binds. The signed
// message is the fixed English text buildMessage writes, whatever language the page was in (I3).
export async function POST(request: Request) {
  const telegram = telegramFromEnv();
  if (!telegram) return jsonError(TELEGRAM_MISSING, 503);
  const store = storeFromEnv();
  if (!store) return jsonError(STORE_MISSING, 503);
  if (!(await allow(store, keys.rate("link", clientOf(request)), 20, 600))) return jsonError("Too many attempts. Try again in a few minutes.", 429);

  let wallet: string;
  let code: string;
  let body: Record<string, unknown>;
  try {
    body = await readCappedJson(request);
    wallet = normaliseAddress(body.wallet);
    code = normaliseCode(body.code);
  } catch (error) {
    if (error instanceof InputError || error instanceof KeyError) return jsonError(error.message, 400);
    throw error;
  }
  if (!(await allow(store, keys.rate("link", code), 5, 600))) return jsonError("Too many attempts with this code.", 429);

  const pending = await readPending(store, code);
  if (!pending) return jsonError("This code has expired or was already used. Start again.", 410);
  const check = await checkSignedWrite(
    store,
    { action: "link", wallet, code, chatId: pending.chatId, chatHandle: pending.handle, expiry: body.expiry as number },
    body.signature,
  );
  if (!check.ok) return jsonError(check.error, check.status);

  const spent = await consumePending(store, code);
  if (!spent || spent.chatId !== pending.chatId) return jsonError("This code has expired or was already used. Start again.", 410);
  // The language the code was issued with becomes the chat's (I4). The code stays spent whatever happens next, so a
  // refused attempt cannot be replayed.
  const lang = spent.lang ?? "en";
  const bound = await bind(store, check.wallet, spent.chatId, lang);
  if (!bound.ok && bound.reason === "chat-taken") {
    // The refused chat already belongs to another wallet: it is told in its own language.
    await telegram.send(spent.chatId, refusedText(check.wallet, await langOfChat(store, spent.chatId)));
    return jsonError("That chat already gets Adag alerts for another wallet. Send /stop in that chat, then link again.", 409);
  }
  if (!bound.ok) return jsonError("Alerts are full right now. Try again later.", 503);
  await telegram.send(spent.chatId, linkedText(siteUrl(), check.wallet, lang));
  if (bound.previousChat) await telegram.send(bound.previousChat, movedText(check.wallet, await langOfChat(store, bound.previousChat)));
  return json({ linked: true });
}
