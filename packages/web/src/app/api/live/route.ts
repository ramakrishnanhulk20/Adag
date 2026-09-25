import { LIVE_CACHE_MS } from "@/lib/arc/constants";
import { readLive } from "@/lib/arc/live";
import type { LiveSnapshot } from "@/lib/arc/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Entry = { at: number; body: string; readMs: number };

// One entry per server process, keyed by the one call this route makes. Concurrent misses share a single chain read.
const cache = new Map<string, Entry>();
const inflight = new Map<string, Promise<Entry>>();
const KEY = "live";

async function fresh(): Promise<Entry> {
  const started = performance.now();
  const snapshot: LiveSnapshot = await readLive();
  const entry = { at: Date.now(), body: JSON.stringify(snapshot), readMs: Math.round(performance.now() - started) };
  cache.set(KEY, entry);
  return entry;
}

export async function GET() {
  const hit = cache.get(KEY);
  let entry: Entry;
  let state: "hit" | "miss" | "joined";

  if (hit && Date.now() - hit.at < LIVE_CACHE_MS) {
    entry = hit;
    state = "hit";
  } else if (inflight.has(KEY)) {
    entry = await inflight.get(KEY)!;
    state = "joined";
  } else {
    const run = fresh().finally(() => inflight.delete(KEY));
    inflight.set(KEY, run);
    entry = await run;
    state = "miss";
  }

  const ageMs = Date.now() - entry.at;
  return new Response(entry.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-adag-cache": state,
      "x-adag-cache-age-ms": String(ageMs),
      "server-timing": `arc;desc="chain read";dur=${state === "miss" ? entry.readMs : 0}`,
    },
  });
}
