// Covers lib/pay/receipt.ts's convertedInto and conversionOutcome (C72, screen side): what a conversion put into the
// payer's wallet, from Transfer logs of the fixed token with the payer as recipient. Does NOT cover how a screen words
// the result, or balances read at the receipt's block.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { C, PAYER, PAYEE, ATTACKER, transferLog } from '../../fx/test/fixtures.mjs';

const { convertedInto, conversionOutcome } = await import('../receipt.ts');

const logged = (log, over = {}) => ({ ...log, blockNumber: 1n, transactionHash: `0x${'22'.repeat(32)}`, logIndex: 0, removed: false, ...over });

test('the swap output arriving in the wallet is counted, from every sender, and nothing else', () => {
  const logs = [
    logged(transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, PAYER, 70_000_000n)),
    logged(transferLog(C.USDC, ATTACKER, PAYER, 30_500_000n)),
    logged(transferLog(C.USDC, PAYER, PAYEE, 100_000_000n)),
  ];
  assert.equal(convertedInto(logs, C.USDC, PAYER), 100_500_000n);
});

test('the balance check, a transfer from the payer to the payer, is not new money', () => {
  const logs = [logged(transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, PAYER, 100_300_000n)), logged(transferLog(C.USDC, PAYER, PAYER, 110_000_000n))];
  assert.equal(convertedInto(logs, C.USDC, PAYER), 100_300_000n);
});

test('a transfer of another token, from a look-alike emitter, to someone else, or in a removed log is not counted', () => {
  const logs = [
    logged(transferLog(C.EURC, C.CIRCLE_SWAP_ADAPTER, PAYER, 5_000_000n)),
    logged(transferLog(ATTACKER, C.CIRCLE_SWAP_ADAPTER, PAYER, 5_000_000n)),
    logged(transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, ATTACKER, 5_000_000n)),
    logged(transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, PAYER, 5_000_000n), { removed: true }),
  ];
  assert.equal(convertedInto(logs, C.USDC, PAYER), 0n);
});

test('a log that is not a plain Transfer of the token is skipped without stopping the count', () => {
  const odd = { ...transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, PAYER, 9n), topics: ['0x' + '12'.repeat(32)] };
  const wide = { ...transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, PAYER, 9n), data: '0x1234' };
  const logs = [logged(odd), logged(wide), logged(transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, PAYER, 42n))];
  assert.equal(convertedInto(logs, C.USDC, PAYER), 42n);
});

test('the surplus is what the swap returned beyond what was spent, and never below zero', () => {
  const logs = [logged(transferLog(C.USDC, C.CIRCLE_SWAP_ADAPTER, PAYER, 100_450_000n))];
  assert.deepEqual(conversionOutcome(logs, { token: C.USDC, payer: PAYER, spent: 100_000_000n }), { converted: 100_450_000n, surplus: 450_000n });
  assert.deepEqual(conversionOutcome(logs, { token: C.USDC, payer: PAYER, spent: 100_450_000n }), { converted: 100_450_000n, surplus: 0n });
  assert.deepEqual(conversionOutcome(logs, { token: C.USDC, payer: PAYER, spent: 200_000_000n }), { converted: 100_450_000n, surplus: 0n });
  assert.deepEqual(conversionOutcome([], { token: C.USDC, payer: PAYER, spent: 1n }), { converted: 0n, surplus: 0n });
});
