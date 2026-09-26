import type { Address } from "viem";
import { keys, normaliseAddress, normaliseChatId } from "../store/keys";
import type { Store } from "../store/upstash";

// Adag keeps at most this many linked wallets; past it, new links wait until someone unlinks.
export const MAX_LINKED = 10_000;

export type BindResult = { ok: true; previousChat: string | null } | { ok: false; reason: "full" | "chat-taken" };

// Binds a wallet to a chat both ways, so one wallet has one chat and one chat has one wallet. A chat that already
// gets alerts for another wallet is never taken over: its owner sends /stop first. A wallet that moves chats says
// which chat it left, so that chat can be told.
export async function bind(store: Store, wallet: Address, chatId: string): Promise<BindResult> {
  const address = normaliseAddress(wallet);
  const chat = normaliseChatId(chatId);

  const holder = await store.get(keys.chat(chat));
  // Taken only if that wallet's own link still points here; a half-written pair from an old failure is not a claim.
  if (holder && holder !== address && (await store.get(keys.link(holder))) === chat) return { ok: false, reason: "chat-taken" };

  const previous = await store.get(keys.link(address));
  if (previous === null && (await store.scard(keys.linked())) >= MAX_LINKED) return { ok: false, reason: "full" };
  if (previous && previous !== chat && (await store.get(keys.chat(previous))) === address) await store.del(keys.chat(previous));

  await store.set(keys.link(address), chat);
  await store.set(keys.chat(chat), address);
  await store.sadd(keys.linked(), address);
  return { ok: true, previousChat: previous && previous !== chat ? previous : null };
}

export async function unbind(store: Store, wallet: Address): Promise<void> {
  const address = normaliseAddress(wallet);
  const chat = await store.getdel(keys.link(address));
  if (chat && (await store.get(keys.chat(chat))) === address) await store.del(keys.chat(chat));
  await store.srem(keys.linked(), address);
}
