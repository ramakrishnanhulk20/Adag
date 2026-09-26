import { timingSafeEqual } from "node:crypto";

export class InputError extends Error {}

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
