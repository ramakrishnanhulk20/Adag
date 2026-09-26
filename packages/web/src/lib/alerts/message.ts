// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node. The app builds the
// same text in the browser for the wallet to sign; the server rebuilds it from its own values and checks it (C46, C47).
import { isAddressEqual, recoverMessageAddress, type Address, type Hex } from "viem";
import { CHAIN_ID } from "../arc/constants";
import { MAX_LEVEL_WAD, MAX_LEVELS, MIN_LEVEL_WAD } from "../guard/constants";
import { normaliseAddress, normaliseChatId, normaliseCode, normaliseNonce } from "../store/keys";
import { cleanHandle } from "./code";

export type SignedAction =
  | { action: "link"; wallet: string; code: string; chatId: string; chatHandle: string | null; expiry: number }
  | { action: "unlink"; wallet: string; nonce: string; expiry: number }
  | { action: "thresholds"; wallet: string; nonce: string; expiry: number; levelsWad: bigint[] };

export class MessageError extends Error {}

export const MAX_SIGNED_LIFETIME_SECONDS = 15 * 60;
const BASIS_POINT_WAD = 10n ** 14n;

// Signed levels are whole basis points between 5% and 85%, rising, at most three, so each has one exact percent form.
export function checkLevels(levels: unknown): bigint[] {
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > MAX_LEVELS) throw new MessageError("Choose one to three alert levels.");
  const out: bigint[] = [];
  for (const level of levels) {
    if (typeof level !== "string" || !/^[1-9][0-9]{0,18}$/.test(level)) throw new MessageError("Each level must be a whole number.");
    const wad = BigInt(level);
    if (wad < MIN_LEVEL_WAD || wad > MAX_LEVEL_WAD || wad % BASIS_POINT_WAD !== 0n) throw new MessageError("Each level must be between 5% and 85%, in steps of 0.01%.");
    if (out.length && wad <= out[out.length - 1]!) throw new MessageError("Levels must rise.");
    out.push(wad);
  }
  return out;
}

export function percentOfWad(wad: bigint): string {
  const bp = (wad + BASIS_POINT_WAD / 2n) / BASIS_POINT_WAD;
  return `${bp / 100n}.${(bp % 100n).toString().padStart(2, "0")}%`;
}

function checkSite(site: string): string {
  let url: URL;
  try {
    url = new URL(site);
  } catch {
    throw new MessageError("The site origin is not a URL.");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1"))) {
    throw new MessageError("The site origin must be https.");
  }
  return url.origin;
}

function checkExpiry(expiry: unknown): number {
  if (typeof expiry !== "number" || !Number.isSafeInteger(expiry) || expiry <= 0) throw new MessageError("The expiry is not a time.");
  return expiry;
}

export function buildMessage(site: string, input: SignedAction): string {
  const wallet = normaliseAddress(input.wallet);
  const expiry = checkExpiry(input.expiry);
  const head = [`Site: ${checkSite(site)}`, `Chain: ${CHAIN_ID}`, `Wallet: ${wallet}`];
  const tail = [`Expires: ${new Date(expiry * 1000).toISOString()} (${expiry})`];
  switch (input.action) {
    case "link": {
      const chatId = normaliseChatId(input.chatId);
      const handle = cleanHandle(input.chatHandle);
      return [
        "Adag alerts: link this wallet to a Telegram chat",
        ...head,
        `Code: ${normaliseCode(input.code)}`,
        `Chat: ${handle ? `@${handle} ` : ""}(id ${chatId})`,
        ...tail,
      ].join("\n");
    }
    case "unlink":
      return ["Adag alerts: stop alerts for this wallet", ...head, `Nonce: ${normaliseNonce(input.nonce)}`, ...tail].join("\n");
    case "thresholds":
      return [
        "Adag alerts: set the loan levels that send an alert",
        ...head,
        `Levels: ${checkLevels(input.levelsWad.map(String)).map(percentOfWad).join(", ")}`,
        `Nonce: ${normaliseNonce(input.nonce)}`,
        ...tail,
      ].join("\n");
  }
}

const HALF_ORDER = 0x7fffffffffffffffffffffffffffffff5d576e7357a4501ddfe92f46681b20a0n;

// Strict (C46): exactly 65 bytes, a low s, a v of 27 or 28 (or 0 or 1), unexpired and not too far ahead, and it
// must recover to the named wallet. Contract wallets cannot pass this; they have no key to recover.
export async function verifySigned(input: { message: string; signature: unknown; wallet: string; expiry: number; nowSeconds: number }): Promise<boolean> {
  const { message, signature, expiry, nowSeconds } = input;
  if (typeof signature !== "string" || !/^0x[0-9a-fA-F]{130}$/.test(signature)) return false;
  if (!(expiry > nowSeconds && expiry <= nowSeconds + MAX_SIGNED_LIFETIME_SECONDS)) return false;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = parseInt(signature.slice(130, 132), 16);
  if (s === 0n || s > HALF_ORDER || ![0, 1, 27, 28].includes(v)) return false;
  let wallet: Address;
  try {
    wallet = normaliseAddress(input.wallet);
  } catch {
    return false;
  }
  try {
    const signer = await recoverMessageAddress({ message, signature: signature as Hex });
    return isAddressEqual(signer, wallet);
  } catch {
    return false;
  }
}
