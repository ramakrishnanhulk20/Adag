import { issueCode } from "@/lib/alerts/code";
import { json } from "@/lib/alerts/http";
import { TELEGRAM_MISSING, telegramFromEnv } from "@/lib/alerts/telegram";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { keys } from "@/lib/store/keys";
import { allow, clientOf } from "@/lib/store/limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step one of linking: a fresh one-time code and the bot link that carries it. It names no wallet and no chat.
export async function POST(request: Request) {
  const telegram = telegramFromEnv();
  if (!telegram) return json({ error: TELEGRAM_MISSING }, 503);
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);
  if (!(await allow(store, keys.rate("code", clientOf(request)), 10, 600))) return json({ error: "Too many codes. Try again in a few minutes." }, 429);

  const bot = await telegram.username();
  if (!bot) return json({ error: "The Telegram bot did not answer. Try again in a minute." }, 502);
  const { code, expiresAt } = await issueCode(store);
  return json({ code, expiresAt, link: `https://t.me/${bot}?start=${code}` });
}
