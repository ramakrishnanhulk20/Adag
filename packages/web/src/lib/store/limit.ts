import type { StoreKey } from "./keys";
import type { Store } from "./upstash";

// A fixed-window counter: true while this key has been used at most `max` times in the current window.
export async function allow(store: Store, key: StoreKey, max: number, windowSeconds: number): Promise<boolean> {
  return (await store.incrby(key, 1, windowSeconds)) <= max;
}

// The first address in x-forwarded-for is the client on Vercel. Anything else only ever lands in one shared bucket.
export function clientOf(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? "";
  return /^[0-9A-Fa-f:.]{3,45}$/.test(forwarded) ? forwarded : "other";
}
