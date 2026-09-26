import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstash } from '../../store/test/mock-upstash.mjs';

const mock = await startMockUpstash();
after(() => mock.close());

process.env.NEXT_PUBLIC_ADAG_E2E = '1';
const { clientOf } = await import('../../store/limit.ts');
const { keys } = await import('../../store/keys.ts');
const { createStore } = await import('../../store/upstash.ts');
const { bind } = await import('../../alerts/links.ts');
const { linkedText, refusedText, movedText } = await import('../../alerts/text.ts');

const V = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const A = '0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B';
const req = (headers) => new Request('https://adag.example/api/x', { headers });

test('clientOf: the Vercel header wins over a spoofed x-forwarded-for, and junk lands in "other"', () => {
  assert.equal(clientOf(req({ 'x-vercel-forwarded-for': '203.0.113.9', 'x-forwarded-for': '1.1.1.1, 203.0.113.9' })), '203.0.113.9');
  assert.equal(clientOf(req({ 'x-vercel-forwarded-for': '2001:db8::1' })), '2001:db8::1');
  assert.equal(clientOf(req({ 'x-forwarded-for': '198.51.100.7, 10.0.0.1' })), '198.51.100.7', 'local development falls back to the first hop');
  assert.equal(clientOf(req({ 'x-vercel-forwarded-for': 'evil<script>', 'x-forwarded-for': '198.51.100.7' })), 'other', 'a malformed Vercel value is not replaced by the spoofable one');
  assert.equal(clientOf(req({})), 'other');
});

test('bind: a taken chat changes nothing, a wallet move returns the old chat, the same pair twice is fine', async () => {
  const store = createStore({ url: mock.url, token: mock.token, namespace: 'test:bind:' });
  assert.deepEqual(await bind(store, V, '222'), { ok: true, previousChat: null });
  assert.deepEqual(await bind(store, V, '222'), { ok: true, previousChat: null }, 'same wallet, same chat');

  assert.deepEqual(await bind(store, A, '222'), { ok: false, reason: 'chat-taken' });
  assert.equal(await store.get(keys.chat('222')), V, 'the chat still belongs to the first wallet');
  assert.equal(await store.get(keys.link(V)), '222');
  assert.equal(await store.get(keys.link(A)), null);
  assert.deepEqual((await store.smembers(keys.linked())).sort(), [V]);

  assert.deepEqual(await bind(store, V, '333'), { ok: true, previousChat: '222' }, 'the wallet moves and names the chat it left');
  assert.equal(await store.get(keys.chat('222')), null, 'the old chat is free again');
  assert.deepEqual(await bind(store, A, '222'), { ok: true, previousChat: null }, 'so another wallet can now take it');
});

test('the alert texts name the wallet in full, checksummed, with fixed words and the origin only', () => {
  const linked = linkedText('https://adag.example/some/path?x=<b>', V.toLowerCase());
  assert.ok(linked.includes(`wallet ${V}.`));
  assert.ok(linked.endsWith('https://adag.example/app'));
  assert.ok(!linked.includes('<') && !linked.includes('some/path'));
  assert.equal(
    refusedText(V.toLowerCase()),
    `Someone tried to link wallet ${V} to this chat. It was refused, because this chat already gets Adag alerts for another wallet. Nothing changed. To switch wallets, send /stop here, then link again from Adag.`,
  );
  assert.equal(movedText(V), `Adag alerts for wallet ${V} moved to another chat. This chat gets nothing more for that wallet.`);
  assert.ok(![linked, refusedText(V), movedText(V)].some((t) => /0x[0-9a-fA-F]{4}(\.\.\.|…)/.test(t)), 'never shortened');
  assert.throws(() => refusedText('0x1234'));
});

test('two webhook nonces that differ only past character 64 get different replay keys', () => {
  const base = 'a'.repeat(64);
  assert.notEqual(keys.hookNonce(`${base}1`), keys.hookNonce(`${base}2`));
  assert.notEqual(keys.hookNonce('nonce with spaces'), keys.hookNonce('nonce-with-spaces'));
  assert.equal(keys.hookNonce('abc'), keys.hookNonce('abc'));
});

test('Safe list route: the 21st call from one client in the window is 429, and no store is 503', async () => {
  process.env.SAFE_API_KEY = 'test-only-key';
  process.env.UPSTASH_REDIS_REST_URL = mock.url;
  process.env.UPSTASH_REDIS_REST_TOKEN = mock.token;
  process.env.ADAG_STORE_NAMESPACE = 'test:';
  const { GET } = await import('../../../app/api/safe/list/route.ts');
  // No owner in the query, so each allowed call stops at the parser and nothing reaches Safe's service.
  const call = (ip) => GET(new Request('https://adag.example/api/safe/list', { headers: { 'x-vercel-forwarded-for': ip } }));
  const statuses = [];
  for (let i = 0; i < 21; i++) statuses.push((await call('198.51.100.20')).status);
  assert.deepEqual(statuses.slice(0, 20), Array(20).fill(400));
  assert.equal(statuses[20], 429);
  assert.equal((await call('198.51.100.21')).status, 400, 'another client still gets its own window');

  delete process.env.UPSTASH_REDIS_REST_URL;
  const closed = await call('198.51.100.22');
  assert.equal(closed.status, 503);
  assert.match((await closed.json()).error, /key-value store/);
});
