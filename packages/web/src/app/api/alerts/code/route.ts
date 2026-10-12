import { jsonError } from "@/i18n/server";
import { isLocale } from "@/i18n/locales";
import { issueCode } from "@/lib/alerts/code";
import { InputError, json, readCappedJson } from "@/lib/alerts/http";
import { TELEGRAM_MISSING, telegramFromEnv } from "@/lib/alerts/telegram";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { keys } from "@/lib/store/keys";
import { allow, clientOf } from "@/lib/store/limit";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// Step one of linking: a fresh one-time code and the bot link that carries it. It names no wallet and no chat. The
// body may name the language the owner is reading in; anything but one of the five is English (I1, I4).
export async function POST(request: Request) {
  const telegram = telegramFromEnv();
  if (!telegram) return jsonError(TELEGRAM_MISSING, 503);
  const store = storeFromEnv();
  if (!store) return jsonError(STORE_MISSING, 503);
  if (!(await allow(store, keys.rate("code", clientOf(request)), 10, 600))) return jsonError("Too many codes. Try again in a few minutes.", 429);
  let lang: string | undefined;
  try {
    const body = request.headers.get("content-length") === "0" || request.headers.get("content-length") === null ? {} : await readCappedJson(request);
    lang = typeof body.lang === "string" ? body.lang : undefined;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
  }

  const bot = await telegram.username();
  if (!bot) return jsonError("The Telegram bot did not answer. Try again in a minute.", 502);
  const { code, expiresAt } = await issueCode(store, Date.now(), isLocale(lang) ? lang : undefined);
  return json({ code, expiresAt, link: `https://t.me/${bot}?start=${code}` });
}
