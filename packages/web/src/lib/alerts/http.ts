import { timingSafeEqual } from "node:crypto";
import { InputError as SafeInputError } from "../safe/parse";
import { SafeShapeError } from "../safe/multisend";
import { SafeCheckError } from "../safe/verify";
import { KeyError } from "../store/keys";
import { MessageError } from "./message";

export class InputError extends Error {}

// C62: a route passes on a thrown message only when this codebase wrote it. Anything else, a library's error above
// all, becomes the route's own fixed sentence: viem's transport and timeout errors carry the full RPC URL and its key.
const OWN_ERRORS = [InputError, SafeInputError, SafeShapeError, SafeCheckError, KeyError, MessageError];

export function publicMessage(error: unknown, fallback: string): string {
  return OWN_ERRORS.some((E) => error instanceof E) ? (error as Error).message : fallback;
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
}

// Bodies are capped before and after reading (C57): a declared length over the cap is refused unread.
export async function readCappedText(request: Request, maxBytes: number): Promise<string> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > maxBytes) throw new InputError("The request is too large.");
  const text = await request.text();
  if (Buffer.byteLength(text, "utf8") > maxBytes) throw new InputError("The request is too large.");
  return text;
}

export async function readCappedJson(request: Request, maxBytes = 4_096): Promise<Record<string, unknown>> {
  const text = await readCappedText(request, maxBytes);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new InputError("The request is not JSON.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw new InputError("The request is not a JSON object.");
  return body as Record<string, unknown>;
}

// Compares a presented secret with the configured one without leaking, through timing, how much of it matched.
export function sameSecret(presented: string | null, expected: string): boolean {
  if (!presented || !expected) return false;
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}
