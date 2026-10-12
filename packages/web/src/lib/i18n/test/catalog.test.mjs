import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parse, TYPE } from '@formatjs/icu-messageformat-parser';

const { LOCALES } = await import('../../../i18n/locales.ts');
const { ALERT_WORDS } = await import('../../alerts/textCatalog.ts');

// The five catalogs say the same things with the same shapes: one key set, the same ICU arguments, plural branches and
// rich-text tags, every number, address and hash exactly as in English (Ram's rule), no empty string, neither of the
// two long dashes (code points 2014 and 2015 hex), no emoji.
const MESSAGES = fileURLToPath(new URL('../../../../messages/', import.meta.url));
const read = (locale) => JSON.parse(readFileSync(`${MESSAGES}${locale}.json`, 'utf8'));

const flatten = (node, prefix = '', out = new Map()) => {
  for (const [key, value] of Object.entries(node)) {
    const full = prefix ? `${prefix}.${key}` : key;
    if (typeof value === 'string') out.set(full, value);
    else flatten(value, full, out);
  }
  return out;
};

// The ICU shape of a message: argument names with their kind, plural branch names, and tag names, as a sorted list.
function shape(message) {
  const found = [];
  const walk = (elements) => {
    for (const el of elements) {
      if (el.type === TYPE.argument) found.push(`arg:${el.value}`);
      else if (el.type === TYPE.number || el.type === TYPE.date || el.type === TYPE.time) found.push(`fmt:${el.value}`);
      else if (el.type === TYPE.pound) found.push('pound');
      else if (el.type === TYPE.tag) {
        found.push(`tag:${el.value}`);
        walk(el.children);
      } else if (el.type === TYPE.plural || el.type === TYPE.select) {
        found.push(`${el.type === TYPE.plural ? 'plural' : 'select'}:${el.value}`);
        for (const [name, option] of Object.entries(el.options)) {
          found.push(`branch:${el.value}:${name}`);
          walk(option.value);
        }
      }
    }
  };
  walk(parse(message, { ignoreTag: false }));
  return found.sort();
}

// Every run of digits (with the commas and points inside a number), in order of appearance.
const numbers = (text) => (text.match(/\d+(?:[.,]\d+)*/g) ?? []).sort();
const hexes = (text) => (text.match(/0x[0-9a-fA-F]{4,}/g) ?? []).sort();

// English spells small numbers out ("ten minutes"), but CJK readers need digits: 十分 can read as "enough" and 이 분
// as "this person". So a translation may write a digit for a number the English spells, and nothing else.
const SPELLED = { zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9', ten: '10', eleven: '11', twelve: '12', twenty: '20', thirty: '30' };
const spelled = (text) => (text.toLowerCase().match(new RegExp(`\\b(${Object.keys(SPELLED).join('|')})\\b`, 'g')) ?? []).map((w) => SPELLED[w]);
function numbersDiffer(english, value) {
  const theirs = numbers(value);
  const left = [...theirs];
  for (const n of numbers(english)) {
    const at = left.indexOf(n);
    if (at === -1) return true;
    left.splice(at, 1);
  }
  const allowed = spelled(english);
  return left.some((n) => !allowed.includes(n));
}

const DASHES = new RegExp(`[${String.fromCharCode(0x2014)}${String.fromCharCode(0x2015)}]`);
const EMOJI = /\p{Extended_Pictographic}/u;

const en = flatten(read('en'));

test('the English catalog parses as ICU and has no empty value, long dash or emoji', () => {
  for (const [key, value] of en) {
    assert.notEqual(value.trim(), '', `${key} is empty`);
    assert.doesNotThrow(() => parse(value), `${key} does not parse as ICU`);
    assert.ok(!DASHES.test(value), `${key} has a long dash`);
    assert.ok(!EMOJI.test(value), `${key} has an emoji`);
  }
  assert.ok(['space', 'none'].includes(en.get('lib.joiner')), 'lib.joiner names the sentence joiner');
});

for (const locale of LOCALES.filter((l) => l !== 'en')) {
  test(`${locale} says the same things as English, in the same shapes`, () => {
    const other = flatten(read(locale));
    const missing = [...en.keys()].filter((k) => !other.has(k));
    const extra = [...other.keys()].filter((k) => !en.has(k));
    assert.deepEqual(missing, [], `${locale} lacks keys`);
    assert.deepEqual(extra, [], `${locale} has keys English lacks`);
    const problems = [];
    for (const [key, english] of en) {
      const value = other.get(key);
      if (value.trim() === '') problems.push(`${key}: empty`);
      if (DASHES.test(value)) problems.push(`${key}: long dash`);
      if (EMOJI.test(value)) problems.push(`${key}: emoji`);
      let parsed = true;
      try {
        parse(value);
      } catch (e) {
        parsed = false;
        problems.push(`${key}: does not parse as ICU (${e.message})`);
      }
      if (parsed) {
        const a = shape(english);
        const b = shape(value);
        if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${key}: ICU shape ${JSON.stringify(b)} differs from English ${JSON.stringify(a)}`);
      }
      // Markup in the catalog is never raw HTML: rich text goes through the tag functions the component passes.
      if (/<[a-z][^>]*>/i.test(value) && shape(value).every((s) => !s.startsWith('tag:'))) problems.push(`${key}: raw markup`);
      if (numbersDiffer(english, value)) problems.push(`${key}: numbers ${JSON.stringify(numbers(value))} differ from English ${JSON.stringify(numbers(english))}`);
      if (JSON.stringify(hexes(english)) !== JSON.stringify(hexes(value))) problems.push(`${key}: addresses or hashes differ from English`);
    }
    assert.ok(['space', 'none'].includes(other.get('lib.joiner')), `${locale} lib.joiner`);
    assert.deepEqual(problems, [], `${locale}:\n${problems.join('\n')}`);
  });
}

// Each alert text is a function of the figures text.ts computes; the same figures go in for every locale, and what
// comes out must carry them unchanged.
const WALLET = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const APP = 'https://adag.site/app/protect';
const SAMPLE = {
  levelCrossed: ['USDC', '61.25%', '60%', APP],
  protected: ['12.50', 'USDC', '38.12%', '30.00%', APP],
  linked: [WALLET, APP],
  refused: [WALLET],
  moved: [WALLET],
  stopped: [],
  pending: [],
  expired: [],
  hello: [],
};

test('the Telegram alert words exist in every locale with the same keys, the same figures and no long dash or emoji', () => {
  const english = ALERT_WORDS.en;
  assert.ok(english && Object.keys(english).length >= 9, 'English alert words exist');
  assert.deepEqual(Object.keys(english).sort(), Object.keys(SAMPLE).sort(), 'every alert text has a sample');
  for (const locale of LOCALES) {
    const words = ALERT_WORDS[locale];
    assert.ok(words, `${locale} alert words exist`);
    assert.deepEqual(Object.keys(words).sort(), Object.keys(english).sort(), `${locale} alert word keys`);
    for (const [key, make] of Object.entries(words)) {
      const value = make(...SAMPLE[key]);
      const reference = english[key](...SAMPLE[key]);
      assert.equal(typeof value, 'string', `${locale} ${key} is a string`);
      assert.notEqual(value.trim(), '', `${locale} ${key} is empty`);
      assert.ok(!DASHES.test(value), `${locale} ${key} has a long dash`);
      assert.ok(!EMOJI.test(value), `${locale} ${key} has an emoji`);
      assert.deepEqual(numbers(value), numbers(reference), `${locale} ${key} numbers`);
      assert.deepEqual(hexes(value), hexes(reference), `${locale} ${key} address`);
      for (const arg of SAMPLE[key]) assert.ok(value.includes(arg), `${locale} ${key} carries ${arg}`);
    }
  }
});
