import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { startMockUpstash } from '../../store/test/mock-upstash.mjs';

const { newLinkCode, issueCode, claimCode, consumePending, readPending, LINK_CODE_TTL_MS, LINK_CODE_BYTES } = await import('../../alerts/code.ts');
const { createStore } = await import('../../store/upstash.ts');
const { keys } = await import('../../store/keys.ts');

const mock = await startMockUpstash();
after(() => mock.close());
const store = createStore({ url: mock.url, token: mock.token });

test('a code carries at least 128 random bits in the start-payload alphabet', () => {
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const { code } = newLinkCode();
    assert.match(code, /^[A-Za-z0-9_-]{32}$/);
    seen.add(code);
  }
  assert.equal(seen.size, 2000, 'no repeats in 2,000 codes');
  // The bits come from what the generator draws from the platform's cryptographic source, not from the text length.
  assert.match(newLinkCode.toString(), /getRandomValues/);
  assert.ok(LINK_CODE_BYTES * 8 >= 128);
});

test('a code expires ten minutes after it is issued', async () => {
  const before = Date.now();
  const { code, expiresAt } = await issueCode(store, before);
  assert.equal(expiresAt, before + LINK_CODE_TTL_MS);
  const set = mock.log.find((args) => args[0] === 'SET' && args[1] === keys.code(code));
  assert.deepEqual(set.slice(3), ['PX', String(LINK_CODE_TTL_MS), 'NX']);
  mock.advance(LINK_CODE_TTL_MS + 1);
  assert.equal(await claimCode(store, code, { id: 111111, handle: 'first_chat' }), false, 'an expired code cannot be claimed');
});

test('a code is used once: the first chat to press Start claims it, and linking spends it', async () => {
  const { code } = await issueCode(store);
  assert.equal(await claimCode(store, code, { id: 111111, handle: 'first_chat' }), true);
  assert.equal(await claimCode(store, code, { id: 222222, handle: 'second_chat' }), false, 'a second chat gets nothing');
  assert.deepEqual(await readPending(store, code), { chatId: '111111', handle: 'first_chat' });
  assert.deepEqual(await consumePending(store, code), { chatId: '111111', handle: 'first_chat' });
  assert.equal(await consumePending(store, code), null, 'a second link with the same code finds nothing');
});

test('a Telegram display name that is not a username never reaches the pending record', async () => {
  const { code } = await issueCode(store);
  assert.equal(await claimCode(store, code, { id: 333333, handle: '<b>Adag support</b>' }), true);
  assert.deepEqual(await readPending(store, code), { chatId: '333333', handle: null });
});
