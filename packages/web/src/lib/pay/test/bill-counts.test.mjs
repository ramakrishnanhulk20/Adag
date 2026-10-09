import { test } from 'node:test';
import assert from 'node:assert/strict';

const { sumBillCounts } = await import('../read.ts');

test('both counts are kept apart and the total is their sum', () => {
  const out = sumBillCounts([
    { label: 'current', result: { ok: true, count: 7n } },
    { label: 'first', result: { ok: true, count: 4n } },
  ]);
  assert.deepEqual(out, { ok: true, total: 11n, current: 7n, first: 4n });
});

test('the order the reads arrive in does not change which count is which', () => {
  const out = sumBillCounts([
    { label: 'first', result: { ok: true, count: 4n } },
    { label: 'current', result: { ok: true, count: 7n } },
  ]);
  assert.deepEqual(out, { ok: true, total: 11n, current: 7n, first: 4n });
});

test('a deployment with no bills counts as zero', () => {
  const out = sumBillCounts([
    { label: 'current', result: { ok: true, count: 0n } },
    { label: 'first', result: { ok: true, count: 1n } },
  ]);
  assert.deepEqual(out, { ok: true, total: 1n, current: 0n, first: 1n });
});

test('either read failing makes every count unknown, never smaller', () => {
  assert.deepEqual(
    sumBillCounts([
      { label: 'current', result: { ok: true, count: 7n } },
      { label: 'first', result: { ok: false } },
    ]),
    { ok: false },
  );
  assert.deepEqual(
    sumBillCounts([
      { label: 'current', result: { ok: false } },
      { label: 'first', result: { ok: true, count: 4n } },
    ]),
    { ok: false },
  );
});
