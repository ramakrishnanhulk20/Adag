// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { isLocale, type Locale } from "../../i18n/locales";
import { keys, normaliseChatId, normaliseCode } from "../store/keys";
import type { Store } from "../store/upstash";

export const LINK_CODE_BYTES = 24;
export const LINK_CODE_TTL_MS = 10 * 60_000;

// 24 bytes from the platform's cryptographic source (C46), as 32 characters of base64url, which is exactly the
// alphabet a Telegram start payload allows.
export function newLinkCode(nowMs: number = Date.now()): { code: string; expiresAt: number } {
  const bytes = new Uint8Array(LINK_CODE_BYTES);
  globalThis.crypto.getRandomValues(bytes);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const code = btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return { code: normaliseCode(code), expiresAt: nowMs + LINK_CODE_TTL_MS };
}

// The code record is "issued", or "issued:<lang>" when the owner was reading Adag in another language (I4). English
// writes the bare form, so records from before the languages existed and English records read the same way.
const issuedValue = (lang: Locale | undefined) => (lang && lang !== "en" ? `issued:${lang}` : "issued");

function issuedLang(value: string | null): Locale | null {
  if (value === "issued") return "en";
  if (value && value.startsWith("issued:")) {
    const lang = value.slice("issued:".length);
    return isLocale(lang) ? lang : "en";
  }
  return null;
}

export async function issueCode(store: Store, nowMs: number = Date.now(), lang?: Locale): Promise<{ code: string; expiresAt: number }> {
  const issued = newLinkCode(nowMs);
  if (!(await store.set(keys.code(issued.code), issuedValue(lang), { nx: true, px: LINK_CODE_TTL_MS }))) throw new Error("Could not issue a code.");
  return issued;
}

// `lang` is present only when it is not English, so a pending record reads exactly as it did before the languages existed.
export type PendingChat = { chatId: string; handle: string | null; lang?: Locale };

// Telegram usernames are 5 to 32 letters, digits and underscores. Anything else is not a username and is dropped,
// so no free text from Telegram ever reaches a message a wallet signs.
export function cleanHandle(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_]{5,32}$/.test(value) ? value : null;
}

// "/start <code>" from a verified Telegram request: the code is taken with GETDEL, so the first chat to present it
// is the only one that ever can (C46). It then waits, bound to that chat, for the wallet's signature. The language
// the code was issued with rides along, so the bot's replies and the alerts can use it (I4).
export async function claimCodeWithLang(store: Store, code: string, chat: { id: unknown; handle: unknown }): Promise<{ claimed: boolean; lang: Locale }> {
  const chatId = normaliseChatId(chat.id);
  const lang = issuedLang(await store.getdel(keys.code(code)));
  if (lang === null) return { claimed: false, lang: "en" };
  const pending: PendingChat = { chatId, handle: cleanHandle(chat.handle), ...(lang !== "en" ? { lang } : {}) };
  return { claimed: await store.set(keys.pending(code), JSON.stringify(pending), { nx: true, px: LINK_CODE_TTL_MS }), lang };
}

export async function claimCode(store: Store, code: string, chat: { id: unknown; handle: unknown }): Promise<boolean> {
  return (await claimCodeWithLang(store, code, chat)).claimed;
}

export function parsePending(raw: string | null): PendingChat | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { chatId?: unknown; handle?: unknown; lang?: unknown };
    const lang = isLocale(value.lang) && value.lang !== "en" ? value.lang : undefined;
    return { chatId: normaliseChatId(value.chatId), handle: cleanHandle(value.handle), ...(lang ? { lang } : {}) };
  } catch {
    return null;
  }
}

export async function readPending(store: Store, code: string): Promise<PendingChat | null> {
  return parsePending(await store.get(keys.pending(code)));
}

// Consumed once: a second link with the same code finds nothing.
export async function consumePending(store: Store, code: string): Promise<PendingChat | null> {
  return parsePending(await store.getdel(keys.pending(code)));
}
