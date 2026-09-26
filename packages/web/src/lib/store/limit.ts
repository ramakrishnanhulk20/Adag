import { keys, type StoreKey } from "./keys";
import type { Store } from "./upstash";

// A fixed-window counter: true while this key has been used at most `max` times in the current window.
export async function allow(store: Store, key: StoreKey, max: number, windowSeconds: number): Promise<boolean> {
  return (await store.incrby(key, 1, windowSeconds)) <= max;
}

// Vercel: "we currently overwrite the X-Forwarded-For header and do not forward external IPs" (vercel.com/docs/headers/request-headers).
// x-vercel-forwarded-for is that same address and the one that survives a proxy in front of Vercel; the plain header is
// read only when it is absent, which is local development. Anything malformed lands in one shared bucket.
export function clientOf(request: Request): string {
  const vercel = request.headers.get("x-vercel-forwarded-for");
  const raw = vercel !== null ? vercel : (request.headers.get("x-forwarded-for")?.split(",")[0] ?? "");
  const client = raw.trim();
  return /^[0-9A-Fa-f:.]{3,45}$/.test(client) ? client : "other";
}

export const TOO_MANY = "Too many requests. Try again in a few minutes.";

// Two ten-minute windows for a route: one per client and one for everyone, so neither one caller nor a crowd can spend
// the Safe API key's quota (C57). A refusal is logged as the route and the bucket, never the address.
export async function limitRoute(store: Store, request: Request, bucket: "safe-list" | "safe-status" | "safe-propose", perClient: number, overall: number): Promise<boolean> {
  if (!(await allow(store, keys.rate(bucket, clientOf(request)), perClient, 600))) {
    console.log(`rate limit: ${bucket} per client`);
    return false;
  }
  if (!(await allow(store, keys.rate(bucket, "all"), overall, 600))) {
    console.log(`rate limit: ${bucket} overall`);
    return false;
  }
  return true;
}
