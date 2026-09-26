// Runs only when UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN are in the environment. It writes only under
// the "test:" prefix and deletes every key it wrote. Nothing it reads or writes is printed.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

const url = process.env.UPSTASH_REDIS_REST_URL;
const token = process.env.UPSTASH_REDIS_REST_TOKEN;
const skip = !url || !token ? 'no Upstash credentials in the environment' : false;

const { createStore } = await import('../../store/upstash.ts');
const { keys } = await import('../../store/keys.ts');
const store = skip ? null : createStore({ url, token, namespace: 'test:' });
const written = [];
after(async () => {
  for (const key of written) await store?.del(key).catch(() => {});
});

test('the real store: SET NX PX holds a lease, GETDEL spends once, the guarded delete frees only its own lease', { skip }, async () => {
  const lease = keys.lease();
  const code = keys.code('T'.repeat(32));
  written.push(lease, code);
  assert.equal(await store.set(lease, 'run-a', { nx: true, px: 20_000 }), true);
  assert.equal(await store.set(lease, 'run-b', { nx: true, px: 20_000 }), false, 'a second run is refused');
  assert.equal(await store.delIfEquals(lease, 'run-b'), false, 'run b cannot free run a');
  assert.equal(await store.delIfEquals(lease, 'run-a'), true);
  assert.equal(await store.set(code, 'issued', { nx: true, px: 20_000 }), true);
  assert.equal(await store.getdel(code), 'issued');
  assert.equal(await store.getdel(code), null, 'spent');
});

test('the real store: counters expire and sets hold normalised addresses', { skip }, async () => {
  const counter = keys.rate('code', 'test-subject');
  const set = keys.linked();
  written.push(counter, set);
  assert.equal(await store.incrby(counter, 1, 20), 1);
  assert.equal(await store.incrby(counter, 2, 20), 3);
  await store.sadd(set, '0x6e26dd347b57ba591ee34292a2d828ccc17a1fde');
  assert.deepEqual(await store.smembers(set), ['0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE']);
  assert.equal(await store.scard(set), 1);
});
