import type { Address } from "viem";
import { keys, normaliseAddress, normaliseChatId } from "../store/keys";
import type { Store } from "../store/upstash";

// Adag keeps at most this many linked wallets; past it, new links wait until someone unlinks.
export const MAX_LINKED = 10_000;

// Binds a wallet to a chat both ways, and drops whatever either side was linked to before, so one wallet has one
// chat and one chat has one wallet.
export async function bind(store: Store, wallet: Address, chatId: string): Promise<boolean> {
  const address = normaliseAddress(wallet);
  const chat = normaliseChatId(chatId);
  if ((await store.scard(keys.linked())) >= MAX_LINKED && (await store.get(keys.link(address))) === null) return false;

  const previousChat = await store.get(keys.link(address));
  if (previousChat && previousChat !== chat) await store.del(keys.chat(previousChat));
  const previousWallet = await store.get(keys.chat(chat));
  if (previousWallet && previousWallet !== address) {
    await store.del(keys.link(previousWallet));
    await store.srem(keys.linked(), normaliseAddress(previousWallet));
  }
  await store.set(keys.link(address), chat);
  await store.set(keys.chat(chat), address);
  await store.sadd(keys.linked(), address);
  return true;
}

export async function unbind(store: Store, wallet: Address): Promise<void> {
  const address = normaliseAddress(wallet);
  const chat = await store.getdel(keys.link(address));
  if (chat && (await store.get(keys.chat(chat))) === address) await store.del(keys.chat(chat));
  await store.srem(keys.linked(), address);
}
