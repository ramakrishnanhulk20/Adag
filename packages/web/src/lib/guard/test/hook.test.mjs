import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { keccak256, toBytes } from 'viem';

const { verifyQuickNode, parseAnswerUpdated } = await import('../hook.ts');
const { ANSWER_UPDATED_TOPIC } = await import('../constants.ts');

const SECRET = 'qn-test-secret';
const sign = (nonce, timestamp, payload, secret = SECRET) => createHmac('sha256', secret).update(nonce + timestamp + payload).digest('hex');
const log = (address, topic0 = ANSWER_UPDATED_TOPIC) => ({ address, topics: [topic0, '0x01', '0x02'], data: '0x' });

test('the AnswerUpdated topic is the hash of its signature', () => {
  assert.equal(ANSWER_UPDATED_TOPIC, keccak256(toBytes('AnswerUpdated(int256,uint256,uint256)')));
});

test('a delivery signed with the secret over nonce, timestamp and body verifies; anything else does not', () => {
  const payload = JSON.stringify([log('0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362')]);
  const nowMs = Date.now();
  const ts = String(Math.floor(nowMs / 1000));
  const good = { secret: SECRET, nonce: 'n-1', timestamp: ts, signature: sign('n-1', ts, payload), payload, nowMs };
  assert.equal(verifyQuickNode(good), true);
  assert.equal(verifyQuickNode({ ...good, payload: payload.replace('733F', '733f') }), false, 'edited body');
  assert.equal(verifyQuickNode({ ...good, nonce: 'n-2' }), false, 'other nonce');
  assert.equal(verifyQuickNode({ ...good, signature: sign('n-1', ts, payload, 'other-secret') }), false, 'other secret');
  assert.equal(verifyQuickNode({ ...good, signature: null }), false, 'no signature');
  assert.equal(verifyQuickNode({ ...good, signature: 'zz' }), false, 'not hex');
  const old = String(Math.floor(nowMs / 1000) - 3600);
  assert.equal(verifyQuickNode({ ...good, timestamp: old, signature: sign('n-1', old, payload) }), false, 'an hour old');
  const ms = String(nowMs);
  assert.equal(verifyQuickNode({ ...good, timestamp: ms, signature: sign('n-1', ms, payload) }), true, 'milliseconds work too');
});

test('the parser counts only AnswerUpdated from the two watched aggregators, however the payload is shaped', () => {
  assert.deepEqual(parseAnswerUpdated({ matchedReceipts: [{ logs: [log('0x733fe1ba02ea9003c3cfbf5dcc41cf685ff64362')] }] }).feeds, ['0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362']);
  assert.deepEqual(parseAnswerUpdated([log('0xCEDbC96d866EBe46dcbeF8Ed12F9feA2C464d88F'), log('0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362')]).feeds.length, 2);
  assert.deepEqual(parseAnswerUpdated([log('0x000000000000000000000000000000000000dEaD')]).feeds, [], 'another contract');
  assert.deepEqual(parseAnswerUpdated([log('0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362', '0x' + '00'.repeat(32))]).feeds, [], 'another event');
  let deep = log('0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362');
  for (let i = 0; i < 50; i++) deep = { next: deep };
  assert.deepEqual(parseAnswerUpdated(deep).feeds, [], 'nesting past the bound is not read');
  assert.deepEqual(parseAnswerUpdated('not json object').feeds, []);
});
