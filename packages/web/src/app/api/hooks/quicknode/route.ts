import { gunzipSync } from "node:zlib";
import { json } from "@/lib/alerts/http";
import { parseAnswerUpdated, verifyQuickNode } from "@/lib/guard/hook";
import { runOnce } from "@/lib/guard/run";
import { STORE_MISSING, storeFromEnv } from "@/lib/store/env";
import { keys } from "@/lib/store/keys";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 60;

const MAX_BODY_BYTES = 512 * 1024;
const MAX_DECODED_BYTES = 2 * 1024 * 1024;

// A price update on Arc wakes the keeper. The signature is checked over the exact decoded bytes before anything
// is parsed (C44); an unverified delivery is dropped without logging its body, and a replayed nonce does nothing.
export async function POST(request: Request) {
  const secret = process.env.QUICKNODE_WEBHOOK_SECRET;
  if (!secret) return json({ error: "The price webhook is not configured on this server yet." }, 503);
  const store = storeFromEnv();
  if (!store) return json({ error: STORE_MISSING }, 503);

  if (Number(request.headers.get("content-length") ?? "0") > MAX_BODY_BYTES) return json({ error: "Too large." }, 413);
  const raw = Buffer.from(await request.arrayBuffer());
  if (raw.length > MAX_BODY_BYTES) return json({ error: "Too large." }, 413);
  let payload: string;
  try {
    // QuickNode signs the uncompressed JSON, so a gzip body is decoded first, with a cap on what it may expand to.
    const decoded = request.headers.get("content-encoding")?.toLowerCase() === "gzip" ? gunzipSync(raw, { maxOutputLength: MAX_DECODED_BYTES }) : raw;
    payload = decoded.toString("utf8");
  } catch {
    return json({ error: "Unreadable body." }, 400);
  }

  const nonce = request.headers.get("x-qn-nonce");
  const valid = verifyQuickNode({
    secret,
    nonce,
    timestamp: request.headers.get("x-qn-timestamp"),
    signature: request.headers.get("x-qn-signature"),
    payload,
    nowMs: Date.now(),
  });
  if (!valid) return json({ error: "Not allowed." }, 401);
  // Keyed on the hash of the same nonce string verifyQuickNode just checked.
  if (!(await store.set(keys.hookNonce(nonce ?? ""), "1", { nx: true, px: 600_000 }))) return json({ state: "duplicate" });

  let body: unknown;
  try {
    body = JSON.parse(payload);
  } catch {
    return json({ state: "ignored" });
  }
  if (parseAnswerUpdated(body).feeds.length === 0) return json({ state: "ignored" });

  const outcome = await runOnce("quicknode");
  return json(outcome.body, outcome.status === 503 ? 503 : 200);
}
