// Browser helpers for the alerts routes. Every write carries a message the wallet signed, built with the same
// buildMessage the server uses to check it (C46, C47). Telegram itself is only ever reached by the server.
import type { Address, Hex } from "viem";
import { buildMessage, checkLevels, type SignedAction } from "./message";

export type Signer = (message: string) => Promise<Hex>;
type Answer<T> = { ok: true; value: T } | { ok: false; message: string };

async function post<T>(path: string, body: unknown): Promise<Answer<T>> {
  try {
    const res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as T & { error?: string };
    if (!res.ok) return { ok: false, message: typeof data.error === "string" ? data.error : `The server answered ${res.status}.` };
    return { ok: true, value: data };
  } catch {
    return { ok: false, message: "The server did not answer. Try again." };
  }
}

export function newNonce(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return `0x${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}`;
}

// Five minutes to sign: well inside the server's fifteen-minute limit.
export const expirySoon = () => Math.floor(Date.now() / 1000) + 300;

export const issueCode = () => post<{ code: string; expiresAt: number; link: string }>("/api/alerts/code", {});

export const codeStatus = (code: string) => post<{ state: "waiting" } | { state: "pressed"; chatId: string; chatHandle: string | null }>("/api/alerts/code/status", { code });

async function signed<T>(path: string, site: string, action: SignedAction, sign: Signer, extra: Record<string, unknown> = {}): Promise<Answer<T>> {
  let signature: Hex;
  try {
    signature = await sign(buildMessage(site, action));
  } catch {
    return { ok: false, message: "You declined in your wallet. Nothing was changed." };
  }
  return post<T>(path, { ...action, ...extra, signature });
}

export function linkChat(site: string, wallet: Address, code: string, chat: { chatId: string; chatHandle: string | null }, sign: Signer) {
  const action: SignedAction = { action: "link", wallet, code, chatId: chat.chatId, chatHandle: chat.chatHandle, expiry: expirySoon() };
  return signed<{ linked: true }>("/api/alerts/link", site, action, sign);
}

export function setLevels(site: string, wallet: Address, levelsWad: bigint[], sign: Signer) {
  const action: SignedAction = { action: "thresholds", wallet, nonce: newNonce(), expiry: expirySoon(), levelsWad };
  return signed<{ ok: true }>("/api/alerts/thresholds", site, action, sign, { levelsWad: levelsWad.map(String) });
}

export function unlink(site: string, wallet: Address, sign: Signer) {
  const action: SignedAction = { action: "unlink", wallet, nonce: newNonce(), expiry: expirySoon() };
  return signed<{ ok: true }>("/api/alerts/unlink", site, action, sign);
}

// Only this browser's own memory of linking, never asked of the server, which answers the same either way (C49).
const LINKED_KEY = "adag-alerts-linked:";
export function rememberLinked(wallet: Address, on: boolean) {
  try {
    if (on) window.localStorage.setItem(LINKED_KEY + wallet.toLowerCase(), String(Date.now()));
    else window.localStorage.removeItem(LINKED_KEY + wallet.toLowerCase());
  } catch {
    // Private mode: nothing is remembered, which only costs a hint.
  }
}
export function linkedHere(wallet: Address): number | null {
  try {
    const v = window.localStorage.getItem(LINKED_KEY + wallet.toLowerCase());
    return v ? Number(v) : null;
  } catch {
    return null;
  }
}

// The levels this browser last saved for a wallet, for the same reason: the server is never asked (C49). Unlinking
// leaves the levels on the server, so it leaves them here too. What comes back is checked like a fresh entry.
const LEVELS_KEY = "adag-alerts-levels:";
export type SavedLevels = { at: number; levelsWad: bigint[] };

export function rememberLevels(wallet: Address, levelsWad: bigint[]) {
  try {
    window.localStorage.setItem(LEVELS_KEY + wallet.toLowerCase(), JSON.stringify({ at: Date.now(), levels: levelsWad.map(String) }));
  } catch {
    // Private mode: the fields fall back to the defaults, which only costs a hint.
  }
}

export function savedLevels(wallet: Address): SavedLevels | null {
  try {
    const raw = window.localStorage.getItem(LEVELS_KEY + wallet.toLowerCase());
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { at?: unknown; levels?: unknown };
    if (typeof parsed.at !== "number" || !Number.isFinite(parsed.at)) return null;
    return { at: parsed.at, levelsWad: checkLevels(parsed.levels) };
  } catch {
    return null;
  }
}
