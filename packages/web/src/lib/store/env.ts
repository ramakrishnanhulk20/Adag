import { createStore, type Store } from "./upstash";

// Server only. The Vercel Marketplace names the same two values KV_REST_API_URL and KV_REST_API_TOKEN, so either works.
export function storeFromEnv(): Store | null {
  const url = process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
  if (!url || !token) return null;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  // Plain http only for the end-to-end run's local mock; a real store is always https.
  const local = process.env.NEXT_PUBLIC_ADAG_E2E === "1" && parsed.protocol === "http:" && parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !local) return null;
  return createStore({ url: parsed.origin + parsed.pathname, token, namespace: process.env.ADAG_STORE_NAMESPACE === "test:" ? "test:" : "" });
}

export const STORE_MISSING = "Alerts and the loan guard need a key-value store, and none is configured on this server yet.";
