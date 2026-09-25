import { joinRun, streamRun } from "@/lib/break/runner";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

// POST, so a crawler following links never starts a run. The answer is newline-delimited JSON, one line per
// event, so the page fills in check by check.
export async function POST() {
  const joined = joinRun();
  return new Response(streamRun(joined), {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      "x-accel-buffering": "no",
      "x-adag-cache": joined.state,
    },
  });
}
