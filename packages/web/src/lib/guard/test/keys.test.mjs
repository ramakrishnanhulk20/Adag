import { test } from 'node:test';
import assert from 'node:assert/strict';

const { keys, normaliseAddress, normaliseChatId, normaliseCode, normaliseMarket, normaliseNonce, KeyError } = await import('../../store/keys.ts');

const LOWER = '0x6e26dd347b57ba591ee34292a2d828ccc17a1fde';
const CHECKSUMMED = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';

test('one wallet has one spelling: every case becomes the checksummed address', () => {
  assert.equal(normaliseAddress(LOWER), CHECKSUMMED);
  assert.equal(normaliseAddress(LOWER.toUpperCase().replace('0X', '0x')), CHECKSUMMED);
  assert.equal(keys.link(LOWER), keys.link(CHECKSUMMED));
  assert.equal(keys.thresholds(LOWER), `adag:v1:alerts:thresholds:${CHECKSUMMED}`);
});

test('anything that is not a wallet is refused', () => {
  for (const bad of ['', '0x123', `${LOWER}00`, '0x0000000000000000000000000000000000000000', 42, null, undefined, {}, `${LOWER}\n`]) {
    assert.throws(() => normaliseAddress(bad), KeyError, String(bad));
  }
});

test('one chat has one spelling: "123", 123 and negative group ids agree, junk is refused', () => {
  assert.equal(normaliseChatId('123'), '123');
  assert.equal(normaliseChatId(123), '123');
  assert.equal(normaliseChatId('-1001234567890'), '-1001234567890');
  assert.equal(keys.chat(987654321), keys.chat('987654321'));
  for (const bad of ['0123', '12a', '1.5', 1.5, 0, '0', '', ' 123', '99999999999999999', 2 ** 60, NaN, null]) {
    assert.throws(() => normaliseChatId(bad), KeyError, String(bad));
  }
});

test('codes, nonces and markets have one form each', () => {
  assert.throws(() => normaliseCode('short'), KeyError);
  assert.throws(() => normaliseCode('a'.repeat(31) + '!'), KeyError);
  assert.equal(normaliseCode('A'.repeat(32)), 'A'.repeat(32));
  assert.equal(normaliseNonce('0x' + 'AB'.repeat(16)), '0x' + 'ab'.repeat(16));
  assert.throws(() => normaliseNonce('0x' + 'ab'.repeat(15)), KeyError);
  assert.equal(
    normaliseMarket('0xC2DB905F174E5DEFCCE01D321B09F15F78856A36A21B90CC7E1ABBC29225815D'),
    '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d',
  );
  assert.throws(() => normaliseMarket('0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566'), KeyError);
});

test('odd rate-limit and replay subjects collapse into one bucket instead of making new keys', () => {
  assert.equal(keys.rate('code', '1.2.3.4'), 'adag:v1:rate:code:1.2.3.4');
  assert.equal(keys.rate('code', 'x'.repeat(200)), 'adag:v1:rate:code:other');
  assert.equal(keys.hookNonce('a b'), 'adag:v1:hooks:nonce:other');
});
