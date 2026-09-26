import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

const { buildMessage, verifySigned, checkLevels, MessageError } = await import('../../alerts/message.ts');

// Fresh keys each run; they exist only in this process.
const alice = privateKeyToAccount(generatePrivateKey());
const mallory = privateKeyToAccount(generatePrivateKey());
const SITE = 'https://adag.example';
const now = Math.floor(Date.now() / 1000);
const CODE = 'abcdefghijklmnopqrstuvwxyz012345';

const link = (over = {}) => ({ action: 'link', wallet: alice.address, code: CODE, chatId: '5550001', chatHandle: 'alice_t', expiry: now + 300, ...over });

test('the link message names the action, site, chain 5042, wallet, code, chat handle and id, and expiry', () => {
  const message = buildMessage(SITE, link());
  for (const part of ['link this wallet to a Telegram chat', `Site: ${SITE}`, 'Chain: 5042', `Wallet: ${alice.address}`, `Code: ${CODE}`, 'Chat: @alice_t (id 5550001)', `(${now + 300})`]) {
    assert.ok(message.includes(part), part);
  }
});

test('a signature from the named wallet over the exact message verifies', async () => {
  const message = buildMessage(SITE, link());
  const signature = await alice.signMessage({ message });
  assert.equal(await verifySigned({ message, signature, wallet: alice.address, expiry: now + 300, nowSeconds: now }), true);
});

test('another wallet, another chat, another site or an edited message does not verify', async () => {
  const message = buildMessage(SITE, link());
  const signature = await alice.signMessage({ message });
  const wrongSigner = await mallory.signMessage({ message });
  assert.equal(await verifySigned({ message, signature: wrongSigner, wallet: alice.address, expiry: now + 300, nowSeconds: now }), false);
  for (const other of [buildMessage(SITE, link({ chatId: '5550002' })), buildMessage('https://evil.example', link()), buildMessage(SITE, link({ code: CODE.replace('a', 'b') }))]) {
    assert.equal(await verifySigned({ message: other, signature, wallet: alice.address, expiry: now + 300, nowSeconds: now }), false);
  }
});

test('expired, too far ahead, malleable (high s) or wrongly sized signatures are refused', async () => {
  const message = buildMessage(SITE, link());
  const signature = await alice.signMessage({ message });
  assert.equal(await verifySigned({ message, signature, wallet: alice.address, expiry: now + 300, nowSeconds: now + 301 }), false, 'expired');
  const far = buildMessage(SITE, link({ expiry: now + 3600 }));
  assert.equal(await verifySigned({ message: far, signature: await alice.signMessage({ message: far }), wallet: alice.address, expiry: now + 3600, nowSeconds: now }), false, 'an hour ahead');

  const n = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141n;
  const s = BigInt(`0x${signature.slice(66, 130)}`);
  const v = parseInt(signature.slice(130), 16);
  const flipped = `${signature.slice(0, 66)}${(n - s).toString(16).padStart(64, '0')}${(v === 27 ? 28 : 27).toString(16)}`;
  assert.equal(await verifySigned({ message, signature: flipped, wallet: alice.address, expiry: now + 300, nowSeconds: now }), false, 'high s');
  assert.equal(await verifySigned({ message, signature: signature.slice(0, 130), wallet: alice.address, expiry: now + 300, nowSeconds: now }), false, '64 bytes');
  assert.equal(await verifySigned({ message, signature: `${signature}00`, wallet: alice.address, expiry: now + 300, nowSeconds: now }), false, '66 bytes');
  assert.equal(await verifySigned({ message, signature: 12, wallet: alice.address, expiry: now + 300, nowSeconds: now }), false, 'not a string');
});

test('unlink and threshold messages carry the nonce, and levels are exact whole basis points', async () => {
  const nonce = '0x' + '11'.repeat(16);
  const unlink = buildMessage(SITE, { action: 'unlink', wallet: alice.address, nonce, expiry: now + 60 });
  assert.ok(unlink.includes(`Nonce: ${nonce}`));
  const levels = buildMessage(SITE, { action: 'thresholds', wallet: alice.address, nonce, expiry: now + 60, levelsWad: [600000000000000000n, 755000000000000000n] });
  assert.ok(levels.includes('Levels: 60.00%, 75.50%'));
  assert.throws(() => checkLevels(['900000000000000000']), MessageError, 'past 85%');
  assert.throws(() => checkLevels(['600000000000000001']), MessageError, 'not a whole basis point');
  assert.throws(() => checkLevels(['700000000000000000', '600000000000000000']), MessageError, 'falling');
  assert.throws(() => checkLevels([600000000000000000]), MessageError, 'a number, not a string');
  assert.throws(() => checkLevels(['1e18']), MessageError, 'not an integer');
});

test('a Telegram name that is not a username is left out of the signed text', () => {
  const message = buildMessage(SITE, link({ chatHandle: '<a href="x">support</a>' }));
  assert.ok(message.includes('Chat: (id 5550001)'));
  assert.ok(!message.includes('<'));
});
