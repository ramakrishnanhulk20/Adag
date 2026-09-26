import type { Address } from "viem";
import { keys, normaliseAddress, normaliseNonce } from "../store/keys";
import type { Store } from "../store/upstash";
import { siteUrl } from "../wallet/site";
import { buildMessage, verifySigned, type SignedAction } from "./message";

export type SignedCheck = { ok: true; wallet: Address } | { ok: false; status: number; error: string };

// Every change to a wallet's server state (C47): the server rebuilds the message from its own values, checks the
// signature strictly, and only then spends the nonce, once. A stranger cannot use up someone else's nonce.
export async function checkSignedWrite(store: Store, action: SignedAction, signature: unknown): Promise<SignedCheck> {
  let message: string;
  let wallet: Address;
  try {
    wallet = normaliseAddress(action.wallet);
    message = buildMessage(siteUrl(), action);
  } catch (error) {
    return { ok: false, status: 400, error: (error as Error).message };
  }
  const nowSeconds = Math.floor(Date.now() / 1000);
  if (!(await verifySigned({ message, signature, wallet, expiry: action.expiry, nowSeconds }))) {
    return { ok: false, status: 401, error: "The signature does not match this wallet and message, or it has expired." };
  }
  if (action.action !== "link") {
    const nonce = normaliseNonce(action.nonce);
    const ttl = Math.max(1, action.expiry - nowSeconds) * 1000;
    if (!(await store.set(keys.nonce(nonce), "1", { nx: true, px: ttl }))) return { ok: false, status: 409, error: "This signed message was already used." };
  }
  return { ok: true, wallet };
}
