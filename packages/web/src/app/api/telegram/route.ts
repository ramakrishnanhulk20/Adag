import { handleUpdate, parseUpdate } from "@/lib/alerts/bot";
import { InputError, json, readCappedJson, sameSecret } from "@/lib/alerts/http";
import { TELEGRAM_MISSING, telegramFromEnv } from "@/lib/alerts/telegram";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Telegram's webhook. setWebhook's secret_token comes back in this header on every delivery (C44); anything without
// it is dropped unread.
export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  const telegram = telegramFromEnv();
  if (!secret || !telegram) return json({ error: TELEGRAM_MISSING }, 503);
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!sameSecret(request.headers.get("x-telegram-bot-api-secret-token"), secret)) return json({ error: "Not allowed." }, 401);

  let body;
  try {
    body = await readCappedJson(request, 64 * 1024);
  } catch (error) {
    return json({ error: error instanceof InputError ? error.message : "Unreadable." }, 400);
  }
  const update = parseUpdate(body);
  if (!update) return json({ ok: true });
  try {
    await handleUpdate(update, store, telegram);
  } catch {
    // A non-2xx makes Telegram retry, and the update id guard keeps the retry from acting twice.
    return json({ error: "Try again." }, 500);
  }
  return json({ ok: true });
}
