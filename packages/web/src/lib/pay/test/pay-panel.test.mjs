// Covers lib/pay/receipt.ts's payPanelFor and keepsPayPanel: which card a bill's pay panel shows, and whether the bill
// page keeps the panel mounted while a payment is under way. Does NOT cover the React rendering, the page poll's timing,
// or what the receipt card says: scripts/e2e.mjs scenario fx-a forces the poll's refresh to land first and checks those.
import { test } from 'node:test';
import assert from 'node:assert/strict';

const { payPanelFor, keepsPayPanel } = await import('../receipt.ts');
const { BILL_STATUS } = await import('../constants.ts');

test('a bill that is not open never offers the pay options, whatever the panel is doing', () => {
  for (const status of [BILL_STATUS.None, BILL_STATUS.Paid, BILL_STATUS.Void, 4, 255]) {
    for (const paid of [false, true]) {
      for (const busy of [false, true]) {
        assert.notEqual(payPanelFor({ status, paid, busy }), 'options', `status ${status}, paid ${paid}, busy ${busy}`);
      }
    }
  }
});

test('a paid bill shows the receipt once proven, the progress while the receipt is read, and its status otherwise', () => {
  assert.equal(payPanelFor({ status: BILL_STATUS.Paid, paid: true, busy: false }), 'receipt');
  assert.equal(payPanelFor({ status: BILL_STATUS.Paid, paid: false, busy: true }), 'progress');
  assert.equal(payPanelFor({ status: BILL_STATUS.Paid, paid: false, busy: false }), 'closed');
});

test('an open bill offers the pay options until this wallet has paid it', () => {
  assert.equal(payPanelFor({ status: BILL_STATUS.Open, paid: false, busy: false }), 'options');
  assert.equal(payPanelFor({ status: BILL_STATUS.Open, paid: false, busy: true }), 'options');
  assert.equal(payPanelFor({ status: BILL_STATUS.Open, paid: true, busy: false }), 'receipt');
});

test('a refresh that reports Paid before the receipt is read cannot unmount the panel at any step of the payment', () => {
  // The order fx-a once lost: pressed and mined, the page's poll refreshes the bill to Paid, then the receipt is read.
  const steps = [
    { open: true, paying: false, actedHere: false, safeProposed: false },
    { open: true, paying: true, actedHere: false, safeProposed: false },
    { open: false, paying: true, actedHere: false, safeProposed: false },
    { open: false, paying: false, actedHere: true, safeProposed: false },
  ];
  for (const s of steps) assert.equal(keepsPayPanel(s), true, JSON.stringify(s));
  // With no payment of this wallet's under way, the same refresh hands over to the page's "Already paid" panel.
  assert.equal(keepsPayPanel({ open: false, paying: false, actedHere: false, safeProposed: false }), false);
});
