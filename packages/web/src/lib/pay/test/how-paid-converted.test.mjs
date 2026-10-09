// Covers lib/pay/howPaid.ts's `converted` flag against stub clients: a borrowed amount reads as converted only when the
// receipt holds a Transfer emitted by that token's fixed address, from the payer to Circle's swap adapter.
// Does NOT cover a live node or the card's wording: the e2e scenario reads the page against the fork.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeAbiParameters, encodeEventTopics } from 'viem';
import { A, ATTACKER, C, PAYER, bill, transferLog } from '../../fx/test/fixtures.mjs';

const { readHowPaid } = await import('../howPaid.ts');

const HASH = `0x${'7d'.repeat(32)}`;
const paid = { kind: 'found', txHash: HASH, logIndex: 3, blockNumber: '100', loanChecked: true, url: 'https://explorer.example/tx/x' };
const paidBill = () => ({ ...bill({ id: 6n }), status: C.BILL_STATUS.Paid, payer: PAYER });

const eurcMarket = C.CURRENCIES[1].marketId;
const morphoLog = (eventName, args, dataTypes, dataValues) => ({
  address: C.MORPHO,
  topics: encodeEventTopics({ abi: A.morphoAbi, eventName, args }),
  data: encodeAbiParameters(dataTypes, dataValues),
  removed: false,
});
const eurcLoanLogs = () => [
  morphoLog('SupplyCollateral', { id: eurcMarket, caller: PAYER, onBehalf: PAYER }, [{ type: 'uint256' }], [34_000n]),
  morphoLog('Borrow', { id: eurcMarket, onBehalf: PAYER, receiver: PAYER }, [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }], [PAYER, 87_000_000n, 86_000_000n]),
];

const clientFor = (logs) => ({
  getTransactionReceipt: async () => ({ blockNumber: 123n, logs }),
  readContract: async () => 123_000_000_000_000_000n,
});

const borrowedIn = async (logs) => {
  const how = await readHowPaid(clientFor(logs), paidBill(), paid, clientFor([]));
  assert.equal(how.kind, 'bitcoin');
  return how.borrowed;
};

test('a Transfer of EURC from the payer to the swap adapter marks the EURC loan converted', async () => {
  const logs = [...eurcLoanLogs(), transferLog(C.EURC, PAYER, C.CIRCLE_SWAP_ADAPTER, 87_000_000n)];
  const borrowed = await borrowedIn(logs);
  assert.equal(borrowed.length, 1);
  assert.equal(borrowed[0].symbol, 'EURC');
  assert.equal(borrowed[0].converted, true);
});

test('the same Transfer emitted by a different address does not mark it converted', async () => {
  const logs = [...eurcLoanLogs(), transferLog(ATTACKER, PAYER, C.CIRCLE_SWAP_ADAPTER, 87_000_000n)];
  const borrowed = await borrowedIn(logs);
  assert.equal(borrowed[0].converted, false);
});

test('a Transfer of EURC to any other address does not mark it converted', async () => {
  const logs = [...eurcLoanLogs(), transferLog(C.EURC, PAYER, ATTACKER, 87_000_000n)];
  const borrowed = await borrowedIn(logs);
  assert.equal(borrowed[0].converted, false);
});
