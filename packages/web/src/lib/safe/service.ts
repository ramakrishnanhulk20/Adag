import SafeApiKit from "@safe-global/api-kit";
import { CHAIN_ID } from "../pay/constants";

// The Safe Transaction Service needs an API key, and the key must never reach a browser, so only the server talks to
// the service. SAFE_TX_SERVICE_URL exists for the end-to-end test's local stand-in service; production leaves it unset
// and api-kit uses Safe's own Arc endpoint.
export const NOT_CONFIGURED = "Safe proposals are not configured yet.";
export const SERVICE_TIMEOUT_MS = 10_000;

export function safeService(): SafeApiKit | null {
  const apiKey = process.env.SAFE_API_KEY;
  if (!apiKey) return null;
  const txServiceUrl = process.env.SAFE_TX_SERVICE_URL || undefined;
  return new SafeApiKit({ chainId: BigInt(CHAIN_ID), apiKey, ...(txServiceUrl ? { txServiceUrl } : {}) });
}

export async function withTimeout<T>(promise: Promise<T>, ms = SERVICE_TIMEOUT_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error("The Safe service did not answer in time.")), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

// Every error leaves the server as one of these fixed sentences, so nothing from the service, and never the key, is echoed.
export function serviceError(error: unknown): { status: number; message: string } {
  const e = error as { statusCode?: number; message?: string } | undefined;
  if (e?.message === "The Safe service did not answer in time.") return { status: 504, message: "The Safe service did not answer in time. Try again." };
  if (e?.statusCode === 404) return { status: 404, message: "The Safe service does not know this transaction yet." };
  if (e?.statusCode === 429) return { status: 429, message: "The Safe service is rate-limiting requests. Try again in a minute." };
  if (e?.statusCode && e.statusCode >= 400 && e.statusCode < 500) return { status: 422, message: "The Safe service refused the proposal." };
  return { status: 502, message: "The Safe service could not be reached. Try again." };
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
