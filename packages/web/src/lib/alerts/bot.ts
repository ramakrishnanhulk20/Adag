import { KeyError, keys, normaliseAddress, normaliseChatId, normaliseCode } from "../store/keys";
import { allow } from "../store/limit";
import type { Store } from "../store/upstash";
import { claimCode } from "./code";
import type { Telegram } from "./telegram";
import { expiredText, helloText, pendingText, stoppedText } from "./text";

type Update = { updateId: number; chatId: string; handle: unknown; text: string };

// The one parser for a Telegram update (C57): only a private chat's text message is read; everything else is ignored.
export function parseUpdate(body: unknown): Update | null {
  if (typeof body !== "object" || body === null) return null;
  const { update_id: updateId, message } = body as { update_id?: unknown; message?: unknown };
  if (typeof updateId !== "number" || !Number.isSafeInteger(updateId) || updateId < 0) return null;
  if (typeof message !== "object" || message === null) return null;
  const { chat, from, text } = message as { chat?: { id?: unknown; type?: unknown }; from?: { username?: unknown }; text?: unknown };
  if (!chat || chat.type !== "private" || typeof text !== "string" || text.length > 200) return null;
  try {
    return { updateId, chatId: normaliseChatId(chat.id), handle: from?.username, text: text.trim() };
  } catch {
    return null;
  }
}

// Replies are the same whatever the store holds, so the bot never says whether a code, chat or wallet exists (C49).
export async function handleUpdate(update: Update, store: Store, telegram: Telegram): Promise<void> {
  // Telegram retries until it gets a 2xx, so each update is handled once.
  if (!(await store.set(keys.update(update.updateId), "1", { nx: true, px: 86_400_000 }))) return;

  const [command, arg] = update.text.split(/\s+/, 2);
  if (command === "/start") {
    if (!arg) {
      await telegram.send(update.chatId, helloText());
      return;
    }
    if (!(await allow(store, keys.rate("start", update.chatId), 10, 600))) return;
    let code: string;
    try {
      code = normaliseCode(arg);
    } catch (error) {
      if (!(error instanceof KeyError)) throw error;
      await telegram.send(update.chatId, expiredText());
      return;
    }
    const claimed = await claimCode(store, code, { id: update.chatId, handle: update.handle });
    await telegram.send(update.chatId, claimed ? pendingText() : expiredText());
    return;
  }
  if (command === "/stop") {
    // Unlinking from inside the chat needs no signature: only this chat can send it (C47).
    const wallet = await store.getdel(keys.chat(update.chatId));
    if (wallet) {
      try {
        const address = normaliseAddress(wallet);
        if ((await store.get(keys.link(address))) === update.chatId) {
          await store.del(keys.link(address));
          await store.srem(keys.linked(), address);
        }
      } catch {
        // A malformed row is simply gone now.
      }
    }
    await telegram.send(update.chatId, stoppedText());
  }
}
