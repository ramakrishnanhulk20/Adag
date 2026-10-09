// Covers the conversion rules in lib/pay/build.ts: the builders (C66, C69, C70, C75), the adapter rule in assertCalls
// (C65, C67, C68), the Safe refusal (C74) and the sender's re-check of the bytes. Every tamper test starts from a batch
// the builder wrote and changes one thing. Does NOT cover a real run (scripts/check-fx.mjs F9 and F10) or the wallet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decodeFunctionData, encodeFunctionData, getAddress } from 'viem';
import {
  AT, ATTACKER, A, C, CHAIN_TIME, MAX_FEE, OWN_USDC, PAYEE, PAYER, POSITION, RATE, SIGNATURE, TOTAL, bill, build, builtBill, builtClose, call3, approveCall,
  closeFunding, convertFunding, eurc, moveBefore, planParams, replaceAt, reverseFunding, transferCall, usdc, without,
} from './fixtures.mjs';

const { floorSlack, encodeExecute, EXECUTE_SELECTOR } = await import('../plan.ts');
const { amountToSell, maxAmountToSell } = await import('../estimate.ts');

const erc20 = (c) => decodeFunctionData({ abi: A.erc20Abi, data: c.callData });
const morpho = (c) => decodeFunctionData({ abi: A.morphoAbi, data: c.callData });
const selector = (c) => c.callData.slice(0, 10);
const encode = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args });
const refuses = (calls, reason, conversion) => assert.throws(() => build.assertCalls(calls, null, conversion), (e) => reason.test(e.message), String(reason));
const builderRefuses = (fn, reason) => assert.throws(fn, (e) => reason.test(e.message), String(reason));

const b = builtBill();
const calls = b.calls;
const conv = b.conversion;

// ---- the batch the builder writes ----

test('a 100 USDC bill from a EURC loan is built in the order FX-1 proved on Arc, ending with the adapter at 0', () => {
  assert.equal(calls.length, 9);
  assert.deepEqual(calls.map((c) => c.target), [C.CIRBTC, C.MORPHO, C.MORPHO, C.EURC, C.CIRCLE_SWAP_ADAPTER, C.USDC, C.USDC, C.MEMO, C.EURC]);
  assert.equal(morpho(calls[AT.supply]).functionName, 'supplyCollateral');
  assert.equal(morpho(calls[AT.borrow]).functionName, 'borrow');
  assert.deepEqual(erc20(calls[AT.approveAdapter]).args, [C.CIRCLE_SWAP_ADAPTER, conv.amountIn]);
  assert.equal(selector(calls[AT.execute]), EXECUTE_SELECTOR);
  assert.deepEqual(erc20(calls[AT.floor]).args, [PAYER, conv.floor]);
  assert.deepEqual(erc20(calls[AT.approveBill]).args, [C.ADAG_BILLS, TOTAL]);
  assert.deepEqual(erc20(calls[AT.reset]).args, [C.CIRCLE_SWAP_ADAPTER, 0n]);
  assert.equal(b.to, C.MULTICALL3_FROM);
  build.assertCalls(calls, null, conv);
});

test('C66, C68: the conversion carries the figures the checks are held to', () => {
  assert.equal(conv.payer, PAYER);
  assert.equal(conv.tokenIn, C.EURC);
  assert.equal(conv.tokenOut, C.USDC);
  assert.equal(conv.amountIn, amountToSell(TOTAL, 'USDC', RATE, 40n));
  assert.equal(conv.minOut, TOTAL);
  assert.equal(conv.borrow, conv.amountIn);
  assert.equal(conv.borrowedUsdc, 0n);
  assert.equal(conv.gas, C.FX_GAS_CAP);
  assert.equal(conv.maxFeePerGas, MAX_FEE);
  assert.equal(conv.chainTime, CHAIN_TIME);
  assert.equal(conv.floor, OWN_USDC + TOTAL - floorSlack(MAX_FEE), 'a USDC output takes the gas slack off the floor');
  assert.equal(conv.bills.length, 1);
});

test('C66: X is the same bigint the batch borrows, approves and the plan pulls', () => {
  const x = conv.amountIn;
  assert.equal(morpho(calls[AT.borrow]).args[1], x);
  assert.equal(erc20(calls[AT.approveAdapter]).args[1], x);
  const plan = decodeFunctionData({ abi: A.circleAdapterAbi, data: calls[AT.execute].callData });
  assert.equal(plan.args[1][0].amount, x);
});

test('C69: the pledge and the borrow go to the loan market, which is the other currency’s', () => {
  for (const at of [AT.supply, AT.borrow]) assert.deepEqual(morpho(calls[at]).args[0], eurc.params);
  assert.deepEqual(erc20(calls[AT.approveBtc]).args, [C.MORPHO, 3_048_120n]);
});

test('single bill and basket forms of the same conversion are the same bytes', () => {
  const funding = convertFunding();
  const one = build.buildPayConverted(bill(), PAYER, funding);
  const many = build.buildPayMany([bill()], PAYER, { USDC: funding });
  assert.equal(one.data, many.data);
});

test('the other direction, a EURC bill from a USDC loan, borrows USDC and takes no gas slack off a EURC floor', () => {
  const r = build.buildPayConverted(bill({ id: 9n, amount: 3_000_000n, currency: C.EURC }), PAYER, reverseFunding({ outputBalance: 1_234_567n }));
  assert.equal(r.conversion.tokenIn, C.USDC);
  assert.equal(r.conversion.tokenOut, C.EURC);
  assert.equal(r.conversion.floor, 1_234_567n + 3_000_000n);
  assert.equal(r.conversion.borrowedUsdc, r.conversion.amountIn);
  assert.deepEqual(morpho(r.calls[AT.borrow]).args[0], usdc.params);
  assert.equal(r.calls[AT.execute].target, C.CIRCLE_SWAP_ADAPTER);
  build.assertCalls(r.calls, null, r.conversion);
});

test('C68: a bill too small for the balance check to mean anything is not offered', () => {
  builderRefuses(() => build.buildPayConverted(bill({ amount: 1n }), PAYER, convertFunding({ total: 1n, outputBalance: 0n })), /too small for the balance check/);
  build.buildPayConverted(bill({ amount: 1n }), PAYER, convertFunding({ total: 1n, outputBalance: 1_000_000n }));
});

test('a basket mixes one converted group with a bitcoin group: every pledge before every borrow, every pay after the swap', () => {
  const eurcBill = bill({ id: 8n, amount: 3_000_000n, currency: C.EURC });
  const mixed = build.buildPayMany([bill(), eurcBill], PAYER, { USDC: convertFunding(), EURC: { from: 'bitcoin', pledge: 104_020n, marketParams: eurc.params } });
  const at = (pred) => mixed.calls.flatMap((c, i) => (pred(c) ? [i] : []));
  const supplies = at((c) => c.target === C.MORPHO && morpho(c).functionName === 'supplyCollateral');
  const borrows = at((c) => c.target === C.MORPHO && morpho(c).functionName === 'borrow');
  const swap = at((c) => c.target === C.CIRCLE_SWAP_ADAPTER)[0];
  assert.equal(supplies.length, 2);
  assert.equal(borrows.length, 2);
  assert.ok(Math.max(...supplies) < Math.min(...borrows));
  assert.ok(Math.max(...borrows) < swap);
  assert.ok(at((c) => c.target === C.MEMO).every((i) => i > swap));
  assert.equal(mixed.conversion.pledge, 3_048_120n + 104_020n);
  assert.equal(mixed.conversion.bills.length, 2);
  build.assertCalls(mixed.calls, null, mixed.conversion);
});

test('a basket with a converted group and a group paid from the balance builds too', () => {
  const out = build.buildPayMany([bill(), bill({ id: 8n, amount: 3_000_000n, currency: C.EURC })], PAYER, { USDC: convertFunding(), EURC: { from: 'balance' } });
  build.assertCalls(out.calls, null, out.conversion);
});

test('batches with no conversion are exactly what they were, and carry no conversion', () => {
  const plain = build.buildPayMany([bill()], PAYER, { USDC: { from: 'bitcoin', pledge: 3_000n, marketParams: usdc.params } });
  assert.equal('conversion' in plain, false);
  assert.deepEqual(plain.calls.map((c) => c.target), [C.CIRBTC, C.MORPHO, C.MORPHO, C.USDC, C.MEMO]);
  assert.equal('conversion' in build.buildPayFromBalance(bill(), PAYER), false);
  assert.equal(build.BATCH_TARGETS.some((t) => t === C.CIRCLE_SWAP_ADAPTER), false);
  assert.equal(build.APPROVAL_SPENDERS.some((t) => t === C.CIRCLE_SWAP_ADAPTER), false);
});

// ---- what the builder refuses ----

test('C69: a bill is paid by converting the other currency, never its own', () => {
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ loan: 'USDC' })), /converting a EURC loan, never a USDC one/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ loan: 'BTC' })), /never a BTC one/);
});

test('C69: the market params are proven by hash against the loan market, and a look-alike is refused', () => {
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ marketParams: usdc.params })), /hash to/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ marketParams: { ...eurc.params, lltv: eurc.params.lltv - 1n } })), /hash to/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ marketParams: { ...eurc.params, oracle: C.USDC_MARKET_ORACLE } })), /hash to/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ marketParams: { ...eurc.params, irm: ATTACKER } })), /hash to|malformed/);
});

test('C70: X may not exceed the bill at the euro price AdagBills reads plus 1.5%', () => {
  const ceiling = maxAmountToSell(TOTAL, 'USDC', RATE);
  build.buildPayConverted(bill(), PAYER, convertFunding({ amountIn: ceiling }));
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ amountIn: ceiling + 1n })), /more than these bills are worth/);
  const plan = convertFunding().plan;
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ amountIn: 0n, plan })), /more than zero/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ amountIn: -1n, plan })), /more than zero/);
});

test('C70: nothing is built while the euro feed is past AdagBills’ 96 hours', () => {
  const old = { ...RATE, updatedAt: CHAIN_TIME - 96n * 3600n - 1n };
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ rate: old })), /96 hours/);
  build.buildPayConverted(bill(), PAYER, convertFunding({ rate: { ...RATE, updatedAt: CHAIN_TIME - 96n * 3600n } }));
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ rate: { ...RATE, answer: 0n } })), /not positive/);
});

test('C66: a plan that pulls another amount, names another wallet, or is about to expire is refused when the batch is built', () => {
  const x = convertFunding().amountIn;
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ plan: convertFunding({ amountIn: x - 1n }).plan })), /different amount/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ plan: convertFunding({ amountIn: x + 1n }).plan })), /different amount/);
  builderRefuses(() => build.buildPayConverted(bill(), ATTACKER, convertFunding()), /not your wallet/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ chainTime: CHAIN_TIME + 481n })), /expires in under 120 seconds/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ deadline: CHAIN_TIME + 100n })), /expires in under 120 seconds/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ plan: `${convertFunding().plan}00` })), /extra or reshaped bytes/);
});

test('C68: the floor needs a fee ceiling, for either output currency, and a balance that is not negative', () => {
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ maxFeePerGas: 0n })), /fee ceiling/);
  builderRefuses(() => build.buildPayConverted(bill({ id: 9n, amount: 3_000_000n, currency: C.EURC }), PAYER, reverseFunding({ maxFeePerGas: 0n })), /fee ceiling/);
  builderRefuses(() => build.buildPayConverted(bill(), PAYER, convertFunding({ outputBalance: -1n })), /negative/);
});

test('head chef: two converting groups in one basket are refused', () => {
  const eurcBill = bill({ id: 8n, amount: 3_000_000n, currency: C.EURC });
  builderRefuses(() => build.buildPayMany([bill(), eurcBill], PAYER, { USDC: convertFunding(), EURC: reverseFunding() }), /one direction only/);
  builderRefuses(() => build.buildPayMany([eurcBill, bill()], PAYER, { EURC: reverseFunding(), USDC: convertFunding() }), /one direction only/);
});

test('head chef: conversions in opposite directions are refused in a batch put together by hand, as well', () => {
  const back = reverseFunding();
  const opposite = [...calls.slice(0, AT.floor + 1), approveCall(C.USDC, C.CIRCLE_SWAP_ADAPTER, back.amountIn), call3(C.CIRCLE_SWAP_ADAPTER, back.plan), ...calls.slice(AT.floor + 1)];
  refuses(opposite, /2 swap calls/, conv);
  const reverseBatch = build.buildPayConverted(bill({ id: 9n, amount: 3_000_000n, currency: C.EURC }), PAYER, reverseFunding());
  const forward = [...reverseBatch.calls.slice(0, AT.floor + 1), approveCall(C.EURC, C.CIRCLE_SWAP_ADAPTER, conv.amountIn), calls[AT.execute], ...reverseBatch.calls.slice(AT.floor + 1)];
  refuses(forward, /2 swap calls/, reverseBatch.conversion);
});

test('C74: a Safe is never offered a conversion, however the plan is spelled', () => {
  const safe = getAddress('0x00000000000000000000000000000000000a0001');
  const safeBill = bill();
  const attempts = [
    { USDC: convertFunding() },
    { USDC: { from: 'Convert' } },
    { USDC: { from: 'CONVERT', amountIn: 1n } },
    { USDC: { from: 'balance' }, EURC: convertFunding() },
    { USDC: { from: 'bitcoin', pledge: 1n, marketParams: usdc.params, plan: '0x00' } },
    { USDC: { from: 'balance', loan: 'EURC' } },
    { USDC: { from: 'balance', amountIn: 5n } },
  ];
  for (const plan of attempts) builderRefuses(() => build.buildSafeBatch(safe, [safeBill], plan), /not available from a Safe/);
  assert.equal(build.buildSafeBatch(safe, [safeBill], { USDC: { from: 'balance' } }).inner.length, 2, 'an ordinary Safe payment still builds');
});

// ---- the adapter rule in assertCalls ----

test('C65: trailing bytes on the plan inside the batch are refused', () => {
  refuses(replaceAt(calls, AT.execute, call3(C.CIRCLE_SWAP_ADAPTER, `${calls[AT.execute].callData}00`)), /extra or reshaped bytes/, conv);
});

test('C65: another selector at the adapter is refused', () => {
  refuses(replaceAt(calls, AT.execute, call3(C.CIRCLE_SWAP_ADAPTER, `0x095ea7b3${calls[AT.execute].callData.slice(10)}`)), /other than execute/, conv);
  refuses(replaceAt(calls, AT.execute, call3(C.CIRCLE_SWAP_ADAPTER, '0x')), /other than execute/, conv);
});

test('C65: the plan sent to another target is refused, with or without a conversion', () => {
  const elsewhere = replaceAt(calls, AT.execute, call3(ATTACKER, calls[AT.execute].callData));
  refuses(elsewhere, /no swap call/, conv);
  refuses(elsewhere, /Refusing (a batch that calls|an approval to) 0x7FB8c7260b63934d8da38aF902f87ae6e284a845/);
});

test('C65: the same plan twice, or a second plan, is refused', () => {
  const twice = [...calls.slice(0, AT.floor + 1), ...calls.slice(AT.approveAdapter, AT.floor + 1), ...calls.slice(AT.floor + 1)];
  refuses(twice, /2 swap calls/, conv);
  const again = [...calls.slice(0, AT.floor + 1), approveCall(C.EURC, C.CIRCLE_SWAP_ADAPTER, conv.amountIn), call3(C.CIRCLE_SWAP_ADAPTER, convertFunding({ amountIn: conv.amountIn }).plan), ...calls.slice(AT.floor + 1)];
  refuses(again, /2 swap calls/, conv);
  refuses(without(calls, AT.execute), /no swap call/, conv);
});

test('C65: a plan that is not the one this batch was built for is refused', () => {
  const other = convertFunding({ amountIn: conv.amountIn });
  refuses(replaceAt(calls, AT.execute, call3(C.CIRCLE_SWAP_ADAPTER, other.plan)), /not the one this batch was built for/, conv);
});

test('C67: an approval to the adapter for cirBTC, or for any token but the one sold, is refused', () => {
  refuses([...calls.slice(0, AT.reset), approveCall(C.CIRBTC, C.CIRCLE_SWAP_ADAPTER, 1n), calls[AT.reset]], /any currency but the one being converted/, conv);
  refuses([...calls.slice(0, AT.reset), approveCall(C.USDC, C.CIRCLE_SWAP_ADAPTER, 0n), calls[AT.reset]], /any currency but the one being converted/, conv);
  refuses(replaceAt(calls, AT.approveAdapter, approveCall(C.CIRBTC, C.CIRCLE_SWAP_ADAPTER, conv.amountIn)), /exactly the amount being converted/, conv);
});

test('C67: an approval to the adapter for more than X, or not set right before the swap, is refused', () => {
  refuses(replaceAt(calls, AT.approveAdapter, approveCall(C.EURC, C.CIRCLE_SWAP_ADAPTER, conv.amountIn + 1n)), /exactly the amount being converted/, conv);
  refuses(replaceAt(calls, AT.approveAdapter, approveCall(C.EURC, C.CIRCLE_SWAP_ADAPTER, conv.amountIn - 1n)), /exactly the amount being converted/, conv);
  refuses([...calls.slice(0, AT.reset), approveCall(C.EURC, C.CIRCLE_SWAP_ADAPTER, conv.amountIn), calls[AT.reset]], /more than the amount being converted, or one not set right before/, conv);
  refuses(replaceAt(calls, AT.approveAdapter, approveCall(C.EURC, C.MORPHO, conv.amountIn)), /exactly the amount being converted/, conv);
});

test('C67: an approval left nonzero at the end, or never reset, or reset too early, is refused', () => {
  refuses(replaceAt(calls, AT.reset, approveCall(C.EURC, C.CIRCLE_SWAP_ADAPTER, 1n)), /more than the amount being converted, or one not set right before/, conv);
  refuses(without(calls, AT.reset), /leaves the swap adapter with an approval at the end/, conv);
  refuses([calls[AT.reset], ...without(calls, AT.reset)], /before the swap/, conv);
  refuses(replaceAt(calls, AT.reset, approveCall(C.EURC, C.MORPHO, 0n)), /leaves the swap adapter with an approval at the end/, conv);
});

test('C68: a floor transfer to anyone but the payer is refused', () => {
  refuses(replaceAt(calls, AT.floor, transferCall(C.USDC, ATTACKER, conv.floor)), /exact floor back to the payer/, conv);
  refuses(replaceAt(calls, AT.floor, transferCall(C.USDC, PAYER, conv.floor - 1n)), /exact floor back to the payer/, conv);
  refuses(replaceAt(calls, AT.floor, transferCall(C.USDC, PAYER, 1n)), /exact floor back to the payer/, conv);
});

test('C68: the floor is on the plan’s output token, right after the swap, and there is one', () => {
  refuses(replaceAt(calls, AT.floor, transferCall(C.EURC, PAYER, conv.floor)), /balance check on the currency it buys/, conv);
  refuses(without(calls, AT.floor), /balance check on the currency it buys/, conv);
  refuses(moveBefore(calls, AT.floor, AT.pay), /balance check on the currency it buys|not preceded/, conv);
  refuses(moveBefore(calls, AT.floor, AT.supply), /not followed by the balance check|not preceded/, conv);
});

test('C68: a balance check that is not the starting balance plus what the plan funds, less the gas slack, is refused', () => {
  const lowered = { ...conv, floor: conv.floor - 1_000_000n };
  refuses(replaceAt(calls, AT.floor, transferCall(C.USDC, PAYER, lowered.floor)), /not the balance it started from plus what it funds/, lowered);
  refuses(replaceAt(calls, AT.floor, transferCall(C.USDC, PAYER, 1n)), /not the balance it started from plus what it funds/, { ...conv, floor: 1n });
  refuses(calls, /not the balance it started from plus what it funds/, { ...conv, floor: 0n });
  refuses(calls, /not the balance it started from plus what it funds/, { ...conv, outputBalance: conv.outputBalance + 1n });
  refuses(calls, /not the balance it started from plus what it funds/, { ...conv, maxFeePerGas: conv.maxFeePerGas * 2n });
});

test('C65, C67: a payment before the swap is refused', () => {
  refuses(moveBefore(calls, AT.pay, 0), /payment that comes before the swap/, conv);
  refuses(moveBefore(calls, AT.pay, AT.borrow), /payment that comes before the swap/, conv);
});

test('C65: bills are paid through Memo, for the bills this batch was built for, each once', () => {
  const memoPay = (id, contract = C.ADAG_BILLS) => build.buildPayFromBalance(bill({ id, contract }), PAYER).calls[1];
  refuses([...calls.slice(0, AT.reset), call3(C.ADAG_BILLS, calls[AT.pay].callData), calls[AT.reset]], /direct call to AdagBills/, conv);
  refuses([...calls.slice(0, AT.pay), memoPay(8n), ...calls.slice(AT.pay + 1)], /not built for/, conv);
  refuses([...calls.slice(0, AT.reset), calls[AT.pay], calls[AT.reset]], /not built for, or one paid twice/, conv);
  refuses(without(calls, AT.pay), /leaves a bill unpaid/, conv);
  refuses([...calls.slice(0, AT.pay), memoPay(7n, C.ADAG_BILLS_FIRST), ...calls.slice(AT.pay + 1)], /not built for/, conv);
  refuses(replaceAt(calls, AT.pay, call3(C.MEMO, build.buildPayFromBalance(bill(), PAYER).calls[0].callData)), /not a bill payment/, conv);
});

test('C65: no token call in a conversion batch but approvals and the balance check', () => {
  for (const extra of [transferCall(C.USDC, ATTACKER, 1n), transferCall(C.EURC, ATTACKER, 1n), transferCall(C.CIRBTC, ATTACKER, 1n), call3(C.USDC, '0x23b872dd')]) {
    refuses([...calls.slice(0, AT.reset), extra, calls[AT.reset]], /token call in a conversion batch/, conv);
  }
  refuses([...calls.slice(0, AT.reset), call3(C.MULTICALL3_FROM, b.data.replace(/^0x[0-9a-f]{8}/, '0x82ad56cb')), calls[AT.reset]], /batch inside a conversion batch/, conv);
});

test('C66, C69: every Morpho call is on Adag’s two markets, for the payer, and the swap is funded by a borrow of exactly X', () => {
  const borrowData = morpho(calls[AT.borrow]).args;
  const morphoBorrow = (over) => {
    const a = { params: borrowData[0], assets: borrowData[1], shares: 0n, onBehalf: PAYER, receiver: PAYER, ...over };
    return call3(C.MORPHO, encode(A.morphoAbi, 'borrow', [a.params, a.assets, a.shares, a.onBehalf, a.receiver]));
  };
  refuses(replaceAt(calls, AT.borrow, morphoBorrow({ receiver: ATTACKER })), /sends money to anyone but the payer/, conv);
  refuses(replaceAt(calls, AT.borrow, morphoBorrow({ onBehalf: ATTACKER })), /made for anyone but the payer/, conv);
  refuses(replaceAt(calls, AT.borrow, morphoBorrow({ assets: conv.amountIn - 1n })), /not funded by a borrow of exactly/, conv);
  refuses(replaceAt(calls, AT.borrow, morphoBorrow({ params: usdc.params })), /not funded by a borrow of exactly/, conv);
  refuses(replaceAt(calls, AT.borrow, morphoBorrow({ params: { ...eurc.params, lltv: 1n } })), /not one of Adag's two/, conv);
  refuses(replaceAt(calls, AT.borrow, call3(C.MORPHO, encode(A.morphoAbi, 'setAuthorization', [ATTACKER, true]))), /Morpho call this app does not make/, conv);
  refuses(without(calls, AT.borrow), /not funded by a borrow of exactly/, conv);
});

test('without its conversion, no batch may reach the adapter or approve it', () => {
  refuses(calls, /Refusing (a batch that calls|an approval to) 0x7FB8c7260b63934d8da38aF902f87ae6e284a845/);
  refuses([calls[AT.approveAdapter]], /Refusing an approval to/);
  refuses([approveCall(C.USDC, C.CIRCLE_SWAP_ADAPTER, 0n)], /Refusing an approval to/);
  refuses([call3(C.CIRCLE_SWAP_ADAPTER, '0x')], /Refusing a batch that calls/);
});

test('a conversion that does not describe this batch is refused', () => {
  refuses(calls, /exactly the amount being converted|different amount/, { ...conv, amountIn: conv.amountIn + 1n });
  refuses(calls, /not your wallet|built for another/, { ...conv, payer: ATTACKER });
  refuses(calls, /not the one this batch was built for/, { ...conv, execId: conv.execId + 1n });
  refuses(calls, /fixed gas ceiling/, { ...conv, gas: conv.gas + 1n });
  refuses(calls, /does not guarantee at least|not the balance it started from/, { ...conv, minOut: conv.minOut + 100_000n });
  refuses(calls, /bill this batch was not built for|leaves a bill unpaid/, { ...conv, bills: [...conv.bills, { ...conv.bills[0], id: 99n }] });
  refuses(calls, /not built for/, { ...conv, bills: [] });
});

test('a step that may fail on its own is still refused in a conversion batch', () => {
  refuses(replaceAt(calls, AT.approveBill, { ...calls[AT.approveBill], allowFailure: true }), /may fail on its own/, conv);
});

// ---- the sender's re-check ----

test('the sender reads the batch back from its bytes and holds it to the same rules', () => {
  assert.deepEqual(build.decodeBatch(b.data)?.map((c) => c.target), calls.map((c) => c.target));
  assert.equal(build.decodeBatch(`${b.data}00`), null, 'a byte more is not the same batch');
  assert.equal(build.decodeBatch('0x095ea7b3'), null);
  assert.equal(build.decodeBatch('not hex'), null);
  build.assertConversionBatch(b.to, b.data, conv, PAYER);
  assert.throws(() => build.assertConversionBatch(C.MORPHO, b.data, conv, PAYER), /not sent through Multicall3From/);
  assert.throws(() => build.assertConversionBatch(b.to, b.data, conv, ATTACKER), /another wallet/);
  assert.throws(() => build.assertConversionBatch(b.to, `${b.data}00`, conv, PAYER), /not a plain batch/);
  const swapped = build.buildPayFromBalance(bill(), PAYER);
  assert.throws(() => build.assertConversionBatch(swapped.to, swapped.data, conv, PAYER), /no swap call/);
});

test('anything that would reach the adapter is spotted from its bytes, whoever builds it', () => {
  assert.equal(build.reachesSwapAdapter(b.to, b.data), true);
  assert.equal(build.reachesSwapAdapter(C.CIRCLE_SWAP_ADAPTER, '0x'), true);
  const reset = build.buildAdapterReset(PAYER, { tokens: [C.USDC], deauthorize: false });
  assert.equal(build.reachesSwapAdapter(reset.to, reset.data), true, 'an approval to the adapter counts');
  const ordinary = build.buildPayFromBalance(bill(), PAYER);
  assert.equal(build.reachesSwapAdapter(ordinary.to, ordinary.data), false);
  assert.equal(build.reachesSwapAdapter(C.ADAG_BILLS, '0x'), false);
});

test('C65, C67: a call or approval to the adapter hidden inside Memo or a batch within the batch is spotted and refused', () => {
  const memoOf = (target, data) => call3(C.MEMO, encode(A.memoAbi, 'memo', [target, data, `0x${'00'.repeat(31)}01`, '0x']));
  const wrapped = {
    'a Memo call into the adapter': memoOf(C.CIRCLE_SWAP_ADAPTER, calls[AT.execute].callData),
    'a Memo call that approves the adapter': memoOf(C.EURC, calls[AT.approveAdapter].callData),
    'a batch inside the batch that calls the adapter': call3(C.MULTICALL3_FROM, encode(A.multicall3FromAbi, 'aggregate3', [[calls[AT.execute]]])),
    'a batch inside a batch inside a Memo': memoOf(C.MULTICALL3_FROM, encode(A.multicall3FromAbi, 'aggregate3', [[calls[AT.approveAdapter]]])),
    'a Memo that cannot be read': call3(C.MEMO, '0x12345678'),
    'a nested batch that cannot be read': call3(C.MULTICALL3_FROM, '0x12345678'),
  };
  for (const [name, hidden] of Object.entries(wrapped)) {
    const data = encode(A.multicall3FromAbi, 'aggregate3', [[hidden]]);
    assert.equal(build.reachesSwapAdapter(C.MULTICALL3_FROM, data), true, name);
    refuses([hidden], /through another call/);
  }
  const ordinaryMemo = build.buildPayFromBalance(bill(), PAYER).calls[1];
  assert.equal(build.reachesSwapAdapter(C.MULTICALL3_FROM, encode(A.multicall3FromAbi, 'aggregate3', [[ordinaryMemo]])), false);
  build.assertCalls([ordinaryMemo], null, null, { payer: PAYER, bills: [bill()], sender: 'wallet' });
});

// ---- closing a loan with the other currency (C75) ----

const close = builtClose();
const CLOSE_AT = { approveIn: 0, execute: 1, floor: 2, approveMorpho: 3, repay: 4, withdraw: 5, resetMorpho: 6, resetAdapter: 7 };

test('C75: a EURC loan is closed with USDC in the order FX-1 proved: sell, check, repay by shares, collateral last, adapter back to 0', () => {
  const c = close.calls;
  assert.equal(c.length, 8);
  assert.deepEqual(c.map((x) => x.target), [C.USDC, C.CIRCLE_SWAP_ADAPTER, C.EURC, C.EURC, C.MORPHO, C.MORPHO, C.EURC, C.USDC]);
  assert.deepEqual(erc20(c[CLOSE_AT.approveIn]).args, [C.CIRCLE_SWAP_ADAPTER, close.conversion.amountIn]);
  assert.deepEqual(erc20(c[CLOSE_AT.approveMorpho]).args, [C.MORPHO, 100_100_003n]);
  const repay = morpho(c[CLOSE_AT.repay]).args;
  assert.equal(morpho(c[CLOSE_AT.repay]).functionName, 'repay');
  assert.equal(repay[1], 0n, 'by shares, never by assets');
  assert.equal(repay[2], POSITION.shares);
  assert.equal(morpho(c[CLOSE_AT.withdraw]).functionName, 'withdrawCollateral');
  assert.ok(CLOSE_AT.withdraw > CLOSE_AT.repay, 'collateral leaves only after the full repay');
  assert.deepEqual(erc20(c[CLOSE_AT.resetAdapter]).args, [C.CIRCLE_SWAP_ADAPTER, 0n]);
  build.assertCalls(c, null, close.conversion);
});

test('C75: the plan must return at least the close approval, and the figures are held to it', () => {
  const k = close.conversion;
  assert.equal(k.minOut, 100_100_003n);
  assert.equal(k.tokenIn, C.USDC);
  assert.equal(k.tokenOut, C.EURC);
  assert.equal(k.floor, 100_100_003n, 'EURC output: nothing off the floor');
  assert.equal(k.borrow, null);
  assert.deepEqual(k.repay, { token: C.EURC, max: 100_100_003n });
  assert.equal(k.pledge, 0n);
  assert.deepEqual(k.bills, []);
  const lowPlan = encodeExecute(planParams({ tokenIn: C.USDC, tokenOut: C.EURC, amountIn: k.amountIn, minOut: 100_100_003n - 6_260n - 1n }), C.USDC, k.amountIn, SIGNATURE);
  builderRefuses(() => build.buildCloseWithOtherCurrency(PAYER, eurc, POSITION, 100_100_003n, eurc.params, closeFunding({ plan: lowPlan })), /does not guarantee at least/);
});

test('C75: Y may not exceed the close approval at the euro price plus 1.5%', () => {
  const ceiling = maxAmountToSell(100_100_003n, 'EURC', RATE);
  build.buildCloseWithOtherCurrency(PAYER, eurc, POSITION, 100_100_003n, eurc.params, closeFunding({ amountIn: ceiling }));
  builderRefuses(() => build.buildCloseWithOtherCurrency(PAYER, eurc, POSITION, 100_100_003n, eurc.params, closeFunding({ amountIn: ceiling + 1n })), /more than the close approval is worth/);
  builderRefuses(() => build.buildCloseWithOtherCurrency(PAYER, eurc, POSITION, 100_100_003n, eurc.params, closeFunding({ rate: { ...RATE, updatedAt: CHAIN_TIME - 96n * 3600n - 1n } })), /96 hours/);
});

test('C75: closing a USDC loan with EURC takes the gas slack off a USDC floor, and market params are proven by hash', () => {
  const approval = 50_000_000n;
  const y = amountToSell(approval, 'USDC', RATE, 40n);
  const plan = encodeExecute(planParams({ tokenIn: C.EURC, tokenOut: C.USDC, amountIn: y, minOut: approval }), C.EURC, y, SIGNATURE);
  const funding = { amountIn: y, plan, outputBalance: 7_000_000n, maxFeePerGas: MAX_FEE, chainTime: CHAIN_TIME, rate: RATE };
  const out = build.buildCloseWithOtherCurrency(PAYER, usdc, POSITION, approval, usdc.params, funding);
  assert.equal(out.conversion.floor, 7_000_000n + approval - floorSlack(MAX_FEE));
  assert.equal(out.conversion.tokenIn, C.EURC);
  build.assertCalls(out.calls, null, out.conversion);
  builderRefuses(() => build.buildCloseWithOtherCurrency(PAYER, usdc, POSITION, approval, eurc.params, funding), /hash to|differ from/);
});

test('C75, C60: a close with a guard rule stops the guard in the same batch, and the adapter is still the last approval to 0', () => {
  const out = builtClose(undefined, { hasRule: true, allowance: 535_652n });
  const c = out.calls;
  assert.equal(out.conversion.guardMarket, C.MARKET_EURC);
  assert.equal(c.length, 10);
  assert.equal(c.at(-1).target, C.USDC);
  assert.deepEqual(erc20(c.at(-1)).args, [C.CIRCLE_SWAP_ADAPTER, 0n]);
  build.assertConversionBatch(out.to, out.data, out.conversion, PAYER);
});

test('C75: a close needs a loan to repay', () => {
  builderRefuses(() => build.buildCloseWithOtherCurrency(PAYER, eurc, { shares: 0n, collateral: 5n }, 100n, eurc.params, closeFunding()), /no loan in this market/);
  builderRefuses(() => build.buildCloseWithOtherCurrency(PAYER, eurc, POSITION, 0n, eurc.params, closeFunding()), /more than zero/);
});

test('C75: the close batch is held to the same adapter rules as a payment', () => {
  const c = close.calls;
  const k = close.conversion;
  refuses(without(c, CLOSE_AT.resetAdapter), /leaves the swap adapter with an approval at the end/, k);
  refuses(replaceAt(c, CLOSE_AT.floor, transferCall(C.EURC, ATTACKER, k.floor)), /exact floor back to the payer/, k);
  refuses([...c, call3(C.CIRCLE_SWAP_ADAPTER, c[CLOSE_AT.execute].callData)], /2 swap calls/, k);
  refuses(replaceAt(c, CLOSE_AT.approveIn, approveCall(C.USDC, C.CIRCLE_SWAP_ADAPTER, k.amountIn + 1n)), /exactly the amount being converted/, k);
});
