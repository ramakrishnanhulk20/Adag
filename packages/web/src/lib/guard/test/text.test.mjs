import { test } from 'node:test';
import assert from 'node:assert/strict';

const text = await import('../../alerts/text.ts');
const USDC_MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const EURC_MARKET = '0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4';
const SITE = 'https://adag.example';
const WALLET = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';

// Bill references and names an attacker controls: markup, links, Markdown and control characters.
const HOSTILE = [
  '<b>URGENT</b> <a href="https://evil.example">claim</a>',
  '<script>alert(1)</script>',
  '[Adag support](https://evil.example) **now**',
  '`code` _italic_ ~~strike~~ ||spoiler||',
  '‮evil​',
];
const MARKUP = /[<>`*_~|\[\]‮​]|evil|claim|URGENT|support|script/;

test('alert text is fixed words, numbers and the site origin, whatever else rides along in the input', () => {
  for (const reference of HOSTILE) {
    const messages = [
      text.levelCrossedText({ market: USDC_MARKET, ltvWad: 612300000000000000n, levelWad: 600000000000000000n, reference, name: reference }, SITE),
      text.protectedText({ market: EURC_MARKET, repaid: 1_234_567_891n, ltvBeforeWad: 721000000000000000n, ltvAfterWad: 600000000000000000n, reference, memo: reference }, SITE),
      text.linkedText(SITE, WALLET),
      text.refusedText(WALLET),
      text.movedText(WALLET),
      text.stoppedText(),
      text.pendingText(),
      text.expiredText(),
      text.helloText(),
    ];
    for (const message of messages) {
      assert.doesNotMatch(message, MARKUP, message);
      assert.ok(message.length <= 4096);
    }
  }
});

test('the numbers are computed here and formatted exactly', () => {
  assert.equal(
    text.levelCrossedText({ market: USDC_MARKET, ltvWad: 612300000000000000n, levelWad: 600000000000000000n }, SITE),
    "Adag: your USDC loan is at 61.23% of your bitcoin's value, past your 60.00% alert.\nAdd cirBTC or repay to bring it down: https://adag.example/app",
  );
  assert.equal(
    text.protectedText({ market: EURC_MARKET, repaid: 1_234_567_891n, ltvBeforeWad: 721000000000000000n, ltvAfterWad: 600000000000000000n }, SITE),
    "Adag's loan guard repaid 1,234.57 EURC of your loan from your wallet.\nIt went from 72.10% to 60.00% of your bitcoin's value.\nDetails: https://adag.example/app",
  );
});

test('text in a number field, an unknown market or a site that is not an origin is refused rather than printed', () => {
  assert.throws(() => text.levelCrossedText({ market: USDC_MARKET, ltvWad: '<b>61%</b>', levelWad: 600000000000000000n }, SITE));
  assert.throws(() => text.protectedText({ market: USDC_MARKET, repaid: '1000 <a>', ltvBeforeWad: 1n, ltvAfterWad: 1n }, SITE));
  assert.throws(() => text.levelCrossedText({ market: '0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566', ltvWad: 1n, levelWad: 1n }, SITE));
  assert.throws(() => text.linkedText('javascript:alert(1)', WALLET));
  assert.equal(text.linkedText('https://adag.example/path?<b>=1', WALLET).includes('<'), false, 'only the origin is used');
});
