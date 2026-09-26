// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
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

export async function issueCode(store: Store, nowMs: number = Date.now()): Promise<{ code: string; expiresAt: number }> {
  const issued = newLinkCode(nowMs);
  if (!(await store.set(keys.code(issued.code), "issued", { nx: true, px: LINK_CODE_TTL_MS }))) throw new Error("Could not issue a code.");
  return issued;
}

export type PendingChat = { chatId: string; handle: string | null };

// Telegram usernames are 5 to 32 letters, digits and underscores. Anything else is not a username and is dropped,
// so no free text from Telegram ever reaches a message a wallet signs.
export function cleanHandle(value: unknown): string | null {
  return typeof value === "string" && /^[A-Za-z0-9_]{5,32}$/.test(value) ? value : null;
}

// "/start <code>" from a verified Telegram request: the code is taken with GETDEL, so the first chat to present it
// is the only one that ever can (C46). It then waits, bound to that chat, for the wallet's signature.
export async function claimCode(store: Store, code: string, chat: { id: unknown; handle: unknown }): Promise<boolean> {
  const chatId = normaliseChatId(chat.id);
  if ((await store.getdel(keys.code(code))) !== "issued") return false;
  const pending: PendingChat = { chatId, handle: cleanHandle(chat.handle) };
  return store.set(keys.pending(code), JSON.stringify(pending), { nx: true, px: LINK_CODE_TTL_MS });
}

export function parsePending(raw: string | null): PendingChat | null {
  if (raw === null) return null;
  try {
    const value = JSON.parse(raw) as { chatId?: unknown; handle?: unknown };
    return { chatId: normaliseChatId(value.chatId), handle: cleanHandle(value.handle) };
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
