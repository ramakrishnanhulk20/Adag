// Covers lib/fx/circle.ts (C73) against a stubbed fetch: the one request it makes, and every way an answer can fail.
// Does NOT cover Circle itself (scripts/check-fx.mjs F9 and F10 call the real service) or the CSP line (next order).
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { C, PAYER, CHAIN_TIME, planParams, SIGNATURE } from './fixtures.mjs';

const { requestPlan, CIRCLE_SENTENCES, CIRCLE_MAX_RESPONSE_BYTES, CIRCLE_TIMEOUT_MS } = await import('../circle.ts');
const { checkPlan } = await import('../plan.ts');

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const AMOUNT_IN = 89_083_698n;
const MIN_OUT = 100_000_000n;
const request = (over = {}) => ({ tokenIn: C.EURC, amountIn: AMOUNT_IN, tokenOut: C.USDC, minOut: MIN_OUT, account: PAYER, ...over });

// Circle writes whole numbers as strings, and one instruction's value as "0x0".
function circleJson(over = {}) {
  const p = planParams({ tokenIn: C.EURC, tokenOut: C.USDC, amountIn: AMOUNT_IN, minOut: MIN_OUT });
  const str = (n) => n.toString();
  return {
    estimatedAmount: '99999999999999',
    fees: { provider: [] },
    route: { provider: 'lifi' },
    transaction: {
      signature: SIGNATURE,
      gasLimit: '0x160ffb',
      executionParams: {
        execId: `0x${p.execId.toString(16).padStart(32, '0')}`,
        deadline: str(CHAIN_TIME + 600n),
        metadata: '0x',
        tokens: p.tokens,
        instructions: p.instructions.map((i, n) => ({ ...i, value: n === 0 ? '0' : '0x0', amountToApprove: str(i.amountToApprove), minTokenOut: str(i.minTokenOut) })),
      },
    },
    ...over,
  };
}
const answer = (body, init = {}) => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
function stub(handler) {
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return handler(url, init);
  };
  return seen;
}
const fixed = (result, kind) => {
  assert.equal(result.ok, false);
  assert.equal(result.kind, kind);
  assert.equal(result.error, CIRCLE_SENTENCES[kind]);
};

test('a good answer becomes typed values, and the calldata passes the plan check', async () => {
  const seen = stub(() => answer(circleJson()));
  const result = await requestPlan(request());
  assert.equal(result.ok, true);
  assert.deepEqual(Object.keys(result.plan).sort(), ['calldata', 'deadline', 'execId']);
  assert.equal(result.plan.deadline, CHAIN_TIME + 600n);
  checkPlan(result.plan.calldata, { account: PAYER, tokenIn: C.EURC, tokenOut: C.USDC, amountIn: AMOUNT_IN, minOut: MIN_OUT, latestBlockTimestamp: CHAIN_TIME });
  assert.equal(seen.length, 1);
});

test('C73: one fixed URL, a POST, no credentials, no redirects, a timeout, and only typed fields in the body', async () => {
  const seen = stub(() => answer(circleJson()));
  await requestPlan(request());
  const { url, init } = seen[0];
  assert.equal(url, 'https://api.circle.com/v1/stablecoinKits/swap');
  assert.equal(url, C.CIRCLE_SWAP_URL);
  assert.equal(init.method, 'POST');
  assert.equal(init.credentials, 'omit');
  assert.equal(init.redirect, 'error');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(JSON.parse(init.body), {
    tokenInAddress: C.EURC, tokenInChain: 'Arc', tokenOutAddress: C.USDC, tokenOutChain: 'Arc',
    fromAddress: PAYER, toAddress: PAYER, amount: AMOUNT_IN.toString(), stopLimit: MIN_OUT.toString(),
  });
});

test('C73: a request for anything but the two fixed currencies, or with a bad number or wallet, is never sent', async () => {
  const seen = stub(() => answer(circleJson()));
  for (const bad of [
    { tokenIn: C.CIRBTC },
    { tokenOut: C.CIRBTC },
    { tokenOut: C.EURC },
    { amountIn: 0n },
    { amountIn: -5n },
    { amountIn: 2n ** 128n },
    { amountIn: 100 },
    { minOut: 0n },
    { account: 'not an address' },
    { account: '0x0000000000000000000000000000000000000000' },
  ]) {
    fixed(await requestPlan(request(bad)), 'bad_request');
  }
  assert.equal(seen.length, 0);
});

test('C73: a non-2xx answer becomes a fixed sentence and none of Circle’s words', async () => {
  const seen = stub(() => answer({ code: 1, message: 'SECRET INTERNAL TEXT' }, { status: 500 }));
  const result = await requestPlan(request());
  fixed(result, 'unavailable');
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.equal(seen.length, 1, 'no retry and no second route');
});

test('C73: "no route" and "busy" each have their own fixed sentence, chosen only from a number', async () => {
  stub(() => answer({ code: 331001, message: 'No route found that satisfies the requested stop limit' }, { status: 404 }));
  const none = await requestPlan(request());
  fixed(none, 'no_route');
  assert.ok(!none.error.includes('stop limit'));
  stub(() => answer({ message: 'slow down' }, { status: 429 }));
  fixed(await requestPlan(request()), 'busy');
  stub(() => answer({ code: 12345, message: 'something else' }, { status: 404 }));
  fixed(await requestPlan(request()), 'unavailable');
});

test('C73: an oversized body is refused, whether the size is declared or only found while reading', async () => {
  stub(() => answer('x'.repeat(10), { headers: { 'content-length': String(CIRCLE_MAX_RESPONSE_BYTES + 1) } }));
  fixed(await requestPlan(request()), 'unavailable');
  stub(() => answer(`{"pad":"${'x'.repeat(CIRCLE_MAX_RESPONSE_BYTES + 10)}"}`));
  fixed(await requestPlan(request()), 'unavailable');
  stub(() => new Response(new ReadableStream({ start(c) { for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(CIRCLE_MAX_RESPONSE_BYTES / 4)); c.close(); } }), { status: 200 }));
  fixed(await requestPlan(request()), 'unavailable');
});

test('C73: a redirect, a network failure and a timeout are each a fixed sentence', async () => {
  stub(() => {
    throw new TypeError('redirect mode is set to error');
  });
  fixed(await requestPlan(request()), 'unavailable');
  stub(() => {
    const res = answer(circleJson());
    Object.defineProperty(res, 'redirected', { value: true });
    return res;
  });
  fixed(await requestPlan(request()), 'unavailable');
  stub((url, init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason))));
  const started = Date.now();
  fixed(await requestPlan(request(), { timeoutMs: 30 }), 'unavailable');
  assert.ok(Date.now() - started < 2_000);
});

test('C73: a timeout can be shortened but never lengthened', async () => {
  stub(() => answer(circleJson()));
  const real = AbortSignal.timeout;
  const asked = [];
  AbortSignal.timeout = (ms) => {
    asked.push(ms);
    return real.call(AbortSignal, ms);
  };
  try {
    await requestPlan(request());
    await requestPlan(request(), { timeoutMs: 10 });
    await requestPlan(request(), { timeoutMs: 10 * 60 * 1000 });
  } finally {
    AbortSignal.timeout = real;
  }
  assert.deepEqual(asked, [CIRCLE_TIMEOUT_MS, 10, CIRCLE_TIMEOUT_MS]);
});

test('C73: unreadable bodies are fixed sentences', async () => {
  stub(() => answer('this is not json'));
  fixed(await requestPlan(request()), 'bad_answer');
  stub(() => answer('<html>bad gateway</html>', { status: 502 }));
  fixed(await requestPlan(request()), 'unavailable');
  stub(() => new Response(new Uint8Array([0xff, 0xfe, 0xfd]), { status: 200 }));
  fixed(await requestPlan(request()), 'unavailable');
  stub(() => answer(''));
  fixed(await requestPlan(request()), 'bad_answer');
});

test('C73: an answer with a missing, mistyped or oversized field is refused whole, never partly used', async () => {
  const cases = {
    'no transaction': { estimatedAmount: '1' },
    'no signature': (j) => { delete j.transaction.signature; },
    'empty signature': (j) => { j.transaction.signature = '0x'; },
    'odd length hex': (j) => { j.transaction.signature = '0xabc'; },
    'no instructions': (j) => { j.transaction.executionParams.instructions = []; },
    'too many instructions': (j) => { j.transaction.executionParams.instructions = Array.from({ length: 7 }, () => j.transaction.executionParams.instructions[0]); },
    'an instruction without a target': (j) => { delete j.transaction.executionParams.instructions[1].target; },
    'a negative value': (j) => { j.transaction.executionParams.instructions[0].value = '-1'; },
    'a number where a string is expected': (j) => { j.transaction.executionParams.deadline = 1791295430; },
    'a deadline that is not a number': (j) => { j.transaction.executionParams.deadline = 'soon'; },
    'a value past 256 bits': (j) => { j.transaction.executionParams.instructions[0].minTokenOut = `${'9'.repeat(79)}`; },
    'a bad address in tokens': (j) => { j.transaction.executionParams.tokens[0].beneficiary = '0x12'; },
    'tokens that are not a list': (j) => { j.transaction.executionParams.tokens = {}; },
    'a body that is a list': () => [],
  };
  for (const [name, change] of Object.entries(cases)) {
    const json = circleJson();
    const body = typeof change === 'function' ? (change(json) ?? json) : change;
    stub(() => answer(body));
    const result = await requestPlan(request());
    assert.equal(result.ok, false, name);
    assert.equal(result.error, CIRCLE_SENTENCES.bad_answer, name);
  }
});

test('Circle’s own summary is neither used nor passed on', async () => {
  stub(() => answer(circleJson({ estimatedAmount: 'SHOW THIS TO THE USER', route: { note: 'SHOW THIS TOO' } })));
  const result = await requestPlan(request());
  assert.equal(result.ok, true);
  assert.ok(!JSON.stringify(result, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).includes('SHOW'));
});
