import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkedOnBill } = await import('../paidTx.ts');
const C = await import('../constants.ts');

const PAYER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const OTHER_PAYER = '0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B';
const OTHER_CONTRACT = '0x00000000000000000000000000000000000000aa';
const TX = `0x${'ab'.repeat(32)}`;
const OTHER_TX = `0x${'cd'.repeat(32)}`;

const log = ({ id, address = C.ADAG_BILLS, payer = PAYER, loanChecked, transactionHash = TX }) => ({
  removed: false,
  address,
  transactionHash,
  args: { id, payer, loanChecked },
});

test('a bill that ran the check itself points at no other bill', () => {
  const logs = [log({ id: 3n, loanChecked: true }), log({ id: 4n, loanChecked: true })];
  assert.equal(checkedOnBill({ loanChecked: true, txHash: TX }, logs, C.ADAG_BILLS, PAYER), null);
});

test('an unchecked bill points at the sibling in the same transaction that ran the check', () => {
  const logs = [log({ id: 3n, loanChecked: true }), log({ id: 4n, loanChecked: false }), log({ id: 5n, loanChecked: false })];
  assert.equal(checkedOnBill({ loanChecked: false, txHash: TX }, logs, C.ADAG_BILLS, PAYER), 3n);
});

test('a checked BillPaid from a different contract does not count', () => {
  const logs = [log({ id: 3n, loanChecked: true, address: OTHER_CONTRACT }), log({ id: 5n, loanChecked: false })];
  assert.equal(checkedOnBill({ loanChecked: false, txHash: TX }, logs, C.ADAG_BILLS, PAYER), null);
});

test('a checked BillPaid for a different payer does not count', () => {
  const logs = [log({ id: 3n, loanChecked: true, payer: OTHER_PAYER }), log({ id: 5n, loanChecked: false })];
  assert.equal(checkedOnBill({ loanChecked: false, txHash: TX }, logs, C.ADAG_BILLS, PAYER), null);
});

test('a checked BillPaid from another transaction does not count', () => {
  const logs = [log({ id: 3n, loanChecked: true, transactionHash: OTHER_TX }), log({ id: 5n, loanChecked: false })];
  assert.equal(checkedOnBill({ loanChecked: false, txHash: TX }, logs, C.ADAG_BILLS, PAYER), null);
});
