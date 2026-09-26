import { normaliseChatId } from "../store/keys";

export type Telegram = {
  send(chatId: string, text: string): Promise<boolean>;
  username(): Promise<string | null>;
};

// The one origin the bot talks to (C57). The end-to-end build may point it at a local mock; NEXT_PUBLIC_ADAG_E2E is
// written into the build, so in a real build that branch does not exist.
function apiBase(): string {
  if (process.env.NEXT_PUBLIC_ADAG_E2E === "1") {
    const mock = process.env.ADAG_E2E_TELEGRAM_API;
    if (mock && /^http:\/\/127\.0\.0\.1:[0-9]{2,5}$/.test(mock)) return mock;
  }
  return "https://api.telegram.org";
}

const TIMEOUT_MS = 5_000;

// Server only (C56). The token appears in the request path, so it is never logged, and failures say nothing about it.
export function telegramFromEnv(): Telegram | null {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token || !/^[0-9]{5,16}:[A-Za-z0-9_-]{30,60}$/.test(token)) return null;
  const base = `${apiBase()}/bot${token}`;
  let cachedName: string | null = null;

  async function call(method: string, body: Record<string, unknown>): Promise<unknown> {
    const response = await fetch(`${base}/${method}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: "no-store",
    });
    const text = await response.text();
    if (text.length > 100_000) return null;
    const parsed = JSON.parse(text) as { ok?: unknown; result?: unknown };
    return parsed.ok === true ? parsed.result : null;
  }

  return {
    async send(chatId, text) {
      if (text.length === 0 || text.length > 4096) return false;
      try {
        // No parse_mode: Telegram shows the text exactly as written, so nothing in it can become markup (C48).
        const result = await call("sendMessage", { chat_id: Number(normaliseChatId(chatId)), text, link_preview_options: { is_disabled: true } });
        return result !== null;
      } catch {
        return false;
      }
    },
    async username() {
      if (cachedName) return cachedName;
      try {
        const me = (await call("getMe", {})) as { username?: unknown } | null;
        const name = typeof me?.username === "string" && /^[A-Za-z0-9_]{5,32}$/.test(me.username) ? me.username : null;
        cachedName = name;
        return name;
      } catch {
        return null;
      }
    },
  };
}

export const TELEGRAM_MISSING = "Telegram alerts are not configured on this server yet.";
