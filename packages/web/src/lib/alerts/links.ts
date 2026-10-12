import type { Address } from "viem";
import { isLocale, type Locale } from "../../i18n/locales";
import { keys, normaliseAddress, normaliseChatId } from "../store/keys";
import type { Store } from "../store/upstash";

// Adag keeps at most this many linked wallets; past it, new links wait until someone unlinks.
export const MAX_LINKED = 10_000;

export type BindResult = { ok: true; previousChat: string | null } | { ok: false; reason: "full" | "chat-taken" };

// Binds a wallet to a chat both ways, so one wallet has one chat and one chat has one wallet. A chat that already
// gets alerts for another wallet is never taken over: its owner sends /stop first. A wallet that moves chats says
// which chat it left, so that chat can be told. The chat's language is kept beside it (I4); English keeps no record,
// so a link made before the languages existed and an English link read the same way.
export async function bind(store: Store, wallet: Address, chatId: string, lang: Locale = "en"): Promise<BindResult> {
  const address = normaliseAddress(wallet);
  const chat = normaliseChatId(chatId);

  const holder = await store.get(keys.chat(chat));
  // Taken only if that wallet's own link still points here; a half-written pair from an old failure is not a claim.
  if (holder && holder !== address && (await store.get(keys.link(holder))) === chat) return { ok: false, reason: "chat-taken" };

  const previous = await store.get(keys.link(address));
  if (previous === null && (await store.scard(keys.linked())) >= MAX_LINKED) return { ok: false, reason: "full" };
  if (previous && previous !== chat && (await store.get(keys.chat(previous))) === address) {
    await store.del(keys.chat(previous));
    await store.del(keys.chatLang(previous));
  }

  await store.set(keys.link(address), chat);
  await store.set(keys.chat(chat), address);
  if (lang !== "en") await store.set(keys.chatLang(chat), lang);
  else await store.del(keys.chatLang(chat));
  await store.sadd(keys.linked(), address);
  return { ok: true, previousChat: previous && previous !== chat ? previous : null };
}

export async function unbind(store: Store, wallet: Address): Promise<void> {
  const address = normaliseAddress(wallet);
  const chat = await store.getdel(keys.link(address));
  if (chat && (await store.get(keys.chat(chat))) === address) {
    await store.del(keys.chat(chat));
    await store.del(keys.chatLang(chat));
  }
  await store.srem(keys.linked(), address);
}

// The language a chat is written to in. No record, or a value that is not one of the five, means English (I4).
export async function langOfChat(store: Store, chatId: string | null): Promise<Locale> {
  if (!chatId) return "en";
  try {
    const raw = await store.get(keys.chatLang(chatId));
    return isLocale(raw) ? raw : "en";
  } catch {
    return "en";
  }
}
