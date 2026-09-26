// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { getAddress, isAddress, sha256, stringToHex, type Address } from "viem";
import { MARKET_EURC, MARKET_USDC } from "../arc/constants";

declare const storeKeyBrand: unique symbol;
// Every key the store sees comes out of `keys` below, so one wallet or chat can never live under two spellings (C49).
export type StoreKey = string & { readonly [storeKeyBrand]: true };

export class KeyError extends Error {}

const ZERO = "0x0000000000000000000000000000000000000000";

export function normaliseAddress(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new KeyError("That is not a wallet address.");
  const address = getAddress(value);
  if (address === ZERO) throw new KeyError("The zero address is not a wallet.");
  return address;
}

// Telegram chat ids are signed integers that fit in 52 bits. Accepting a number or its decimal text, and returning
// the text, keeps "123", 123 and "0123" from becoming three different chats.
export function normaliseChatId(value: unknown): string {
  let id: number;
  if (typeof value === "number") id = value;
  else if (typeof value === "string" && /^-?[1-9][0-9]{0,15}$/.test(value)) id = Number(value);
  else throw new KeyError("That is not a chat id.");
  if (!Number.isSafeInteger(id) || id === 0) throw new KeyError("That is not a chat id.");
  return String(id);
}

// Link codes are 32 characters of base64url: 192 random bits, inside Telegram's start-payload alphabet.
export function normaliseCode(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{32}$/.test(value)) throw new KeyError("That is not a link code.");
  return value;
}

// Signed-message nonces are 16 random bytes as lowercase hex.
export function normaliseNonce(value: unknown): string {
  if (typeof value !== "string" || !/^0x[0-9a-fA-F]{32}$/.test(value)) throw new KeyError("That is not a nonce.");
  return value.toLowerCase();
}

export function normaliseMarket(value: unknown): typeof MARKET_USDC | typeof MARKET_EURC {
  if (typeof value !== "string") throw new KeyError("That is not a market.");
  const lower = value.toLowerCase();
  if (lower === MARKET_USDC) return MARKET_USDC;
  if (lower === MARKET_EURC) return MARKET_EURC;
  throw new KeyError("That is not one of Adag's two markets.");
}

// A webhook nonce or a client address is only ever a rate-limit or replay subject, so anything odd collapses to one bucket.
function subject(value: unknown): string {
  return typeof value === "string" && /^[0-9A-Za-z:._-]{1,64}$/.test(value) ? value : "other";
}

const PREFIX = "adag:v1";
const key = (...parts: string[]) => [PREFIX, ...parts].join(":") as StoreKey;

export const keys = {
  lease: () => key("keeper", "lease"),
  cursor: () => key("keeper", "cursor"),
  feeHour: (hour: number) => key("keeper", "fee", String(Math.trunc(hour))),
  backoff: (borrower: unknown, market: unknown) => key("keeper", "backoff", normaliseAddress(borrower), normaliseMarket(market)),
  code: (code: unknown) => key("alerts", "code", normaliseCode(code)),
  pending: (code: unknown) => key("alerts", "pending", normaliseCode(code)),
  link: (wallet: unknown) => key("alerts", "link", normaliseAddress(wallet)),
  chat: (chatId: unknown) => key("alerts", "chat", normaliseChatId(chatId)),
  linked: () => key("alerts", "linked"),
  thresholds: (wallet: unknown) => key("alerts", "thresholds", normaliseAddress(wallet)),
  level: (wallet: unknown, market: unknown) => key("alerts", "level", normaliseAddress(wallet), normaliseMarket(market)),
  nonce: (nonce: unknown) => key("alerts", "nonce", normaliseNonce(nonce)),
  update: (updateId: unknown) => {
    if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) throw new KeyError("That is not an update id.");
    return key("telegram", "update", String(updateId));
  },
  // The SHA-256 of the exact nonce the signature covered, so no change in QuickNode's nonce format can ever merge
  // two deliveries into one replay key.
  hookNonce: (nonce: string) => key("hooks", "nonce", sha256(stringToHex(nonce)).slice(2)),
  // "code-status" is its own bucket because the alerts panel polls it every few seconds while a person finds Telegram;
  // sharing "link" would spend the link's allowance before they press Start (C61).
  rate: (bucket: "code" | "code-status" | "start" | "link" | "signed" | "safe-list" | "safe-status" | "safe-propose", who: unknown) =>
    key("rate", bucket, subject(who)),
  // The landing page's index of BillPaid events: one record and one lease per AdagBills deployment.
  paidIndex: (contract: unknown) => key("paid", "index", normaliseAddress(contract)),
  paidLease: (contract: unknown) => key("paid", "lease", normaliseAddress(contract)),
};
