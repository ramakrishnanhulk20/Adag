// Covers lib/pay/howPaid.ts's receipt read against stub clients: when the first node answers "not found" for a transaction
// the second node still has (Arc's public RPC does this for old ones), the second node is asked, and its answer is used.
// Does NOT cover a live node: the e2e scenario (rr) reads the page against the fork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HttpRequestError, TransactionReceiptNotFoundError, encodeAbiParameters, encodeEventTopics } from 'viem';
import { A, C, PAYER, bill } from './fixtures.mjs';

const { readHowPaid } = await import('../../pay/howPaid.ts');

const HASH = `0x${'7d'.repeat(32)}`;
const paid = { kind: 'found', txHash: HASH, logIndex: 3, blockNumber: '100', loanChecked: true, url: 'https://explorer.example/tx/x' };
const paidBill = () => ({ ...bill({ id: 1n }), status: C.BILL_STATUS.Paid, payer: PAYER });

const usdcMarket = C.CURRENCIES[0].marketId;
const morphoLog = (eventName, args, dataTypes, dataValues) => ({
  address: C.MORPHO,
  topics: encodeEventTopics({ abi: A.morphoAbi, eventName, args }),
  data: encodeAbiParameters(dataTypes, dataValues),
  removed: false,
});
const borrowReceipt = {
  blockNumber: 123n,
  logs: [
    morphoLog('SupplyCollateral', { id: usdcMarket, caller: PAYER, onBehalf: PAYER }, [{ type: 'uint256' }], [34_000n]),
    morphoLog('Borrow', { id: usdcMarket, onBehalf: PAYER, receiver: PAYER }, [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [PAYER, 5_000_000n, 4_900_000n]),
  ],
};
const cashReceipt = { blockNumber: 124n, logs: [] };

const notFound = () => new TransactionReceiptNotFoundError({ hash: HASH });

// A client that records what it was asked and answers from a script.
function stub({ receipt, ltv = 123_000_000_000_000_000n }) {
  const asked = { receipts: 0, reads: [] };
  return {
    asked,
    getTransactionReceipt: async () => {
      asked.receipts += 1;
      if (typeof receipt === 'function') return receipt();
      return receipt;
    },
    readContract: async (args) => {
      asked.reads.push(args);
      return ltv;
    },
  };
}

test('a "not found" from the first node is not the end: the second node is asked and its receipt is read', async () => {
  const first = stub({ receipt: () => { throw notFound(); } });
  const second = stub({ receipt: cashReceipt });
  const how = await readHowPaid(first, paidBill(), paid, second);
  assert.deepEqual(how, { kind: 'balance' });
  assert.equal(first.asked.receipts, 1);
  assert.equal(second.asked.receipts, 1);
});

test('a loan paid from bitcoin read from the second node takes its loan-to-value from that node too', async () => {
  const first = stub({ receipt: () => { throw notFound(); } });
  const second = stub({ receipt: borrowReceipt, ltv: 321_000_000_000_000_000n });
  const how = await readHowPaid(first, paidBill(), paid, second);
  assert.equal(how.kind, 'bitcoin');
  assert.equal(how.pledged, 34_000n);
  assert.deepEqual(how.borrowed, [{ symbol: 'USDC', assets: 5_000_000n, ltvAfterWad: 321_000_000_000_000_000n }]);
  assert.equal(first.asked.reads.length, 0, 'the node that did not have the transaction is not asked for state at its block');
  assert.equal(second.asked.reads.length, 1);
  assert.equal(second.asked.reads[0].blockNumber, 123n);
});

test('a "not found" from both nodes stays unanswered: nothing is made up', async () => {
  const gone = () => {
    throw notFound();
  };
  const first = stub({ receipt: gone });
  const second = stub({ receipt: gone });
  assert.deepEqual(await readHowPaid(first, paidBill(), paid, second), { kind: 'unavailable' });
  assert.equal(second.asked.receipts, 1);
});

test('the second node is not asked when the first has the receipt', async () => {
  const first = stub({ receipt: borrowReceipt });
  const second = stub({ receipt: () => { throw new Error('should not be asked'); } });
  const how = await readHowPaid(first, paidBill(), paid, second);
  assert.equal(how.kind, 'bitcoin');
  assert.equal(second.asked.receipts, 0);
  assert.equal(first.asked.reads.length, 1);
});

test('a failure other than "not found" is not answered by the second node', async () => {
  const first = stub({ receipt: () => { throw new HttpRequestError({ url: 'https://rpc.example', body: {}, details: 'down' }); } });
  const second = stub({ receipt: cashReceipt });
  assert.deepEqual(await readHowPaid(first, paidBill(), paid, second), { kind: 'unavailable' });
  assert.equal(second.asked.receipts, 0);
});

test('a "not found" wrapped inside another error still counts as not found', async () => {
  const first = stub({ receipt: () => { throw Object.assign(new Error('read failed'), { cause: notFound() }); } });
  const second = stub({ receipt: cashReceipt });
  assert.deepEqual(await readHowPaid(first, paidBill(), paid, second), { kind: 'balance' });
});
