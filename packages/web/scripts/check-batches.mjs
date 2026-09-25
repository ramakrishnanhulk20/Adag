// Proves the web app's own batch builders (src/lib/pay) against live Arc mainnet state, without signing anything.
// Every transaction runs inside dRPC's eth_simulateV1 from the latest block, the pattern prove-it/lib.mjs uses.
//
//   node packages/web/scripts/check-batches.mjs
//
// Checks (a) to (e) prove paying; (f) to (j) prove writing a bill, adding cirBTC and closing a loan. Exits 0 only if all pass.
import { registerHooks } from 'node:module';
import { decodeEventLog, decodeFunctionData, decodeFunctionResult, encodeFunctionData, getAddress, isAddressEqual, stringToHex, toHex } from 'viem';

// src/lib/pay uses extensionless relative imports so Next.js and tsc can read it; bare Node needs the ".ts" added.
registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) {
        return next(`${specifier}.ts`, context);
      }
      throw error;
    }
  },
});
// The web package has no "type" field, so Node warns once per .ts file that it guessed ESM. The guess is right.
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  emitWarning(warning, ...rest);
};

const pay = (file) => import(new URL(`../src/lib/pay/${file}`, import.meta.url).href);
const { buildPayFromBalance, buildPayFromBitcoin, suggestPledge, buildCreateBill, buildAddCollateral, buildCloseLoan, referenceBytes, BATCH_TARGETS, APPROVAL_SPENDERS } = await pay('build.ts');
const { debtFromShares, closeApproval } = await pay('loan.ts');
const { billCreatedIn, morphoEventsIn } = await pay('receipt.ts');
const { decodeAdagError } = await pay('errors.ts');
const { verifyMarketParams, paramsFromTuple } = await pay('market.ts');
const { adagAbi, erc20Abi, morphoAbi, multicall3FromAbi } = await pay('abi.ts');
const C = await pay('constants.ts');

const PAYER = getAddress('0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE');
const PAYEE = getAddress('0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B');
const SIM_RPC = 'https://rpc.drpc.mainnet.arc.io';
const BILL_AMOUNT = 500_000n;
const LTV_SENTENCE = "This would take your loan past 40% of your bitcoin's value. Pledge more cirBTC or pay less from bitcoin.";

const TIMEOUT_MS = 60_000;
const MAX_RESPONSE_BYTES = 5_000_000;
const SPACING_MS = 1_500;
let lastCallAt = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function rpc(method, params) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastCallAt + SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastCallAt = Date.now();
    const res = await fetch(SIM_RPC, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const text = await res.text();
    if (text.length > MAX_RESPONSE_BYTES) throw new Error(`${method} answer is over ${MAX_RESPONSE_BYTES} bytes.`);
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (res.ok && json && !json.error) return json.result;
    const err = json?.error ?? { message: `HTTP ${res.status}` };
    // dRPC's free tier rate-limits bursts; one pause and retry, as prove-it does.
    if (attempt === 0 && (res.status === 429 || /rate|limit|too many/i.test(err.message ?? ''))) {
      await sleep(5_000);
      continue;
    }
    throw new Error(`dRPC ${method} failed: ${JSON.stringify(err)}`);
  }
}

const read = (to, abi, functionName, args = []) => ({ to, abi, functionName, args, data: encodeFunctionData({ abi, functionName, args }) });
const decode = (spec, data) => decodeFunctionResult({ abi: spec.abi, functionName: spec.functionName, data });

let pin;
const kept = [];
const nextTime = (extra = 0) => pin.timestamp + BigInt(kept.length + 1 + extra);

// Replays every kept transaction from the pinned block, then the new block, so each step sees the state before it.
async function simulate(calls) {
  const blocks = [...kept, { time: nextTime(), calls }].map((b) => ({
    blockOverrides: { time: toHex(b.time) },
    calls: b.calls.map((c) => ({ from: c.from, to: c.to, data: c.data })),
  }));
  const result = await rpc('eth_simulateV1', [{ blockStateCalls: blocks, validation: false, traceTransfers: false }, toHex(pin.number)]);
  if (!Array.isArray(result) || result.length !== blocks.length) throw new Error('eth_simulateV1 returned an unexpected shape.');
  return result.at(-1).calls.map((c) => ({
    ok: c.status === '0x1',
    returnData: c.returnData,
    logs: c.logs ?? [],
    revertData: c.returnData && c.returnData !== '0x' ? c.returnData : c.error?.data,
    gas: BigInt(c.gasUsed),
  }));
}

async function ethCall(spec) {
  return decode(spec, await rpc('eth_call', [{ to: spec.to, data: spec.data }, toHex(pin.number)]));
}

// Reads run as calls from the payer inside the same simulated block, after the transaction they sit behind.
async function send(tx, { before = [], after = [] } = {}) {
  const asCall = (s) => ({ from: PAYER, to: s.to, data: s.data });
  const out = await simulate([...before.map(asCall), tx, ...after.map(asCall)]);
  const main = out[before.length];
  const decodeAll = (specs, results) => specs.map((s, i) => {
    if (!results[i].ok) throw new Error(`Reading ${s.functionName} failed inside the simulation.`);
    return decode(s, results[i].returnData);
  });
  const result = {
    ...main,
    before: main.ok ? decodeAll(before, out.slice(0, before.length)) : [],
    after: main.ok ? decodeAll(after, out.slice(before.length + 1)) : [],
  };
  if (main.ok) kept.push({ time: nextTime(), calls: [tx] });
  return result;
}

function adagEvent(logs, name) {
  for (const log of logs) {
    if (!isAddressEqual(log.address, C.ADAG_BILLS)) continue;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics });
      if (ev.eventName === name) return ev.args;
    } catch {}
  }
  return null;
}

// Decodes the built calldata back and holds it to C3: only build-time targets, never allowFailure, approvals to
// Morpho or Adag only.
function shapeProblems(built) {
  if (!isAddressEqual(built.to, C.MULTICALL3_FROM)) return [`batch goes to ${built.to}, not Multicall3From`];
  const decoded = decodeFunctionData({ abi: multicall3FromAbi, data: built.data });
  if (decoded.functionName !== 'aggregate3') return [`calldata is ${decoded.functionName}, not aggregate3`];
  const [calls] = decoded.args;
  const problems = [];
  for (const call of calls) {
    if (!BATCH_TARGETS.some((t) => isAddressEqual(t, call.target))) problems.push(`target ${call.target} is not a build-time constant`);
    if (call.allowFailure !== false) problems.push(`a call to ${call.target} may fail on its own`);
    if (call.callData.startsWith('0x095ea7b3')) {
      const spender = getAddress(`0x${call.callData.slice(34, 74)}`);
      if (!APPROVAL_SPENDERS.some((s) => isAddressEqual(s, spender))) problems.push(`approval to ${spender}`);
    }
  }
  return problems;
}

const billFromTuple = (id, b) => ({
  id, payee: getAddress(b.payee), status: b.status, due: b.due, currency: getAddress(b.currency),
  createdAt: b.createdAt, amount: b.amount, payer: getAddress(b.payer), paidAt: b.paidAt, ref: b.ref,
});

async function createBill(label) {
  const count = (await simulate([{ from: PAYEE, ...read(C.ADAG_BILLS, adagAbi, 'billCount') }]))[0];
  const id = decode(read(C.ADAG_BILLS, adagAbi, 'billCount'), count.returnData) + 1n;
  const due = pin.timestamp + 7n * 86_400n;
  const tx = { from: PAYEE, to: C.ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: 'createBill', args: [C.USDC, BILL_AMOUNT, due, stringToHex(label)] }) };
  const res = await send(tx, { after: [read(C.ADAG_BILLS, adagAbi, 'bill', [id])] });
  if (!res.ok) throw new Error(`createBill reverted: ${decodeAdagError(res.revertData).text}`);
  const created = adagEvent(res.logs, 'BillCreated');
  return { id, created, bill: billFromTuple(id, res.after[0]), res };
}

const usdc = (v) => `${(Number(v) / 1e6).toFixed(6)} USDC`;
const btc = (v) => `${(Number(v) / 1e8).toFixed(8)} cirBTC`;
const results = [];
const record = (label, ok, detail) => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  for (const line of [].concat(detail)) console.log(`        ${line}`);
};

async function main() {
  const chainId = Number(await rpc('eth_chainId', []));
  if (chainId !== C.CHAIN_ID) throw new Error(`${SIM_RPC} reports chain ${chainId}, not Arc mainnet ${C.CHAIN_ID}.`);
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  pin = { number: BigInt(head.number), timestamp: BigInt(head.timestamp) };
  console.log(`check-batches: src/lib/pay builders on live Arc mainnet state (chain ${chainId}, latest block ${pin.number}, ${new Date(Number(pin.timestamp) * 1000).toISOString()}).`);
  console.log(`Every step runs in eth_simulateV1 on dRPC. Nothing is signed or sent. Payer ${PAYER}, payee ${PAYEE}.`);
  console.log();

  const usdcParams = paramsFromTuple(await ethCall(read(C.MORPHO, morphoAbi, 'idToMarketParams', [C.MARKET_USDC])));
  const otherParams = paramsFromTuple(await ethCall(read(C.MORPHO, morphoAbi, 'idToMarketParams', [C.OTHER_USDC_CIRBTC_MARKET])));
  const payeeBal = () => read(C.USDC, erc20Abi, 'balanceOf', [PAYEE]);

  // (a) The payee writes a 0.50 USDC bill.
  const a = await createBill('ADAG-CHECK-A');
  record('(a) payee writes a 0.50 USDC bill', !!a.created && a.created.id === a.id && isAddressEqual(a.created.payee, PAYEE)
    && a.created.amount === BILL_AMOUNT && a.bill.status === C.BILL_STATUS.Open,
  [`bill #${a.id}, BillCreated from Adag: payee ${a.created?.payee}, ${usdc(a.created?.amount ?? 0n)}, status ${a.bill.status} (open)`, `gas ${a.res.gas}`]);

  // (b) Pay it from balance.
  const b = buildPayFromBalance(a.bill, PAYER);
  const bShape = shapeProblems(b);
  const bRes = await send({ from: PAYER, to: b.to, data: b.data }, { before: [payeeBal()], after: [payeeBal(), read(C.ADAG_BILLS, adagAbi, 'bill', [a.id])] });
  const bPaid = bRes.ok ? adagEvent(bRes.logs, 'BillPaid') : null;
  const bRise = bRes.ok ? bRes.after[0] - bRes.before[0] : 0n;
  record('(b) buildPayFromBalance pays it in one batch, loanChecked false',
    bRes.ok && bShape.length === 0 && !!bPaid && bPaid.id === a.id && bPaid.loanChecked === false && bRise === BILL_AMOUNT && bRes.after[1].status === C.BILL_STATUS.Paid,
    bRes.ok
      ? [`${b.calls.length} calls, every allowFailure false, targets ${b.calls.map((x) => x.target.slice(0, 6)).join(' ')}${bShape.length ? `; PROBLEMS: ${bShape.join('; ')}` : ''}`,
        `BillPaid #${bPaid?.id} loanChecked ${bPaid?.loanChecked}; payee ${usdc(bRes.before[0])} -> ${usdc(bRes.after[0])} (+${usdc(bRise)}); gas ${bRes.gas}`]
      : [`reverted: ${decodeAdagError(bRes.revertData).text}`]);

  // (c) Another bill, paid from bitcoin at the suggested pledge.
  const c = await createBill('ADAG-CHECK-C');
  const cNeedRes = await simulate([
    { from: PAYER, ...read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, C.MARKET_USDC, c.bill.amount]) },
    { from: PAYER, ...read(C.ADAG_BILLS, adagAbi, 'priceStatus', [C.MARKET_USDC]) },
  ]);
  const cNeeded = decode(read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, C.MARKET_USDC, 0n]), cNeedRes[0].returnData);
  const [fresh, btcUpdatedAt] = decode(read(C.ADAG_BILLS, adagAbi, 'priceStatus', [C.MARKET_USDC]), cNeedRes[1].returnData);
  const cPledge = suggestPledge(cNeeded);
  const cBuilt = buildPayFromBitcoin(c.bill, PAYER, cPledge, usdcParams);
  const cShape = shapeProblems(cBuilt);
  const cRes = await send({ from: PAYER, to: cBuilt.to, data: cBuilt.data }, {
    before: [payeeBal()],
    after: [payeeBal(), read(C.ADAG_BILLS, adagAbi, 'loanToValue', [PAYER, C.MARKET_USDC])],
  });
  const cPaid = cRes.ok ? adagEvent(cRes.logs, 'BillPaid') : null;
  const cRise = cRes.ok ? cRes.after[0] - cRes.before[0] : 0n;
  record('(c) buildPayFromBitcoin at the suggested pledge pays it, loanChecked true, payee credited exactly',
    cRes.ok && cShape.length === 0 && !!cPaid && cPaid.id === c.id && cPaid.loanChecked === true && cRise === BILL_AMOUNT,
    [`bill #${c.id}; price ${fresh ? 'fresh' : 'STALE'} (BTC/USD updated ${((Number(pin.timestamp) - Number(btcUpdatedAt)) / 3600).toFixed(1)} h ago)`,
      `collateralNeeded ${btc(cNeeded)}, suggested pledge ${btc(cPledge)} (x1.05 rounded up, +1 sat)`,
      ...(cRes.ok
        ? [`${cBuilt.calls.length} calls, every allowFailure false${cShape.length ? `; PROBLEMS: ${cShape.join('; ')}` : ''}`,
          `BillPaid #${cPaid?.id} loanChecked ${cPaid?.loanChecked}; payee +${usdc(cRise)}; loan-to-value after ${(Number(cRes.after[1]) / 1e16).toFixed(2)}%; gas ${cRes.gas}`]
        : [`reverted: ${decodeAdagError(cRes.revertData).text}`])]);

  // (d) The same path with a pledge 30% under the suggestion must be refused, in plain words.
  const d = await createBill('ADAG-CHECK-D');
  const dNeedRes = await simulate([{ from: PAYER, ...read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, C.MARKET_USDC, d.bill.amount]) }]);
  const dNeeded = decode(read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, C.MARKET_USDC, 0n]), dNeedRes[0].returnData);
  const dSuggested = suggestPledge(dNeeded);
  const dPledge = (dSuggested * 70n) / 100n;
  const dBuilt = buildPayFromBitcoin(d.bill, PAYER, dPledge, usdcParams);
  const dRes = await send({ from: PAYER, to: dBuilt.to, data: dBuilt.data });
  const dErr = dRes.ok ? null : decodeAdagError(dRes.revertData);
  record('(d) a pledge 30% under the suggestion is refused with the LtvAboveLimit sentence',
    !dRes.ok && dErr?.name === 'LtvAboveLimit' && dErr.text === LTV_SENTENCE,
    [`bill #${d.id}; suggested ${btc(dSuggested)}, tried ${btc(dPledge)}`,
      dRes.ok ? 'the batch SUCCEEDED, which is wrong' : `refused: ${dErr.name}: "${dErr.text}"`,
      dRes.ok ? '' : `raw revert ${String(dRes.revertData).slice(0, 10)}... (Memo's MemoFailed wrapping Adag's error, unwrapped by decodeAdagError)`]);

  // (e) The other USDC/cirBTC market's params, offered as MARKET_USDC, must be refused.
  const outcome = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  const realOk = outcome(() => verifyMarketParams(usdcParams, C.MARKET_USDC));
  const ownId = outcome(() => verifyMarketParams(otherParams, C.OTHER_USDC_CIRBTC_MARKET));
  const swapped = outcome(() => verifyMarketParams(otherParams, C.MARKET_USDC));
  const builderSwapped = outcome(() => buildPayFromBitcoin(d.bill, PAYER, dSuggested, otherParams));
  record('(e) verifyMarketParams throws on the second USDC/cirBTC market\'s params',
    realOk === null && ownId === null && swapped !== null && builderSwapped !== null,
    [`other market ${C.OTHER_USDC_CIRBTC_MARKET}: oracle ${otherParams.oracle}, lltv ${otherParams.lltv}`,
      `as MARKET_USDC: ${swapped ?? 'ACCEPTED'}`,
      `buildPayFromBitcoin with them: ${builderSwapped ?? 'ACCEPTED'}`,
      `MARKET_USDC's own params: ${realOk ?? 'accepted'}; the other params against their own id: ${ownId ?? 'accepted'}`]);


  // (f) to (j) start again from the live block, so each proves one action on real mainnet state and nothing else.
  const usdcCurrency = C.CURRENCIES.find((c) => c.symbol === 'USDC');
  const reset = () => { kept.length = 0; };
  const pos = () => read(C.MORPHO, morphoAbi, 'position', [C.MARKET_USDC, PAYER]);
  const mkt = () => read(C.MORPHO, morphoAbi, 'market', [C.MARKET_USDC]);
  const btcOf = () => read(C.CIRBTC, erc20Abi, 'balanceOf', [PAYER]);
  const allowance = (token) => read(token, erc20Abi, 'allowance', [PAYER, C.MORPHO]);

  // (f) The payee writes a bill through buildCreateBill with a non-ASCII reference.
  reset();
  const fRef = 'F-café ✓ Straße';
  const fCount = decode(read(C.ADAG_BILLS, adagAbi, 'billCount'), (await simulate([{ from: PAYEE, ...read(C.ADAG_BILLS, adagAbi, 'billCount') }]))[0].returnData);
  const fCall = buildCreateBill(usdcCurrency, 1_230_000n, 0n, fRef);
  const fRes = await send({ from: PAYEE, ...fCall }, { after: [read(C.ADAG_BILLS, adagAbi, 'bill', [fCount + 1n])] });
  const fReturned = fRes.ok ? decodeFunctionResult({ abi: adagAbi, functionName: 'createBill', data: fRes.returnData }) : null;
  const fCreated = fRes.ok ? adagEvent(fRes.logs, 'BillCreated') : null;
  const fId = fRes.ok ? billCreatedIn(fRes.logs.map((l) => ({ ...l, removed: false }))) : null;
  const fBytes = referenceBytes(fRef);
  record('(f) buildCreateBill writes bill billCount + 1, and BillCreated carries the exact UTF-8 bytes of the reference',
    fRes.ok && fReturned === fCount + 1n && fId === fCount + 1n && fCreated?.ref === fBytes && fRes.after[0].ref === fBytes
      && fRes.after[0].amount === 1_230_000n && fRes.after[0].due === 0n && isAddressEqual(fRes.after[0].payee, PAYEE),
    fRes.ok
      ? [`billCount ${fCount}, createBill returned ${fReturned}, billCreatedIn ${fId}`,
        `reference "${fRef}" is ${(fBytes.length - 2) / 2} bytes: ${fBytes}; BillCreated.ref ${fCreated?.ref === fBytes ? 'matches' : 'DIFFERS'}, bill(${fId}).ref ${fRes.after[0].ref === fBytes ? 'matches' : 'DIFFERS'}; gas ${fRes.gas}`]
      : [`reverted: ${decodeAdagError(fRes.revertData).text}`]);

  // (g) Add 0.00001 cirBTC to the payer's USDC loan.
  reset();
  const gAmount = 1_000n;
  const gBuilt = buildAddCollateral(PAYER, usdcCurrency, gAmount, usdcParams);
  const gRes = await send({ from: PAYER, to: gBuilt.to, data: gBuilt.data }, { before: [pos()], after: [pos(), allowance(C.CIRBTC)] });
  const gEvents = gRes.ok ? morphoEventsIn(gRes.logs.map((l) => ({ ...l, removed: false }))) : [];
  const gSupply = gEvents.find((e) => e.name === 'SupplyCollateral');
  const gRise = gRes.ok ? gRes.after[0][2] - gRes.before[0][2] : 0n;
  record('(g) buildAddCollateral: Morpho collateral rises by exactly the amount, cirBTC allowance to Morpho ends at 0',
    gRes.ok && shapeProblems(gBuilt).length === 0 && gRise === gAmount && gRes.after[1] === 0n && gSupply?.assets === gAmount && isAddressEqual(gSupply.onBehalf, PAYER),
    gRes.ok
      ? [`${gBuilt.calls.length} calls; pledged ${btc(gRes.before[0][2])} -> ${btc(gRes.after[0][2])} (+${gRise} sat); Morpho SupplyCollateral ${gSupply?.assets} sat for ${gSupply?.onBehalf}; allowance after ${gRes.after[1]}; gas ${gRes.gas}`]
      : [`reverted: ${decodeAdagError(gRes.revertData).text}`]);

  // (h) Close the payer's real USDC loan.
  reset();
  const [, hShares, hCollateral] = await ethCall(pos());
  const hMarket = await ethCall(mkt());
  const hDebt = debtFromShares(hShares, hMarket[2], hMarket[3]);
  const hApproval = closeApproval(hShares, hMarket[2], hMarket[3]);
  const hBuilt = buildCloseLoan(PAYER, usdcCurrency, { shares: hShares, collateral: hCollateral }, hApproval, usdcParams);
  const hRes = await send({ from: PAYER, to: hBuilt.to, data: hBuilt.data }, { before: [btcOf()], after: [pos(), btcOf(), allowance(C.USDC)] });
  const hEvents = hRes.ok ? morphoEventsIn(hRes.logs.map((l) => ({ ...l, removed: false }))) : [];
  const hRepay = hEvents.find((e) => e.name === 'Repay');
  const hWithdraw = hEvents.find((e) => e.name === 'WithdrawCollateral');
  const hBack = hRes.ok ? hRes.after[1] - hRes.before[0] : 0n;
  record('(h) buildCloseLoan closes the real USDC loan: 0 shares, 0 pledged, all cirBTC back, USDC allowance to Morpho 0',
    hShares > 0n && hRes.ok && shapeProblems(hBuilt).length === 0 && hRes.after[0][1] === 0n && hRes.after[0][2] === 0n && hBack === hCollateral
      && hRes.after[2] === 0n && hRepay?.shares === hShares && hWithdraw?.assets === hCollateral && isAddressEqual(hWithdraw.receiver, PAYER),
    [`loan ${usdc(hDebt)} (${hShares} shares) against ${btc(hCollateral)}; approval ${usdc(hApproval)} (debt + 0.1% + 1)`,
      ...(hRes.ok
        ? [`${hBuilt.calls.length} calls; Morpho Repay ${usdc(hRepay?.assets ?? 0n)} for ${hRepay?.shares} shares; WithdrawCollateral ${btc(hWithdraw?.assets ?? 0n)} to ${hWithdraw?.receiver}`,
          `after: ${hRes.after[0][1]} shares, ${btc(hRes.after[0][2])} pledged, cirBTC back ${btc(hBack)}, USDC allowance to Morpho ${hRes.after[2]}; gas ${hRes.gas}`]
        : [`reverted: ${decodeAdagError(hRes.revertData).text}`])]);

  // (i) The same close, approving one unit less than the debt, must be refused in plain words.
  reset();
  const iBuilt = buildCloseLoan(PAYER, usdcCurrency, { shares: hShares, collateral: hCollateral }, hDebt - 1n, usdcParams);
  const iRes = await send({ from: PAYER, to: iBuilt.to, data: iBuilt.data });
  const iErr = iRes.ok ? null : decodeAdagError(iRes.revertData);
  record('(i) a close approving 1 unit short of the debt is refused, with a plain sentence',
    !iRes.ok && !!iErr && iErr.name !== 'unknown' && iErr.text.length > 20,
    iRes.ok ? 'the close SUCCEEDED, which is wrong' : [`approved ${usdc(hDebt - 1n)} for a debt of ${usdc(hDebt)}`, `refused: ${iErr.name}: "${iErr.text}"`, `raw revert ${String(iRes.revertData).slice(0, 138)}`]);

  // (j) The look-alike market's params are refused by the loan builders too.
  const jAdd = outcome(() => buildAddCollateral(PAYER, usdcCurrency, 1_000n, otherParams));
  const jClose = outcome(() => buildCloseLoan(PAYER, usdcCurrency, { shares: hShares, collateral: hCollateral }, hApproval, otherParams));
  record("(j) buildAddCollateral and buildCloseLoan throw on the second USDC/cirBTC market's params",
    jAdd !== null && jClose !== null, [`buildAddCollateral: ${jAdd ?? 'ACCEPTED'}`, `buildCloseLoan: ${jClose ?? 'ACCEPTED'}`]);

  const passed = results.filter((r) => r.ok).length;
  console.log();
  console.log(passed === results.length ? `ALL ${passed} CHECKS PASSED` : `${results.length - passed} OF ${results.length} CHECKS FAILED`);
  return passed === results.length ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\nSTOPPED: ${error?.shortMessage ?? error?.message ?? String(error)}`);
    process.exit(1);
  },
);
