import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { startMockUpstash } from '../../store/test/mock-upstash.mjs';

const { LOCALES } = await import('../../../i18n/locales.ts');
const text = await import('../../alerts/text.ts');
const { issueCode, claimCodeWithLang, parsePending, readPending, cleanHandle } = await import('../../alerts/code.ts');
const { bind, unbind, langOfChat } = await import('../../alerts/links.ts');
const { createStore } = await import('../../store/upstash.ts');
const { keys } = await import('../../store/keys.ts');
const { CSV_HEADER, CSV_WORDS_EN, billRow } = await import('../../pay/csv.ts');
const { BILL_STATUS } = await import('../../pay/constants.ts');

const USDC_MARKET = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const SITE = 'https://adag.site';
const WALLET = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const WAD = 10n ** 18n;

const mock = await startMockUpstash();
after(() => mock.close());
const store = createStore({ url: mock.url, token: mock.token });

const MESSAGES = fileURLToPath(new URL('../../../../messages/', import.meta.url));
const catalog = (locale) => JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, 'utf8'));

// Every alert, in every language, carries the same figures and the same wallet, and says it in that language (I4).
const ALERTS = {
  levelCrossed: (lang) => text.levelCrossedText({ market: USDC_MARKET, ltvWad: (WAD * 6125n) / 10000n, levelWad: (WAD * 60n) / 100n }, SITE, lang),
  protected: (lang) => text.protectedText({ market: USDC_MARKET, repaid: 12_500000n, ltvBeforeWad: (WAD * 3812n) / 10000n, ltvAfterWad: (WAD * 30n) / 100n }, SITE, lang),
  linked: (lang) => text.linkedText(SITE, WALLET, lang),
  refused: (lang) => text.refusedText(WALLET, lang),
  moved: (lang) => text.movedText(WALLET, lang),
  stopped: (lang) => text.stoppedText(lang),
  pending: (lang) => text.pendingText(lang),
  expired: (lang) => text.expiredText(lang),
  hello: (lang) => text.helloText(lang),
};
const FIGURES = { levelCrossed: ['USDC', '61.25%', '60.00%', `${SITE}/app`], protected: ['12.50', 'USDC', '38.12%', '30.00%', `${SITE}/app`], linked: [WALLET, `${SITE}/app`], refused: [WALLET], moved: [WALLET] };

for (const [name, make] of Object.entries(ALERTS)) {
  test(`${name} alert exists in the five languages with the same figures`, () => {
    const seen = new Set();
    for (const lang of LOCALES) {
      const out = make(lang);
      assert.ok(out.length > 10, `${lang} ${name} has text`);
      for (const figure of FIGURES[name] ?? []) assert.ok(out.includes(figure), `${lang} ${name} carries ${figure}`);
      assert.ok(!/[<>*_`\[\]]/.test(out.replace(/https:\/\/[^\s]+/g, '')), `${lang} ${name} has no markup`);
      seen.add(out);
    }
    assert.equal(seen.size, LOCALES.length, `${name} differs in each language`);
  });
}

test('an unknown, missing or hostile language means English', () => {
  const english = text.stoppedText('en');
  assert.equal(text.stoppedText(), english);
  assert.equal(text.stoppedText(null), english);
  assert.equal(text.stoppedText('fr'), english);
  assert.equal(text.stoppedText('xx<script>'), english);
  assert.equal(text.stoppedText('ZH-CN'), english);
});

test('a code carries the language from issue to claim, and an old record without one reads as English', async () => {
  const ja = await issueCode(store, Date.now(), 'ja');
  const claimed = await claimCodeWithLang(store, ja.code, { id: 101, handle: 'someone' });
  assert.deepEqual(claimed, { claimed: true, lang: 'ja' });
  assert.equal((await readPending(store, ja.code)).lang, 'ja');

  const en = await issueCode(store, Date.now());
  assert.equal(await store.get(keys.code(en.code)), 'issued', 'English writes the bare record, as before the languages');
  assert.deepEqual(await claimCodeWithLang(store, en.code, { id: 102, handle: null }), { claimed: true, lang: 'en' });
  assert.deepEqual(await readPending(store, en.code), { chatId: '102', handle: null });

  // A record from before the languages existed: no lang field at all.
  assert.deepEqual(parsePending(JSON.stringify({ chatId: '7', handle: 'old_handle' })), { chatId: '7', handle: cleanHandle('old_handle') });
  // A tampered record names a language that is not one of the five: English, and the value is not kept.
  assert.deepEqual(parsePending(JSON.stringify({ chatId: '8', handle: null, lang: 'xx<script>' })), { chatId: '8', handle: null });
  // A code record with a bad language suffix claims as English.
  const bad = await issueCode(store, Date.now());
  await store.set(keys.code(bad.code), 'issued:xx<script>');
  assert.deepEqual(await claimCodeWithLang(store, bad.code, { id: 103, handle: null }), { claimed: true, lang: 'en' });
});

test('a linked chat keeps its language, English keeps no record, and an unknown value reads as English', async () => {
  assert.equal(await langOfChat(store, '501'), 'en', 'no record means English');
  assert.deepEqual(await bind(store, WALLET, '501', 'ko'), { ok: true, previousChat: null });
  assert.equal(await langOfChat(store, '501'), 'ko');
  assert.equal(await store.get(keys.chatLang('501')), 'ko');

  // Moving the wallet to a new chat in English drops the old chat's language and writes none for the new one.
  assert.deepEqual(await bind(store, WALLET, '502'), { ok: true, previousChat: '501' });
  assert.equal(await store.get(keys.chatLang('501')), null);
  assert.equal(await store.get(keys.chatLang('502')), null);
  assert.equal(await langOfChat(store, '502'), 'en');

  await store.set(keys.chatLang('502'), 'xx<script>');
  assert.equal(await langOfChat(store, '502'), 'en', 'a value that is not one of the five is English');
  await unbind(store, WALLET);
  assert.equal(await store.get(keys.chatLang('502')), null);
  assert.equal(await langOfChat(store, null), 'en');
});

// The CSV: the header and the status words follow the language; the figures, addresses and links do not.
const HEADER_KEYS = ['contractAddress', 'billNumber', 'status', 'writtenAt', 'paidAt', 'supplier', 'payer', 'amount', 'currency', 'reference', 'transactionLink', 'fortyCheckRan'];
const headerIn = (locale) => HEADER_KEYS.map((k) => catalog(locale).csv.header[k]);
const wordsIn = (locale) => catalog(locale).csv.words;

test('the English CSV header is the one the file always had, and ja and es have their own', () => {
  assert.deepEqual(headerIn('en'), [...CSV_HEADER]);
  assert.deepEqual(wordsIn('en'), CSV_WORDS_EN);
  for (const locale of ['ja', 'es']) {
    const header = headerIn(locale);
    assert.equal(header.length, CSV_HEADER.length, `${locale} header has every column`);
    assert.ok(header.every((h) => typeof h === 'string' && h.trim() !== ''), `${locale} header has no empty column`);
    assert.notDeepEqual(header, [...CSV_HEADER], `${locale} header is translated`);
    assert.ok(header[11].includes('40%'), `${locale} keeps the 40% in the last column`);
  }
  // The wording is the reviewed catalog's; what is fixed is that the two headers are their own languages, not each other's.
  assert.ok(headerIn('ja').every((h) => /[぀-ヿ一-鿿]/.test(h)), 'every ja column is written in Japanese');
  assert.ok(headerIn('es').every((h) => /^[a-záéíóúñ0-9%()\/ ]+$/i.test(h)), 'every es column is written in Spanish');
  assert.notDeepEqual(headerIn('ja'), headerIn('es'));
});

test('a CSV row translates only the status and flag words', () => {
  const bill = {
    contract: '0x1111111111111111111111111111111111111111',
    id: 12n,
    payee: '0x2222222222222222222222222222222222222222',
    status: BILL_STATUS.Paid,
    due: 0n,
    currency: '0x3600000000000000000000000000000000000000',
    createdAt: 1_760_000_000n,
    amount: 1_250_500000n,
    payer: WALLET,
    paidAt: 1_760_100_000n,
    ref: '0x496e766f6963652031303432',
  };
  const paid = { kind: 'found', txHash: '0xabc', logIndex: 0, blockNumber: '1', loanChecked: true, checkedOnBill: null, url: 'https://explorer.arc.io/tx/0xabc' };
  const english = billRow(bill, paid);
  for (const locale of ['ja', 'es', 'ko', 'zh-CN']) {
    const row = billRow(bill, paid, wordsIn(locale));
    assert.equal(row.length, english.length);
    // Status (index 2) and the 40% flag (index 11) follow the language; every other cell is byte for byte English.
    assert.equal(row[2], wordsIn(locale).paid);
    assert.equal(row[11], wordsIn(locale).yes);
    assert.deepEqual(row.filter((_, i) => i !== 2 && i !== 11), english.filter((_, i) => i !== 2 && i !== 11));
  }
  const unavailable = billRow(bill, { kind: 'unavailable' }, wordsIn('es'));
  assert.equal(unavailable[10], wordsIn('es').unavailable);
  assert.equal(unavailable[11], wordsIn('es').unknown);
  const open = billRow({ ...bill, status: BILL_STATUS.Open }, null, wordsIn('ja'));
  assert.equal(open[2], wordsIn('ja').open);
  assert.equal(open[10], '');
});
