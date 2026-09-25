// Tries to break the live AdagBills on Arc mainnet and shows every attempt failing. Every attack runs inside
// eth_simulateV1 on dRPC, starting from one real mainnet block, against the deployed contract and the demo
// wallet's real loan. Nothing is signed or sent, and no key is read.
//
//   node packages/contracts/prove-it/attack.mjs
//
// State overrides are used for three things only: giving a simulated stranger some native USDC, the payee
// writing fresh bills in an earlier simulated block, and in A9 alone a mock oracle labelled as a simulated
// price drop. Adag and Morpho state are never overridden.
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256, stringToHex } from 'viem';
import * as L from './lib.mjs';

const BILL = 100_000n;
const STATUS = ['None', 'Open', 'Paid', 'Void'];
const WETH = '0x128cC466B61f542da60c70e3aA11c10e19B84EDB';
const STRANGER = getAddress(`0x${keccak256(stringToHex('adag attack stranger')).slice(-40)}`);
const RANDOM_TOKEN = getAddress(`0x${keccak256(stringToHex('adag attack random token')).slice(-40)}`);
const STRANGER_FUNDS = L.nativeBalance(STRANGER, 100n * 10n ** 18n);

const env = L.readEnv(['DEPLOYER_ADDRESS', 'PAYEE_ADDRESS']);
const demo = L.checkedAddress(env.DEPLOYER_ADDRESS, 'DEPLOYER_ADDRESS');
const payee = L.checkedAddress(env.PAYEE_ADDRESS, 'PAYEE_ADDRESS');
const adag = L.loadDeployment();
if (!adag) throw new Error('packages/contracts/deployments/arc-mainnet.json is missing: there is no live Adag to attack.');
const adagAbi = L.loadAdagAbi().abi;
L.setAdagAbi(adagAbi);

const ctx = {};
const rows = [];
const t = (k) => ctx.pin.timestamp + BigInt(k);
const tx = (from, c) => ({ from, to: c.to, data: c.data });
const adagCall = (fn, args = []) => ({ to: adag, data: L.enc(adagAbi, fn, args) });
const sim = (blocks) => L.simulate(blocks, ctx.pin.number, null);
const outcome = (r) => (r.ok ? 'success' : L.decodeRevert(r.revertData));
const tidy = (s) => s.split(L.MARKET_USDC).join('MARKET_USDC').replace(/BillNotOpen\((\d+), (\d)\)/g, (_, id, st) => `BillNotOpen(${id}, ${STATUS[st]})`);
const statusOf = (r) => STATUS[L.decodeRead({ abi: adagAbi, fn: 'bill' }, r.returnData).status];
const billRead = (id) => tx(demo, adagCall('bill', [id]));
const payViaMemo = (id) => L.calls.memo(adagCall('pay', [id]), id, `ATTACK-${id}`);
const cashPay = (id) => [L.calls.approve(L.USDC, adag, BILL), payViaMemo(id)];
const borrowShares = (shares) => ({ to: L.MORPHO, data: L.enc(L.morphoAbi, 'borrow', [ctx.params, 0n, shares, demo, demo]) });
const newBills = (n) => ({
  time: t(1),
  calls: Array.from({ length: n }, (_, i) => tx(payee, adagCall('createBill', [L.USDC, BILL, t(1) + 86_400n, stringToHex(`ATTACK-BILL-${i + 1}`)]))),
});
const firstNewId = () => ctx.count + 1n;
const pct = (wad) => L.pct(wad);

function row(id, attack, stopper, actual, pass) {
  rows.push({ id, attack, stopper, actual: tidy(actual), pass });
}

function billsWritten(blockResult) {
  const bad = blockResult.find((r) => !r.ok);
  if (bad) throw new Error(`setup createBill failed: ${outcome(bad)}`);
}

async function baseline() {
  const chain = await L.simChainId();
  if (chain !== L.CHAIN_ID) throw new Error(`${L.SIM_RPC} reports chain ${chain}, not Arc mainnet ${L.CHAIN_ID}.`);
  ctx.pin = await L.simHead();
  const p = (await readBlock([L.read('p', L.MORPHO, L.morphoAbi, 'idToMarketParams', [L.MARKET_USDC])])).p;
  ctx.params = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
  L.verifyMarketParams(ctx.params, L.MARKET_USDC);
  L.assertUsdcMarketConstants(ctx.params);
  const r = await readBlock([
    L.read('pos', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, demo]),
    L.read('market', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
    L.read('price', ctx.params.oracle, L.oracleAbi, 'price'),
    L.read('baseFeed', ctx.params.oracle, L.oracleAbi, 'BASE_FEED_1'),
    L.read('quoteFeed', ctx.params.oracle, L.oracleAbi, 'QUOTE_FEED_1'),
    L.read('seen', adag, adagAbi, 'seenPosition', [demo, L.MARKET_USDC]),
    L.read('bill1', adag, adagAbi, 'bill', [1n]),
    L.read('count', adag, adagAbi, 'billCount'),
    L.read('ltv', adag, adagAbi, 'loanToValue', [demo, L.MARKET_USDC]),
    L.read('status', adag, adagAbi, 'priceStatus', [L.MARKET_USDC]),
    L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [demo]),
    L.read('btc', L.CIRBTC, L.erc20Abi, 'balanceOf', [demo]),
    L.read('allow', L.USDC, L.erc20Abi, 'allowance', [demo, adag]),
  ]);
  Object.assign(ctx, r);
  ctx.shares = r.pos[1];
  ctx.collateral = r.pos[2];
  ctx.debt = L.toAssetsUp(ctx.shares, r.market[2], r.market[3]);
  ctx.value = (ctx.collateral * r.price) / 10n ** 36n;

  const problems = [];
  if (ctx.shares === 0n) problems.push('the demo wallet has no open USDC-market loan');
  if (r.seen[0] !== ctx.shares || r.seen[1] !== ctx.collateral) problems.push('the demo loan has moved since Adag last recorded it');
  if (r.bill1.status !== 2) problems.push('bill #1 is not Paid');
  if (!r.status[0]) problems.push('the BTC/USD price is stale, so every loan check would stop at StalePrice first');
  if (r.allow !== 0n) problems.push('the demo wallet still has a USDC allowance to Adag');
  if (r.usdc < 2_000000n) problems.push('the demo wallet holds under 2 USDC, too little to repay and re-borrow in A2');
  if (problems.length) throw new Error(`The live state is not the one these attacks were written for: ${problems.join('; ')}.`);
}

async function readBlock(specs, overrides) {
  const res = await L.simulate([{ time: t(1), overrides, calls: specs.map((s) => ({ from: demo, to: s.to, data: s.data })) }], ctx.pin.number, null);
  const out = {};
  specs.forEach((s, i) => {
    const r = res[0][i];
    if (!r.ok) throw new Error(`baseline read ${s.fn} failed: ${outcome(r)}`);
    out[s.key] = L.decodeRead(s, r.returnData);
  });
  return out;
}

async function A1() {
  const res = await sim([{ time: t(1), overrides: STRANGER_FUNDS, calls: [
    tx(STRANGER, L.calls.approve(L.USDC, adag, 1_000000n)),
    tx(STRANGER, adagCall('pay', [1n])),
  ] }]);
  const r = res[0][1];
  row('A1', 'A funded stranger pays bill #1 a second time', 'pay-once: status must be Open',
    outcome(r), res[0][0].ok && !r.ok && outcome(r) === 'BillNotOpen(1, 2)');
}

// Repay the whole loan outside Adag, pledge less, re-borrow the exact share count Adag remembers, then pay.
// Share count alone would look unchanged; the drop in collateral is what the check catches.
async function A2() {
  const id = firstNewId();
  const repayApproval = ctx.debt + ctx.debt / 1000n + 1n;
  const run = async (repledge) => {
    const res = await sim([newBills(1), { time: t(2), calls: [
      tx(demo, L.calls.batch([
        L.calls.approve(L.USDC, L.MORPHO, repayApproval),
        L.calls.repayShares(ctx.params, ctx.shares, demo),
        L.calls.withdrawCollateral(ctx.params, ctx.collateral, demo, demo),
        L.calls.approve(L.CIRBTC, L.MORPHO, repledge),
        L.calls.supplyCollateral(ctx.params, repledge, demo),
        borrowShares(ctx.shares),
        ...cashPay(id),
      ])),
      billRead(id),
    ] }]);
    billsWritten(res[0]);
    return { r: res[1][0], status: statusOf(res[1][1]) };
  };

  const quarter = ctx.collateral / 4n;
  const a = await run(quarter);
  row('A2a', `Close and re-borrow ${ctx.shares} shares against a quarter of the pledge (${L.btc(quarter)}, about ${pct((ctx.ltv * 4n))})`,
    'refused before Adag: Morpho\'s own 86% line', `${outcome(a.r)}; bill ${a.status}`,
    !a.r.ok && /insufficient collateral|LtvAboveLimit/.test(outcome(a.r)) && a.status === 'Open');

  // Enough collateral that Morpho allows the loan (about 60%), so only Adag's 40% line stands in the way.
  const sixty = (ctx.debt * 10n ** 36n * 10n + ctx.price * 6n - 1n) / (ctx.price * 6n);
  const b = await run(sixty);
  row('A2b', `Close and re-borrow the same ${ctx.shares} shares against ${L.btc(sixty)} (about 60%, which Morpho allows)`,
    'Adag: collateral fell since last seen, so the 40% check runs', `${outcome(b.r)}; bill ${b.status}`,
    !b.r.ok && outcome(b.r).startsWith('MemoFailed(LtvAboveLimit(') && b.status === 'Open');
}

async function A3() {
  const id = firstNewId();
  const extra = ctx.value / 2n - ctx.debt;
  const res = await sim([newBills(1), { time: t(2), calls: [
    tx(demo, L.calls.batch([L.calls.borrow(ctx.params, extra, demo, demo), ...cashPay(id)])),
    billRead(id),
  ] }]);
  billsWritten(res[0]);
  const r = res[1][0];
  const status = statusOf(res[1][1]);
  row('A3', `Borrow ${L.usdc(extra)} more (to about 50%) and pay a new bill in the same batch`,
    'Adag: shares grew, 40% check', `${outcome(r)}; bill ${status}`,
    !r.ok && outcome(r).startsWith('MemoFailed(LtvAboveLimit(') && status === 'Open');
}

// The named residual: debt taken AFTER the Adag step in the same batch is not seen by that payment. It is
// seen by the next one, which is refused until the loan is back under 40%.
async function A4() {
  const idA = firstNewId();
  const idB = idA + 1n;
  const extra = (ctx.value * 6n) / 10n - ctx.debt;
  const res = await sim([
    newBills(2),
    { time: t(2), calls: [
      tx(demo, L.calls.batch([...cashPay(idA), L.calls.borrow(ctx.params, extra, demo, demo)])),
      tx(demo, adagCall('loanToValue', [demo, L.MARKET_USDC])),
    ] },
    { time: t(3), calls: [tx(demo, L.calls.batch(cashPay(idB))), billRead(idB)] },
  ]);
  billsWritten(res[0]);
  const first = res[1][0];
  const paid = first.ok ? L.findEvent(first.logs, adag, adagAbi, 'BillPaid') : null;
  const ltvAfter = res[1][1].ok ? L.decodeRead({ abi: adagAbi, fn: 'loanToValue' }, res[1][1].returnData) : null;
  const second = res[2][0];
  const statusB = statusOf(res[2][1]);
  const firstOk = first.ok && paid?.loanChecked === false;
  const secondOk = !second.ok && outcome(second).startsWith('MemoFailed(LtvAboveLimit(') && statusB === 'Open';
  row('A4', `Named residual: pay a bill from cash, then borrow ${L.usdc(extra)} (to about 60%) after the Adag step; next block, pay another bill from cash`,
    'first half allowed (documented residual); next payment refused by the 40% check',
    `first: ${first.ok ? `success, loanChecked ${paid?.loanChecked}, loan-to-value then ${ltvAfter === null ? '?' : pct(ltvAfter)}` : outcome(first)}; next: ${outcome(second)}; bill ${statusB}`,
    firstOk && secondOk);
}

async function A5() {
  const id = firstNewId();
  const res = await sim([newBills(1), { time: t(2), calls: [tx(payee, adagCall('pay', [id]))] }]);
  billsWritten(res[0]);
  const r = res[1][0];
  row('A5', 'The payee pays its own bill', 'Adag: payer must not be the payee', outcome(r), !r.ok && outcome(r) === 'SelfPayment()');
}

async function A6() {
  const due = t(1) + 86_400n;
  const cases = [
    ['cirBTC as the currency', [L.CIRBTC, BILL, due, '0x'], `UnsupportedCurrency(${L.CIRBTC})`],
    ['WETH as the currency', [WETH, BILL, due, '0x'], `UnsupportedCurrency(${WETH})`],
    ['a random address as the currency', [RANDOM_TOKEN, BILL, due, '0x'], `UnsupportedCurrency(${RANDOM_TOKEN})`],
    ['zero amount', [L.USDC, 0n, due, '0x'], 'ZeroAmount()'],
    ['141-byte reference', [L.USDC, BILL, due, stringToHex('x'.repeat(141))], 'ReferenceTooLong(141)'],
  ];
  const res = await sim([{ time: t(1), overrides: STRANGER_FUNDS, calls: cases.map(([, args]) => tx(STRANGER, adagCall('createBill', args))) }]);
  cases.forEach(([label, , want], i) => {
    const r = res[0][i];
    row(`A6.${i + 1}`, `Stranger writes a bill with ${label}`, 'Adag: USDC or EURC only, amount above 0, reference at most 140 bytes',
      outcome(r), !r.ok && outcome(r) === want);
  });
}

async function A7() {
  const id = firstNewId();
  const res = await sim([newBills(1), { time: t(2), overrides: STRANGER_FUNDS, calls: [
    tx(STRANGER, adagCall('voidBill', [id])),
    tx(payee, adagCall('voidBill', [1n])),
    billRead(id),
  ] }]);
  billsWritten(res[0]);
  const [stranger, paidVoid, read] = res[1];
  row('A7a', 'A stranger voids the payee\'s open bill', 'Adag: only the payee may void',
    `${outcome(stranger)}; bill ${statusOf(read)}`, !stranger.ok && outcome(stranger) === `NotPayee(${STRANGER})` && statusOf(read) === 'Open');
  row('A7b', 'The payee voids bill #1 after it was paid', 'Adag: only an Open bill can be voided',
    outcome(paidVoid), !paidVoid.ok && outcome(paidVoid) === 'BillNotOpen(1, 2)');
}

async function A8() {
  const id = firstNewId();
  const res = await sim([newBills(1), { time: t(2), calls: [tx(demo, L.calls.batch([payViaMemo(id)])), billRead(id)] }]);
  billsWritten(res[0]);
  const r = res[1][0];
  const status = statusOf(res[1][1]);
  row('A8', 'The demo wallet pays through Memo without approving Adag', 'the USDC transfer fails, the whole batch reverts',
    `${outcome(r)}; bill ${status}`, !r.ok && status === 'Open');
}

// Not an attack: the rule's promise when the price falls. SIMULATED PRICE DROP: the R&D MockOracle replaces the
// USDC market's oracle with a price 25% lower, from the second simulated block on. Morpho and Adag both see it.
async function A9() {
  const id = firstNewId();
  const drop = (ctx.price * 75n) / 100n;
  const mock = { [ctx.params.oracle]: { code: L.mockOracleCode(drop, ctx.baseFeed, ctx.quoteFeed) } };
  const cash = await sim([newBills(1), { time: t(2), overrides: mock, calls: [
    tx(demo, adagCall('loanToValue', [demo, L.MARKET_USDC])),
    tx(demo, L.calls.batch(cashPay(id))),
  ] }]);
  billsWritten(cash[0]);
  const ltv = L.decodeRead({ abi: adagAbi, fn: 'loanToValue' }, cash[1][0].returnData);
  const c = cash[1][1];
  const paid = c.ok ? L.findEvent(c.logs, adag, adagAbi, 'BillPaid') : null;
  row('A9a', `SIMULATED PRICE DROP (-25%, loan now ${pct(ltv)}): pay a new bill from cash, no new debt`,
    'allowed: no new debt, so no check (a price drop never blocks a cash payment)',
    c.ok ? `success, loanChecked ${paid?.loanChecked}` : outcome(c), c.ok && paid?.loanChecked === false);

  const loan = await sim([newBills(1), { time: t(2), overrides: mock, calls: [
    tx(demo, L.calls.batch([L.calls.borrow(ctx.params, 10_000n, demo, demo), ...cashPay(id)])),
    billRead(id),
  ] }]);
  billsWritten(loan[0]);
  const l = loan[1][0];
  const status = statusOf(loan[1][1]);
  row('A9b', `SIMULATED PRICE DROP (-25%): borrow 0.010000 USDC more and pay the same bill`, 'Adag: new debt, 40% check',
    `${outcome(l)}; bill ${status}`, !l.ok && outcome(l).startsWith('MemoFailed(LtvAboveLimit(') && status === 'Open');
}

// Runs prove-it.mjs itself with fetch replaced by a stub, so its real chain-id guard sees a wrong chain.
// The stub answers only eth_chainId and eth_getCode and refuses every other request: no network is used.
function A10() {
  const proveIt = fileURLToPath(new URL('./prove-it.mjs', import.meta.url));
  const stub = (circleChain, drpcChain) => `
    globalThis.fetch = async (input, init) => {
      const url = String(typeof input === 'string' ? input : input.url);
      const answer = (b) => {
        if (b.method === 'eth_chainId') return { jsonrpc: '2.0', id: b.id, result: url.includes('drpc') ? '${drpcChain}' : '${circleChain}' };
        if (b.method === 'eth_getCode') return { jsonrpc: '2.0', id: b.id, result: '0x6080' };
        throw new Error('A10 stub: no network, refused ' + b.method);
      };
      const body = JSON.parse(init && init.body ? init.body : '{}');
      const out = Array.isArray(body) ? body.map(answer) : answer(body);
      return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
    };`;
  const cases = [
    ['A10a', `${L.WRITE_RPC} reports chain 1`, stub('0x1', '0x13b2'), `${L.WRITE_RPC} reports chain 1, not Arc mainnet 5042`],
    ['A10b', `${L.WRITE_RPC} reports 5042 but ${L.SIM_RPC} reports chain 1`, stub('0x13b2', '0x1'), `${L.SIM_RPC} reports chain 1, not Arc mainnet 5042`],
  ];
  for (const [id, label, code, want] of cases) {
    const p = spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(code)}`, proveIt], { encoding: 'utf8', timeout: 60_000 });
    const stopped = (p.stderr || '').split('\n').find((s) => s.startsWith('STOPPED:')) ?? `exit ${p.status}, no STOPPED line`;
    row(id, `prove-it dry run when ${label} (fetch stubbed, no network)`, 'prove-it: chain id must be 5042 before anything else',
      `exit ${p.status}; ${stopped}`, p.status === 1 && stopped.includes(want) && !(p.stdout || '').includes('Running'));
  }
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
function table() {
  const out = ['| # | Attack | What should stop it | Actual | Result |', '|---|---|---|---|---|'];
  for (const r of rows) out.push(`| ${r.id} | ${cell(r.attack)} | ${cell(r.stopper)} | ${cell(r.actual)} | ${r.pass ? 'PASS' : 'FAIL'} |`);
  return out.join('\n');
}

async function main() {
  await baseline();
  const when = new Date(Number(ctx.pin.timestamp) * 1000).toISOString();
  const state = [
    `Block ${ctx.pin.number} (${when}), dRPC eth_simulateV1, Adag ${adag}.`,
    `Demo wallet ${demo}: loan ${L.usdc(ctx.debt)} (${ctx.shares} shares) against ${L.btc(ctx.collateral)} pledged, loan-to-value ${pct(ctx.ltv)}; wallet ${L.usdc(ctx.usdc)}, ${L.btc(ctx.btc)}. Adag last recorded ${ctx.seen[0]} shares and ${L.btc(ctx.seen[1])}.`,
    `Payee ${payee}. Simulated stranger ${STRANGER}. Bill #1 is ${STATUS[ctx.bill1.status]}; ${ctx.count} bills written so far. BTC price ${L.btcPrice(ctx.price)}.`,
  ];
  console.log(state.join('\n'));

  for (const attack of [A1, A2, A3, A4, A5, A6, A7, A8, A9, A10]) {
    try {
      await attack();
    } catch (e) {
      row(attack.name, 'attack could not run', '', `error: ${e.shortMessage ?? e.message}`, false);
    }
  }

  const allOk = rows.every((r) => r.pass);
  const verdict = allOk
    ? `All ${rows.length} checks behaved as the threat model says: every attack was refused, and the named residual (A4) behaved exactly as documented.`
    : `${rows.filter((r) => !r.pass).length} of ${rows.length} checks did not behave as expected. See the FAIL rows.`;
  const t2 = table();
  console.log(`\n${t2}\n\n${verdict}`);

  const date = when.slice(0, 10);
  const file = new URL(`../deployments/attacks-${date}.md`, import.meta.url);
  if (!existsSync(file)) {
    writeFileSync(file, [
      `# Adag attack runs, ${date}`,
      '',
      'Each run tries to break the live AdagBills on Arc mainnet with `node packages/contracts/prove-it/attack.mjs`.',
      'Every attack is simulated with eth_simulateV1 from a real mainnet block against the deployed contract and',
      'the demo wallet\'s real Morpho loan. Nothing is signed or sent. State overrides only fund a simulated',
      'stranger and let the payee write fresh bills; A9 alone swaps in a mock oracle, labelled as a simulated',
      'price drop.',
      '',
    ].join('\n'));
  }
  appendFileSync(file, `\n## Run at block ${ctx.pin.number}\n\n${state.join('\n\n')}\n\n${t2}\n\n${verdict}\n`);
  console.log(`\nSaved to ${fileURLToPath(file)}`);
  return allOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nSTOPPED: ${e?.shortMessage ?? e?.message ?? String(e)}`);
    process.exit(1);
  },
);
