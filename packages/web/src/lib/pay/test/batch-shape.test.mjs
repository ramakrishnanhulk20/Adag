// Covers the shape rule in lib/pay/build.ts's assertCalls (C3): every batch each builder writes passes it, and each
// tamper below, made to an ordinary batch a builder wrote, is refused. Does NOT cover amounts (the contracts and
// scripts/check-batches.mjs hold those), the guard page's own batches (lib/guard/build.ts has its own check), the
// server's re-check of a Safe batch (lib/safe/multisend.ts), or a real run.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeFunctionData, getAddress, parseAbi } from 'viem';
import { A, AT, ATTACKER, C, PAYER, POSITION, approveCall, bill, build, builtBill, builtClose, call3, convertFunding, eurc, replaceAt, transferCall, usdc } from '../../fx/test/fixtures.mjs';

const { ADAG_GUARD } = await import('../../guard/constants.ts');
const { guardAbi } = await import('../../guard/abi.ts');

const SAFE = getAddress('0x00000000000000000000000000000000000a0001');
const encode = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args });
const intent = (bills, sender = 'wallet', payer = PAYER) => ({ payer, bills, sender });
const passes = (calls, scope, guardMarket = null) => build.assertCalls(calls, guardMarket, null, scope);
const refuses = (calls, reason, scope, guardMarket = null) =>
  assert.throws(() => build.assertCalls(calls, guardMarket, null, scope), (e) => /^Refusing /.test(e.message) && reason.test(e.message), String(reason));
const innerOf = (safeBatch) => safeBatch.inner.map((i) => call3(i.to, i.data));
const payData = (id) => encode(A.adagAbi, 'pay', [id]);
const enrolData = encodeFunctionData({ abi: A.adagAbi, functionName: 'enrol' });
const memoOf = (target, data, id = 7n, ref = '0x') => call3(C.MEMO, encode(A.memoAbi, 'memo', [target, data, build.memoId(id), ref]));
const nested = (calls) => call3(C.MULTICALL3_FROM, encode(A.multicall3FromAbi, 'aggregate3', [calls]));

const seven = bill();
const eight = bill({ id: 8n, amount: 3_000_000n, currency: C.EURC });
const ONE = intent([seven]);
const NONE = intent([]);
// [approve USDC to AdagBills, Memo pay(7)]
const fromBalance = build.buildPayFromBalance(seven, PAYER).calls;
// [approve cirBTC to Morpho, supplyCollateral, borrow, approve USDC to AdagBills, Memo pay(7)]
const fromBitcoin = build.buildPayFromBitcoin(seven, PAYER, 3_000n, usdc.params).calls;
// [approve USDC to Morpho, repay by shares, withdrawCollateral, approve USDC to Morpho at 0]
const close = build.buildCloseLoan(PAYER, usdc, POSITION, 2_000n, usdc.params).calls;

// ---- every batch each builder writes still passes ----

test('buildPayFromBalance: the exact approval and the Memo payment pass, on either AdagBills', () => {
  passes(fromBalance, ONE);
  const first = bill({ contract: C.ADAG_BILLS_FIRST });
  passes(build.buildPayFromBalance(first, PAYER).calls, intent([first]));
});

test('buildPayFromBitcoin: pledge, borrow, approval and payment pass, with or without a pledge', () => {
  passes(fromBitcoin, ONE);
  passes(build.buildPayFromBitcoin(seven, PAYER, 0n, usdc.params).calls, ONE);
});

test('buildPayMany: a two-currency basket paid from bitcoin and from the balance passes', () => {
  const b = build.buildPayMany([seven, eight], PAYER, { USDC: { from: 'bitcoin', pledge: 3_000n, marketParams: usdc.params }, EURC: { from: 'balance' } });
  passes(b.calls, intent([seven, eight]));
});

test('buildPayConverted and a converting basket pass, as built and as the sender reads the bytes back', () => {
  const one = builtBill();
  build.assertConversionBatch(one.to, one.data, one.conversion, PAYER);
  const mixed = build.buildPayMany([seven, eight], PAYER, { USDC: convertFunding(), EURC: { from: 'bitcoin', pledge: 104_020n, marketParams: eurc.params } });
  build.assertConversionBatch(mixed.to, mixed.data, mixed.conversion, PAYER);
});

test('buildAddCollateral: the approval and the pledge pass', () => {
  passes(build.buildAddCollateral(PAYER, usdc, 5_000n, usdc.params).calls, NONE);
});

test('buildRepaySome: the approval and the repayment by assets pass', () => {
  passes(build.buildRepaySome(PAYER, eurc, 1_000_000n, eurc.params, 2_000_000n).calls, NONE);
});

test('buildCloseLoan: a full close, a withdrawal only, and a close that stops the guard pass', () => {
  passes(close, NONE);
  passes(build.buildCloseLoan(PAYER, usdc, { shares: 0n, collateral: 5_000n }, 0n, usdc.params).calls, NONE);
  const stop = build.buildCloseLoan(PAYER, eurc, POSITION, 2_000n, eurc.params, { hasRule: true, allowance: 535_652n });
  passes(stop.calls, NONE, C.MARKET_EURC);
});

test('buildCloseWithOtherCurrency passes, with and without the guard stopped in the same batch', () => {
  for (const out of [builtClose(), builtClose(undefined, { hasRule: true, allowance: 1n })]) {
    build.assertConversionBatch(out.to, out.data, out.conversion, PAYER);
  }
});

test('buildSafeBatch: the Safe pays AdagBills directly and passes the same rule with the Safe as the payer', () => {
  const s = build.buildSafeBatch(SAFE, [seven, eight], { USDC: { from: 'bitcoin', pledge: 3_000n, marketParams: usdc.params }, EURC: { from: 'balance' } });
  passes(innerOf(s), intent([seven, eight], 'safe', SAFE));
});

test('buildSafeEnrol: enrol on its own passes from a Safe', () => {
  passes(innerOf(build.buildSafeEnrol(SAFE)), intent([], 'safe', SAFE));
});

// ---- what an ordinary batch refuses ----

test('a cirBTC transfer to anyone is refused, the payer included, before or after the rest', () => {
  for (const to of [ATTACKER, PAYER, C.MORPHO, C.ADAG_BILLS]) {
    refuses([...fromBitcoin, transferCall(C.CIRBTC, to, 1n)], /token call other than an approval/, ONE);
    refuses([transferCall(C.CIRBTC, to, 1n), ...fromBitcoin], /token call other than an approval/, ONE);
  }
  refuses([...fromBalance, transferCall(C.USDC, ATTACKER, 1n)], /token call other than an approval/, ONE);
});

test('a USDC transferFrom, and every other token call but an exact approve, is refused', () => {
  const more = parseAbi([
    'function transferFrom(address from, address to, uint256 amount) returns (bool)',
    'function increaseAllowance(address spender, uint256 added) returns (bool)',
    'function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)',
  ]);
  const attempts = [
    call3(C.USDC, encode(more, 'transferFrom', [PAYER, ATTACKER, 1n])),
    call3(C.EURC, encode(more, 'increaseAllowance', [C.MORPHO, 1n])),
    call3(C.USDC, encode(more, 'permit', [PAYER, ATTACKER, 1n, 1n, 27, `0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`])),
    call3(C.CIRBTC, '0x'),
    call3(C.USDC, `${approveCall(C.USDC, C.MORPHO, 1n).callData}00`),
  ];
  for (const c of attempts) refuses([...fromBalance, c], /token call other than an approval/, ONE);
});

test('an approval to a spender outside the list is refused, and so is one to AdagBills that no bill uses', () => {
  for (const spender of [ATTACKER, PAYER, C.MEMO, C.MULTICALL3_FROM]) refuses([...fromBalance, approveCall(C.USDC, spender, 1n)], /Refusing an approval to 0x/, ONE);
  refuses([...fromBalance, approveCall(C.CIRBTC, C.ADAG_BILLS, 1n)], /cirBTC approval to AdagBills/, ONE);
  refuses([...fromBalance, approveCall(C.USDC, C.ADAG_BILLS_FIRST, 1n)], /no bill in this batch is on/, ONE);
  refuses([...close, approveCall(C.USDC, C.ADAG_BILLS, 1n)], /no bill in this batch is on/, NONE);
});

test('a Memo call whose inner call is not exactly pay(id) is refused', () => {
  const attempts = [
    memoOf(C.ADAG_BILLS, encode(A.adagAbi, 'voidBill', [7n])),
    memoOf(C.ADAG_BILLS, encode(A.adagAbi, 'createBill', [C.USDC, 1n, 1n, '0x'])),
    memoOf(C.ADAG_BILLS, enrolData),
    memoOf(C.ADAG_BILLS, `${payData(7n)}00`),
    memoOf(C.ADAG_BILLS, '0x'),
    call3(C.MEMO, `${fromBalance[1].callData}00`),
  ];
  for (const c of attempts) refuses([fromBalance[0], c], /not a bill payment/, ONE);
});

test('a Memo call that targets any contract but AdagBills is refused', () => {
  const attempts = [
    memoOf(C.USDC, encode(A.erc20Abi, 'transfer', [ATTACKER, 1n])),
    memoOf(C.CIRBTC, encode(A.erc20Abi, 'approve', [ATTACKER, 1n])),
    memoOf(C.MORPHO, encode(A.morphoAbi, 'borrow', [usdc.params, 1n, 0n, PAYER, ATTACKER])),
    memoOf(C.MEMO, fromBalance[1].callData),
    memoOf(C.MULTICALL3_FROM, encode(A.multicall3FromAbi, 'aggregate3', [[fromBalance[0]]])),
    memoOf(ADAG_GUARD, encode(guardAbi, 'clearRule', [usdc.marketId])),
    memoOf(ATTACKER, payData(7n)),
  ];
  for (const c of attempts) refuses([...fromBalance, c], /not a bill payment/, ONE);
});

test('a Memo payment of a bill the batch is not paying, or of the same bill twice, is refused', () => {
  refuses([fromBalance[0], build.buildPayFromBalance(bill({ id: 8n }), PAYER).calls[1]], /not built for/, ONE);
  refuses([fromBalance[0], build.buildPayFromBalance(bill({ contract: C.ADAG_BILLS_FIRST }), PAYER).calls[1]], /not built for/, ONE);
  refuses([...fromBalance, fromBalance[1]], /paid twice/, ONE);
  refuses([fromBalance[1]], /not built for/, NONE);
  refuses([fromBalance[1]], /not built for/, null);
});

test('a Memo payment filed under another bill’s memo id is refused, and a bill left unpaid is too', () => {
  refuses([fromBalance[0], memoOf(C.ADAG_BILLS, payData(7n), 8n)], /another bill's memo id/, ONE);
  refuses(fromBalance, /unpaid/, intent([seven, bill({ id: 8n })]));
});

test('a Morpho borrow for, or paying out to, anyone but the payer is refused, as is any Morpho call with no payer named', () => {
  const borrow = (over) => {
    const a = { params: usdc.params, assets: seven.amount, shares: 0n, onBehalf: PAYER, receiver: PAYER, ...over };
    return call3(C.MORPHO, encode(A.morphoAbi, 'borrow', [a.params, a.assets, a.shares, a.onBehalf, a.receiver]));
  };
  refuses(replaceAt(fromBitcoin, 2, borrow({ onBehalf: ATTACKER })), /made for anyone but the payer/, ONE);
  refuses(replaceAt(fromBitcoin, 2, borrow({ receiver: ATTACKER })), /sends money to anyone but the payer/, ONE);
  refuses(replaceAt(fromBitcoin, 1, call3(C.MORPHO, encode(A.morphoAbi, 'supplyCollateral', [usdc.params, 3_000n, ATTACKER, '0x']))), /made for anyone but the payer/, ONE);
  refuses(replaceAt(close, 1, call3(C.MORPHO, encode(A.morphoAbi, 'repay', [usdc.params, 0n, POSITION.shares, ATTACKER, '0x']))), /made for anyone but the payer/, NONE);
  refuses(replaceAt(close, 2, call3(C.MORPHO, encode(A.morphoAbi, 'withdrawCollateral', [usdc.params, POSITION.collateral, PAYER, ATTACKER]))), /sends money to anyone but the payer/, NONE);
  refuses(fromBitcoin, /made for anyone but the payer/, intent([seven], 'wallet', ATTACKER));
  refuses(fromBitcoin, /made for anyone but the payer/, null);
});

test('a Morpho call on another market, any other Morpho function, or one that asks for a callback is refused', () => {
  const on = (params) => call3(C.MORPHO, encode(A.morphoAbi, 'borrow', [params, seven.amount, 0n, PAYER, PAYER]));
  for (const params of [{ ...usdc.params, oracle: ATTACKER }, { ...usdc.params, lltv: usdc.params.lltv - 1n }, { ...eurc.params, loanToken: C.USDC }]) {
    refuses(replaceAt(fromBitcoin, 2, on(params)), /not one of Adag's two/, ONE);
  }
  refuses(replaceAt(fromBitcoin, 2, call3(C.MORPHO, encode(A.morphoAbi, 'setAuthorization', [ATTACKER, true]))), /Morpho call this app does not make/, ONE);
  refuses(replaceAt(fromBitcoin, 2, call3(C.MORPHO, `${fromBitcoin[2].callData}00`)), /Morpho call this app does not make/, ONE);
  refuses(replaceAt(fromBitcoin, 1, call3(C.MORPHO, encode(A.morphoAbi, 'supplyCollateral', [usdc.params, 3_000n, PAYER, '0x01']))), /call back/, ONE);
});

test('a Multicall3From call nested in the batch is refused, whatever it holds', () => {
  for (const inner of [[fromBalance[0]], [], [fromBalance[1]]]) {
    refuses([...fromBalance, nested(inner)], /batch inside the batch/, ONE);
    refuses([nested(inner), ...fromBalance], /batch inside the batch/, ONE);
  }
});

test('an unknown AdagBills selector, or any direct AdagBills call, is refused in a wallet batch', () => {
  const attempts = ['0xdeadbeef', '0x', payData(7n), encode(A.adagAbi, 'voidBill', [7n]), encode(A.adagAbi, 'createBill', [C.USDC, 1n, 1n, '0x']), enrolData];
  for (const data of attempts) {
    refuses([...fromBalance, call3(C.ADAG_BILLS, data)], /direct call to AdagBills/, ONE);
    refuses([...fromBalance, call3(C.ADAG_BILLS_FIRST, data)], /direct call to AdagBills/, ONE);
  }
});

test('from a Safe: no Memo, no transfer, no nested batch, only its own bills paid, and enrol only on its own', () => {
  const calls = innerOf(build.buildSafeBatch(SAFE, [seven], { USDC: { from: 'balance' } }));
  const scope = intent([seven], 'safe', SAFE);
  passes(calls, scope);
  refuses([calls[0], fromBalance[1]], /Memo call in a Safe batch/, scope);
  refuses([...calls, transferCall(C.USDC, ATTACKER, 1n)], /token call other than an approval/, scope);
  refuses([...calls, nested([])], /batch inside the batch/, scope);
  refuses([calls[0], call3(C.ADAG_BILLS, payData(8n))], /not built for/, scope);
  refuses([...calls, call3(C.ADAG_BILLS, enrolData)], /other than paying one of its bills/, scope);
  refuses([calls[0], call3(C.ADAG_BILLS, encode(A.adagAbi, 'voidBill', [7n]))], /other than paying one of its bills/, scope);
  refuses(calls, /direct call to AdagBills/, intent([seven]));
});

test('in a close, AdagGuard takes only this loan’s exact clearRule, and its approval only at 0', () => {
  const stop = build.buildCloseLoan(PAYER, eurc, POSITION, 2_000n, eurc.params, { hasRule: true, allowance: 535_652n }).calls;
  const at = stop.length - 2;
  refuses(replaceAt(stop, at, call3(ADAG_GUARD, `${stop[at].callData}00`)), /exactly stopping this loan's rule/, NONE, C.MARKET_EURC);
  refuses(replaceAt(stop, at, call3(ADAG_GUARD, encode(guardAbi, 'setRule', [eurc.marketId, 1n, 0n, 0n]))), /loan guard call other than/, NONE, C.MARKET_EURC);
  refuses(replaceAt(stop, at, call3(ADAG_GUARD, encode(guardAbi, 'protect', [PAYER, eurc.marketId]))), /loan guard call other than/, NONE, C.MARKET_EURC);
  refuses(stop, /loan guard call other than/, NONE);
  refuses(replaceAt(stop, stop.length - 1, approveCall(C.EURC, ADAG_GUARD, 1n)), /approval to the loan guard/, NONE, C.MARKET_EURC);
});

test('a conversion batch is held to the same shapes: a payment under another memo id is refused there too', () => {
  const b = builtBill();
  const wrongId = memoOf(C.ADAG_BILLS, payData(7n), 8n, seven.ref);
  assert.throws(() => build.assertCalls(replaceAt(b.calls, AT.pay, wrongId), null, b.conversion), /another bill's memo id/);
});
