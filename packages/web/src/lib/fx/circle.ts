// Plain TypeScript with relative imports only. The one place the app talks to Circle (C73): a request to a fixed address,
// built from typed values, answered once and never quoted. Nothing here decides whether a plan is safe; that is plan.ts's
// checkPlan, which runs on the bytes this file produces.
import { getAddress, isAddress, isAddressEqual, isHex, size, type Address, type Hex } from "viem";
import { CIRCLE_SWAP_URL, EURC, PLAN_MAX_CALLDATA_BYTES, PLAN_MAX_INSTRUCTIONS, USDC } from "../pay/constants";
import { encodeExecute, type PlanInstruction, type PlanParams } from "./plan";

export const CIRCLE_TIMEOUT_MS = 20_000;
// Circle sometimes answers "no route" or 429 to a request that works a moment later. One press may repeat the identical
// request twice, after these waits, and for no other failure.
export const CIRCLE_RETRY_WAITS_MS = [1_500, 3_000] as const;
// Real answers are 9 to 16 KB. The cap is for a broken or hostile server, not for real plans.
export const CIRCLE_MAX_RESPONSE_BYTES = 120_000;
// Circle's own code for "No route found that satisfies the requested stop limit". Only this number is read from an
// error body, to choose between two sentences of ours; none of Circle's words are kept.
const NO_ROUTE_CODE = 331001;

export const CIRCLE_SENTENCES = {
  no_route: "Circle found no swap that returns enough for this payment right now. Try again in a moment, or pay another way.",
  busy: "Circle's swap service is busy. Wait a minute and try again.",
  unavailable: "Circle's swap service did not answer. Nothing was sent. Try again in a moment, or pay another way.",
  bad_answer: "Circle's swap service answered in a form Adag does not trust, so nothing from it was used. Try again, or pay another way.",
  bad_request: "Adag could not form a swap request for this payment, so nothing was sent.",
} as const;
export type CircleFailure = keyof typeof CIRCLE_SENTENCES;

// What the swap request is made of: two of the fixed currencies, two whole numbers, and the connected wallet.
export type PlanRequest = { tokenIn: Address; amountIn: bigint; tokenOut: Address; minOut: bigint; account: Address };

// The parsed plan. calldata is execute's call, written by plan.ts's encoder from the typed values below; execId and
// deadline are copies for the screen's timer. Nothing else from Circle's answer is kept.
export type CirclePlan = { calldata: Hex; execId: bigint; deadline: bigint };

export type PlanResult = { ok: true; plan: CirclePlan } | { ok: false; kind: CircleFailure; error: string };

const fail = (kind: CircleFailure): PlanResult => ({ ok: false, kind, error: CIRCLE_SENTENCES[kind] });
const MAX_UINT256 = 2n ** 256n - 1n;
const MAX_AMOUNT = 2n ** 128n;

function requestBody(r: PlanRequest): string | null {
  const fixed = (a: unknown) => typeof a === "string" && isAddress(a, { strict: false }) && [USDC, EURC].some((t) => isAddressEqual(t, a as Address));
  if (!fixed(r.tokenIn) || !fixed(r.tokenOut) || isAddressEqual(r.tokenIn, r.tokenOut)) return null;
  if (typeof r.amountIn !== "bigint" || r.amountIn <= 0n || r.amountIn >= MAX_AMOUNT) return null;
  if (typeof r.minOut !== "bigint" || r.minOut <= 0n || r.minOut >= MAX_AMOUNT) return null;
  if (typeof r.account !== "string" || !isAddress(r.account, { strict: false }) || /^0x0+$/.test(r.account)) return null;
  const account = getAddress(r.account);
  return JSON.stringify({
    tokenInAddress: getAddress(r.tokenIn),
    tokenInChain: "Arc",
    tokenOutAddress: getAddress(r.tokenOut),
    tokenOutChain: "Arc",
    fromAddress: account,
    toAddress: account,
    amount: r.amountIn.toString(),
    stopLimit: r.minOut.toString(),
  });
}

// The body as text, or null when it is over the cap, unreadable as UTF-8, or the stream breaks. Counts bytes as they
// arrive, so a server cannot make this hold more than the cap.
async function readCapped(res: Response): Promise<string | null> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > CIRCLE_MAX_RESPONSE_BYTES) return null;
  try {
    if (!res.body) {
      const text = await res.text();
      return text.length > CIRCLE_MAX_RESPONSE_BYTES ? null : text;
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > CIRCLE_MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
    const bytes = new Uint8Array(total);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.byteLength;
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

// Circle writes whole numbers as decimal strings, and in one place as a hex string ("0x0"). Both are accepted, nothing else.
function uint(v: unknown): bigint | null {
  if (typeof v !== "string" || v.length === 0 || v.length > 80) return null;
  let n: bigint;
  if (/^(0|[1-9][0-9]*)$/.test(v)) n = BigInt(v);
  else if (/^0x[0-9a-fA-F]{1,64}$/.test(v)) n = BigInt(v);
  else return null;
  return n <= MAX_UINT256 ? n : null;
}

function addr(v: unknown): Address | null {
  return typeof v === "string" && isAddress(v, { strict: false }) ? getAddress(v) : null;
}

function bytes(v: unknown, max: number): Hex | null {
  if (typeof v !== "string" || !isHex(v, { strict: true }) || v.length % 2 !== 0 || size(v as Hex) > max) return null;
  return v as Hex;
}

function parseInstruction(v: unknown): PlanInstruction | null {
  if (!isRecord(v)) return null;
  const target = addr(v.target);
  const data = bytes(v.data, PLAN_MAX_CALLDATA_BYTES);
  const value = uint(v.value);
  const tokenIn = addr(v.tokenIn);
  const amountToApprove = uint(v.amountToApprove);
  const tokenOut = addr(v.tokenOut);
  const minTokenOut = uint(v.minTokenOut);
  if (!target || !data || value === null || !tokenIn || amountToApprove === null || !tokenOut || minTokenOut === null) return null;
  return { target, data, value, tokenIn, amountToApprove, tokenOut, minTokenOut };
}

// One pass from Circle's JSON to typed values. Any missing, mistyped or oversized field fails the whole plan.
function parsePlan(json: unknown, req: PlanRequest): CirclePlan | null {
  if (!isRecord(json) || !isRecord(json.transaction)) return null;
  const tx = json.transaction;
  if (!isRecord(tx.executionParams)) return null;
  const ep = tx.executionParams;
  const signature = bytes(tx.signature, 1_024);
  const metadata = bytes(ep.metadata, PLAN_MAX_CALLDATA_BYTES);
  const execId = uint(ep.execId);
  const deadline = uint(ep.deadline);
  if (!signature || size(signature) === 0 || !metadata || execId === null || deadline === null) return null;
  if (!Array.isArray(ep.instructions) || ep.instructions.length === 0 || ep.instructions.length > PLAN_MAX_INSTRUCTIONS) return null;
  if (!Array.isArray(ep.tokens) || ep.tokens.length === 0 || ep.tokens.length > PLAN_MAX_INSTRUCTIONS) return null;
  const instructions: PlanInstruction[] = [];
  for (const raw of ep.instructions) {
    const parsed = parseInstruction(raw);
    if (!parsed) return null;
    instructions.push(parsed);
  }
  const tokens: { token: Address; beneficiary: Address }[] = [];
  for (const raw of ep.tokens) {
    if (!isRecord(raw)) return null;
    const token = addr(raw.token);
    const beneficiary = addr(raw.beneficiary);
    if (!token || !beneficiary) return null;
    tokens.push({ token, beneficiary });
  }
  const params: PlanParams = { instructions, tokens, execId, deadline, metadata };
  const calldata = encodeExecute(params, getAddress(req.tokenIn), req.amountIn, signature);
  if (size(calldata) > PLAN_MAX_CALLDATA_BYTES) return null;
  return { calldata, execId, deadline };
}

// One attempt: the request, the capped read and the single parse.
async function attempt(body: string, timeoutMs: number, req: PlanRequest): Promise<PlanResult> {
  let res: Response;
  try {
    res = await fetch(CIRCLE_SWAP_URL, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    return fail("unavailable");
  }
  if (res.redirected || res.type === "opaqueredirect") return fail("unavailable");

  const text = await readCapped(res);
  if (text === null) return fail("unavailable");
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return fail(res.ok ? "bad_answer" : "unavailable");
  }

  if (!res.ok) {
    if (res.status === 429) return fail("busy");
    if (isRecord(json) && json.code === NO_ROUTE_CODE) return fail("no_route");
    return fail("unavailable");
  }
  const plan = parsePlan(json, req);
  return plan ? { ok: true, plan } : fail("bad_answer");
}

// C73: the only request this app makes to Circle, and none on load or refresh. One press may repeat the identical request
// (the same body, byte for byte) up to twice, waiting 1.5 s and then 3 s, when Circle reports no route or rate limiting.
// Every other failure is a single attempt, and there is no second route and no fallback. Nothing the payer sees or signs
// changes between attempts. `timeoutMs` and `retryWaitsMs` exist so a test need not wait; they can only shorten the limits.
export async function requestPlan(req: PlanRequest, options: { timeoutMs?: number; retryWaitsMs?: readonly number[] } = {}): Promise<PlanResult> {
  const body = requestBody(req);
  if (body === null) return fail("bad_request");
  const timeoutMs = Math.min(options.timeoutMs ?? CIRCLE_TIMEOUT_MS, CIRCLE_TIMEOUT_MS);

  let result = await attempt(body, timeoutMs, req);
  for (let i = 0; i < CIRCLE_RETRY_WAITS_MS.length; i++) {
    if (result.ok || (result.kind !== "no_route" && result.kind !== "busy")) break;
    const wait = Math.min(options.retryWaitsMs?.[i] ?? CIRCLE_RETRY_WAITS_MS[i]!, CIRCLE_RETRY_WAITS_MS[i]!);
    await new Promise((resolve) => setTimeout(resolve, wait));
    result = await attempt(body, timeoutMs, req);
  }
  return result;
}
