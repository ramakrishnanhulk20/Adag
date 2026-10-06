// Covers lib/pay/receipt.ts's payer-aware proof of payment (C72, with C16 and C33 still holding). Does NOT cover how a
// screen turns the proof into words, or the balance reads at the receipt's block (next order).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, PAYER, PAYEE, ATTACKER, billPaidLog } from './fixtures.mjs';

const { billPaidIn, billsPaidIn, matchBillPaid } = await import('../../pay/receipt.ts');

test('a BillPaid from the bill’s own contract, for its id and the connected account, proves payment', () => {
  const proof = billPaidIn([billPaidLog()], C.ADAG_BILLS, 7n, PAYER);
  assert.equal(proof.payer, PAYER);
  assert.equal(proof.payee, PAYEE);
  assert.equal(proof.amount, 100_000_000n);
  assert.equal(proof.logIndex, 3);
});

test('C72: a forged BillPaid, with the right topic and data but emitted by another address, proves nothing', () => {
  for (const emitter of [ATTACKER, C.CIRCLE_SWAP_ADAPTER, C.MEMO, C.MORPHO]) {
    const forged = billPaidLog({ contract: emitter });
    assert.equal(billPaidIn([forged], C.ADAG_BILLS, 7n, PAYER), null);
    assert.equal(billPaidIn([forged], C.ADAG_BILLS, 7n), null);
    assert.equal(matchBillPaid(forged, C.ADAG_BILLS, 7n, PAYER), null);
  }
});

test('C72: a real BillPaid for another id proves nothing for this one, even from AdagBills with the same payer', () => {
  const other = billPaidLog({ id: 8n });
  assert.equal(billPaidIn([other], C.ADAG_BILLS, 7n, PAYER), null);
  assert.equal(billPaidIn([other], C.ADAG_BILLS, 7n), null);
  assert.equal(billPaidIn([other], C.ADAG_BILLS, 8n, PAYER).payer, PAYER);
});

test('C72: a real BillPaid for this id with another payer is not this payment once a payer is named', () => {
  const byOther = billPaidLog({ payer: ATTACKER });
  assert.equal(billPaidIn([byOther], C.ADAG_BILLS, 7n, PAYER), null);
  assert.equal(billPaidIn([billPaidLog(), byOther], C.ADAG_BILLS, 7n, ATTACKER)?.payer, ATTACKER);
});

test('C72: the right proof is found even when forged and mismatched ones come first', () => {
  const logs = [billPaidLog({ contract: ATTACKER }), billPaidLog({ id: 9n }), billPaidLog({ payer: ATTACKER }), billPaidLog()];
  assert.equal(billPaidIn(logs, C.ADAG_BILLS, 7n, PAYER)?.payer, PAYER);
});

test('C33 still holds: the first deployment’s BillPaid is not proof on the current one, and a removed log is skipped', () => {
  const first = billPaidLog({ contract: C.ADAG_BILLS_FIRST });
  assert.equal(billPaidIn([first], C.ADAG_BILLS, 7n, PAYER), null);
  assert.equal(billPaidIn([first], C.ADAG_BILLS_FIRST, 7n, PAYER)?.payer, PAYER);
  assert.equal(billPaidIn([{ ...billPaidLog(), removed: true }], C.ADAG_BILLS, 7n, PAYER), null);
  assert.equal(billPaidIn([{ ...billPaidLog(), transactionHash: null }], C.ADAG_BILLS, 7n, PAYER), null);
  assert.throws(() => billPaidIn([], C.MORPHO, 7n, PAYER), /not one of Adag/);
});

test('a basket is proven bill by bill, each against the same payer', () => {
  const logs = [billPaidLog({ id: 1n }), billPaidLog({ id: 2n, payer: ATTACKER }), billPaidLog({ id: 3n })];
  const found = billsPaidIn(logs, C.ADAG_BILLS, [1n, 2n, 3n, 4n], PAYER);
  assert.deepEqual([...found.keys()], [1n, 3n]);
  assert.equal(billsPaidIn(logs, C.ADAG_BILLS, [1n, 2n, 3n]).size, 3, 'callers that name no payer keep the earlier behaviour');
});
