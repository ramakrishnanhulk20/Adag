import { test } from 'node:test';
import assert from 'node:assert/strict';

const { searchBillPaid } = await import('../paidTx.ts');
const C = await import('../constants.ts');

const PAYER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const PAYEE = '0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B';

// A chain where four blocks share each second, as Arc's do, with the payment at `payBlock`.
function fakeChain(deploy, head, payBlock) {
  const ts = (n) => 1_000_000n + n / 4n;
  return {
    paidAt: ts(payBlock),
    client: {
      getBlock: async ({ blockNumber } = {}) => {
        const n = blockNumber ?? head;
        return { number: n, timestamp: ts(n) };
      },
      getContractEvents: async ({ fromBlock, toBlock, address }) =>
        fromBlock <= payBlock && payBlock <= toBlock
          ? [{ removed: false, address, args: { id: 1n, payer: PAYER, payee: PAYEE, amount: 1_000_000n, loanChecked: true }, transactionHash: `0x${'ab'.repeat(32)}`, logIndex: 3, blockNumber: payBlock }]
          : [],
    },
  };
}

test('a payment in the last of several blocks sharing its second is still found (block times are whole seconds)', async () => {
  const deploy = C.ADAG_DEPLOY_BLOCK;
  for (const offset of [9_003n, 40_001n, 77_778n, 150_000n]) {
    for (const within of [0n, 1n, 2n, 3n]) {
      const payBlock = deploy + offset - (offset % 4n) + within;
      const { client, paidAt } = fakeChain(deploy, deploy + 160_000n, payBlock);
      const bill = { contract: C.ADAG_BILLS, id: 1n, status: C.BILL_STATUS.Paid, paidAt, payer: PAYER, payee: PAYEE, amount: 1_000_000n };
      const found = await searchBillPaid(client, bill);
      assert.equal(found.kind, 'found', `payment at deploy + ${offset} (${within} into its second)`);
      assert.equal(found.blockNumber, String(payBlock));
    }
  }
});
