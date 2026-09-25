import { LIVE_CACHE_MS } from "@/lib/arc/constants";
import { readPledgeStage } from "@/lib/arc/pledge";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Entry = { at: number; body: string; readMs: number };

// One entry per server process. Concurrent misses share a single chain read.
let cached: Entry | null = null;
let inflight: Promise<Entry> | null = null;

async function fresh(): Promise<Entry> {
  const started = performance.now();
  const snapshot = await readPledgeStage();
  const entry = { at: Date.now(), body: JSON.stringify(snapshot), readMs: Math.round(performance.now() - started) };
  cached = entry;
  return entry;
}

export async function GET() {
  let entry: Entry;
  let state: "hit" | "miss" | "joined";

  if (cached && Date.now() - cached.at < LIVE_CACHE_MS) {
    entry = cached;
    state = "hit";
  } else if (inflight) {
    entry = await inflight;
    state = "joined";
  } else {
    inflight = fresh().finally(() => {
      inflight = null;
    });
    entry = await inflight;
    state = "miss";
  }

  return new Response(entry.body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-adag-cache": state,
      "x-adag-cache-age-ms": String(Date.now() - entry.at),
      "server-timing": `arc;desc="chain read";dur=${state === "miss" ? entry.readMs : 0}`,
    },
  });
}
