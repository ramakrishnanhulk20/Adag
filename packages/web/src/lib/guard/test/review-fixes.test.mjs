import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { startMockUpstash } from '../../store/test/mock-upstash.mjs';

const mock = await startMockUpstash();

// Telegram's API, answering every send with ok, so the link route can finish.
const sent = [];
const telegramMock = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => (body += chunk));
  req.on('end', () => {
    sent.push({ path: req.url, body });
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
  });
});
await new Promise((resolve) => telegramMock.listen(0, '127.0.0.1', resolve));

// An Arc RPC that always fails, at URLs holding a stand-in secret, the way a keyed QuickNode URL holds its key.
// viem's error for it quotes the URL in its message; C62 says that text must never reach a response.
let rpcCalls = 0;
const rpcMock = createServer((req, res) => {
  req.resume();
  req.on('end', () => {
    rpcCalls += 1;
    res.statusCode = 500;
    res.end('upstream broke');
  });
});
await new Promise((resolve) => rpcMock.listen(0, '127.0.0.1', resolve));
process.env.ARC_RPC_URL = `http://127.0.0.1:${rpcMock.address().port}/SECRET-primary`;
process.env.ARC_RPC_FALLBACK_URL = `http://127.0.0.1:${rpcMock.address().port}/SECRET-fallback`;

after(() => {
  mock.close();
  telegramMock.close();
  rpcMock.close();
});

process.env.NEXT_PUBLIC_ADAG_E2E = '1';
process.env.UPSTASH_REDIS_REST_URL = mock.url;
process.env.UPSTASH_REDIS_REST_TOKEN = mock.token;
process.env.ADAG_STORE_NAMESPACE = 'test:';
process.env.NEXT_PUBLIC_SITE_URL = 'https://adag.example';
process.env.ADAG_E2E_TELEGRAM_API = `http://127.0.0.1:${telegramMock.address().port}`;
// A made-up token in the right shape; it only ever reaches the local mock above.
process.env.TELEGRAM_BOT_TOKEN = `123456:${'t'.repeat(35)}`;

const { createStore } = await import('../../store/upstash.ts');
const { issueCode, claimCode } = await import('../../alerts/code.ts');
const { buildMessage } = await import('../../alerts/message.ts');

const post = (url, ip, body) =>
  new Request(`https://adag.example${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-vercel-forwarded-for': ip },
    body: JSON.stringify(body),
  });

test('C61: a person who polls the code status for a while can still link from the same address', async () => {
  const { POST: status } = await import('../../../app/api/alerts/code/status/route.ts');
  const { POST: link } = await import('../../../app/api/alerts/link/route.ts');
  const store = createStore({ url: mock.url, token: mock.token, namespace: 'test:' });
  const ip = '198.51.100.30';
  const wallet = privateKeyToAccount(generatePrivateKey());

  const { code } = await issueCode(store);
  for (let i = 0; i < 25; i++) {
    const r = await status(post('/api/alerts/code/status', ip, { code }));
    assert.equal(r.status, 200, `poll ${i + 1} before Start`);
    assert.equal((await r.json()).state, 'waiting');
  }
  assert.equal(await claimCode(store, code, { id: 5550001, handle: 'alice_t' }), true);
  for (let i = 0; i < 5; i++) {
    const r = await status(post('/api/alerts/code/status', ip, { code }));
    assert.equal(r.status, 200, `poll ${i + 1} after Start`);
    assert.equal((await r.json()).state, 'pressed');
  }

  const expiry = Math.floor(Date.now() / 1000) + 300;
  const message = buildMessage('https://adag.example', { action: 'link', wallet: wallet.address, code, chatId: '5550001', chatHandle: 'alice_t', expiry });
  const signature = await wallet.signMessage({ message });
  const r = await link(post('/api/alerts/link', ip, { wallet: wallet.address, code, expiry, signature }));
  assert.notEqual(r.status, 429, 'thirty status polls must not spend the link allowance');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { linked: true });
  assert.ok(sent.some((s) => s.body.includes('5550001')), 'the linked message went to the chat');
});

const SAFE = '0x443525A2d5146A8b007754112DC182441cBa92Dc';
const OWNER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const ZERO = '0x0000000000000000000000000000000000000000';

async function proposeWith(innerCalls, ip) {
  process.env.SAFE_API_KEY = 'test-only-key';
  const { POST } = await import('../../../app/api/safe/propose/route.ts');
  const { encodeMultiSend } = await import('../../safe/multisend.ts');
  const { MULTISEND_CALL_ONLY } = await import('../../safe/constants.ts');
  const tx = {
    to: MULTISEND_CALL_ONLY,
    value: '0',
    data: encodeMultiSend(innerCalls.map((c) => ({ ...c, value: 0n, operation: 0 }))),
    operation: 1,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: ZERO,
    refundReceiver: ZERO,
    nonce: '3',
  };
  const body = { safe: SAFE, owner: OWNER, safeTxHash: `0x${'ab'.repeat(32)}`, signature: `0x${'cd'.repeat(65)}`, tx };
  const r = await POST(post('/api/safe/propose', ip, body));
  return { status: r.status, text: await r.text() };
}

test('C62: a propose whose Arc reads fail answers a fixed sentence, with no URL and no secret from the library error', async () => {
  const { encodeFunctionData, parseAbi } = await import('viem');
  const { ADAG_BILLS, USDC } = await import('../../pay/constants.ts');
  const pay = encodeFunctionData({ abi: parseAbi(['function pay(uint256 id)']), functionName: 'pay', args: [7n] });
  const approve = encodeFunctionData({ abi: parseAbi(['function approve(address,uint256) returns (bool)']), functionName: 'approve', args: [ADAG_BILLS, 1_000_000n] });
  const before = rpcCalls;
  const { status, text } = await proposeWith([{ to: USDC, data: approve }, { to: ADAG_BILLS, data: pay }], '198.51.100.40');
  assert.ok(rpcCalls > before, 'the route did reach the failing RPC');
  assert.ok([422, 502].includes(status), `status ${status}`);
  assert.ok(!text.includes('SECRET'), text);
  assert.ok(!text.includes('127.0.0.1') && !/URL:/i.test(text), text);
  assert.match(JSON.parse(text).error, /Nothing was proposed\.$/);
});

test('C62: verifySafe turns a failing chain id or code read into its own sentence', async () => {
  const { verifySafe, SafeCheckError } = await import('../../safe/verify.ts');
  const { publicMessage } = await import('../../alerts/http.ts');
  const leak = () => Promise.reject(new Error('HTTP request failed.\nURL: https://x/SECRET'));
  for (const client of [
    { getChainId: leak, getCode: async () => '0x60' },
    { getChainId: async () => 5042, getCode: leak },
  ]) {
    const error = await verifySafe(client, SAFE, OWNER).then(() => null, (e) => e);
    assert.ok(error instanceof SafeCheckError);
    assert.ok(!error.message.includes('SECRET'));
    assert.equal(publicMessage(error, 'fallback'), error.message);
  }
  assert.equal(publicMessage(new Error('URL: https://x/SECRET'), 'fallback'), 'fallback', 'a library error never passes');
});

test('C63: the worst keeper run, budget plus one receipt wait plus alerts, fits inside the lease and both routes\' limits', async () => {
  const { readFile } = await import('node:fs/promises');
  const { LEASE_MS, RUN_BUDGET_MS, RECEIPT_TIMEOUT_MS } = await import('../constants.ts');
  // run.ts keeps the alerts budget private, so it is read from the source the route runs.
  const runSource = await readFile(new URL('../run.ts', import.meta.url), 'utf8');
  const match = /const ALERT_BUDGET_MS = ([0-9_]+);/.exec(runSource);
  assert.ok(match, 'run.ts still names its alerts budget');
  const alertBudget = Number(match[1].replaceAll('_', ''));
  const worst = RUN_BUDGET_MS + RECEIPT_TIMEOUT_MS + alertBudget;

  assert.ok(worst < LEASE_MS, `worst ${worst} ms is under the lease ${LEASE_MS} ms`);
  for (const path of ['../../../app/api/keeper/run/route.ts', '../../../app/api/hooks/quicknode/route.ts']) {
    const { maxDuration } = await import(path);
    assert.equal(typeof maxDuration, 'number', path);
    assert.ok(worst < maxDuration * 1000, `${path}: worst ${worst} ms is under maxDuration ${maxDuration} s`);
    assert.ok(maxDuration <= 300, `${path}: within Vercel's 300 s ceiling`);
  }
});
