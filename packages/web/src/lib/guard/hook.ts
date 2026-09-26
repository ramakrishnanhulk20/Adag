// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { createHmac, timingSafeEqual } from "node:crypto";
import { getAddress, isAddress, type Address } from "viem";
import { ANSWER_UPDATED_TOPIC, FEEDS } from "./constants";

// QuickNode signs HMAC-SHA256, keyed with the webhook's security token, over nonce + timestamp + the decoded body,
// as hex in X-QN-Signature (quicknode.com/guides/quicknode-products/streams/validating-incoming-streams-webhook-messages).
export const HOOK_MAX_AGE_SECONDS = 300;

export function verifyQuickNode(input: { secret: string; nonce: string | null; timestamp: string | null; signature: string | null; payload: string; nowMs: number }): boolean {
  const { secret, nonce, timestamp, signature, payload, nowMs } = input;
  if (!secret || !nonce || !timestamp || !signature) return false;
  if (!/^[0-9a-fA-F]{64}$/.test(signature) || nonce.length > 128 || !/^[0-9]{1,16}$/.test(timestamp)) return false;
  // Seconds or milliseconds: either way it must be within five minutes of now, so an old delivery cannot be replayed.
  const raw = Number(timestamp);
  const ms = raw < 1e12 ? raw * 1000 : raw;
  if (Math.abs(nowMs - ms) > HOOK_MAX_AGE_SECONDS * 1000) return false;
  const expected = createHmac("sha256", secret).update(nonce + timestamp + payload, "utf8").digest();
  return timingSafeEqual(expected, Buffer.from(signature, "hex"));
}

const WATCHED = new Set<string>(FEEDS.map((f) => f.aggregator.toLowerCase()));
const MAX_NODES = 20_000;
const MAX_DEPTH = 12;

// The one parser for a delivery (C57). It does not trust the payload's shape: it walks it, bounded, for log objects,
// and counts only AnswerUpdated from the two aggregators Adag watches. The run then reads the chain itself, so the
// payload decides only whether to run, never what to do.
export function parseAnswerUpdated(body: unknown): { feeds: Address[] } {
  const found = new Set<Address>();
  let nodes = 0;
  const walk = (value: unknown, depth: number) => {
    if (depth > MAX_DEPTH || ++nodes > MAX_NODES || value === null || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const item of value) walk(item, depth + 1);
      return;
    }
    const record = value as Record<string, unknown>;
    const address = record.address;
    const topics = record.topics;
    if (typeof address === "string" && isAddress(address, { strict: false }) && Array.isArray(topics)) {
      const topic0 = typeof topics[0] === "string" ? topics[0].toLowerCase() : "";
      if (WATCHED.has(address.toLowerCase()) && topic0 === ANSWER_UPDATED_TOPIC) found.add(getAddress(address));
    }
    for (const child of Object.values(record)) walk(child, depth + 1);
  };
  walk(body, 0);
  return { feeds: [...found] };
}
