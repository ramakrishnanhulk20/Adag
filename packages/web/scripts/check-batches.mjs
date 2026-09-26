// Proves the web app's own batch builders (src/lib/pay) against live Arc mainnet state, without signing anything.
// Every transaction runs inside dRPC's eth_simulateV1 from the latest block, the pattern prove-it/lib.mjs uses.
//
//   node packages/web/scripts/check-batches.mjs
//
// Checks (a) to (e) prove paying; (f) to (j) prove writing a bill, adding cirBTC and closing a loan. All of them run
// against the current AdagBills; (q) proves a bill on the first deployment still pays there. Exits 0 only if all pass.
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
const { buildPayFromBalance, buildPayFromBitcoin, suggestPledge, buildCreateBill, buildAddCollateral, buildCloseLoan, buildPayMany, referenceBytes, BATCH_TARGETS, APPROVAL_SPENDERS } = await pay('build.ts');
const { debtFromShares, closeApproval, accrueBorrowAssets, repaySomeCap, sharesForRepay } = await pay('loan.ts');
const { buildRepaySome, buildSafeBatch } = await pay('build.ts');
const safeLib = (file) => import(new URL(`../src/lib/safe/${file}`, import.meta.url).href);
const S = await safeLib('constants.ts');
const { safeAbi, safeProxyFactoryAbi } = await safeLib('abi.ts');
const { safeTxFor, safeTxHash, safeTxTypedData } = await safeLib('typedData.ts');
const { assertSafeTxShape } = await safeLib('multisend.ts');
const { privateKeyToAccount } = await import('viem/accounts');
const { keccak256, parseAbi } = await import('viem');
const transferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const { toEventSelector } = await import('viem');
const EXECUTION_SUCCESS = toEventSelector('ExecutionSuccess(bytes32,uint256)');
const { billCreatedIn, billsPaidIn, morphoEventsIn } = await pay('receipt.ts');
const { decodeAdagError } = await pay('errors.ts');
const { verifyMarketParams, paramsFromTuple } = await pay('market.ts');
const { adagAbi, erc20Abi, irmAbi, morphoAbi, multicall3FromAbi } = await pay('abi.ts');
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
// `overrides` applies state overrides to the new block only (for example a balance, so a check tests one thing).
async function simulate(calls, time = nextTime(), overrides = null) {
  const blocks = [...kept, { time, calls, overrides }].map((b) => ({
    blockOverrides: { time: toHex(b.time) },
    ...(b.overrides ? { stateOverrides: b.overrides } : {}),
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

function adagEvent(logs, name, contract = C.ADAG_BILLS) {
  for (const log of logs) {
    if (!isAddressEqual(log.address, contract)) continue;
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

// Every check runs against the current AdagBills unless it names the first deployment, as (q) does.
const billFromTuple = (id, b, contract = C.ADAG_BILLS) => ({
  contract, id, payee: getAddress(b.payee), status: b.status, due: b.due, currency: getAddress(b.currency),
  createdAt: b.createdAt, amount: b.amount, payer: getAddress(b.payer), paidAt: b.paidAt, ref: b.ref,
});

async function createBill(label, contract = C.ADAG_BILLS) {
  const count = (await simulate([{ from: PAYEE, ...read(contract, adagAbi, 'billCount') }]))[0];
  const id = decode(read(contract, adagAbi, 'billCount'), count.returnData) + 1n;
  const due = pin.timestamp + 7n * 86_400n;
  const tx = { from: PAYEE, to: contract, data: encodeFunctionData({ abi: adagAbi, functionName: 'createBill', args: [C.USDC, BILL_AMOUNT, due, stringToHex(label)] }) };
  const res = await send(tx, { after: [read(contract, adagAbi, 'bill', [id])] });
  if (!res.ok) throw new Error(`createBill reverted: ${decodeAdagError(res.revertData).text}`);
  const created = adagEvent(res.logs, 'BillCreated', contract);
  return { id, created, bill: billFromTuple(id, res.after[0], contract), res };
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

  // (k) to (m): several bills, one signature. Each basket starts again from the live block.
  const eurcCurrency = C.CURRENCIES.find((c) => c.symbol === 'EURC');
  const eurcParams = paramsFromTuple(await ethCall(read(C.MORPHO, morphoAbi, 'idToMarketParams', [C.MARKET_EURC])));
  const billCountNow = async () =>
    decode(read(C.ADAG_BILLS, adagAbi, 'billCount'), (await simulate([{ from: PAYEE, ...read(C.ADAG_BILLS, adagAbi, 'billCount') }]))[0].returnData);
  const writeBill = async (currency, amount, label) => {
    const id = (await billCountNow()) + 1n;
    const res = await send({ from: PAYEE, ...buildCreateBill(currency, amount, 0n, label) }, { after: [read(C.ADAG_BILLS, adagAbi, 'bill', [id])] });
    if (!res.ok) throw new Error(`createBill reverted: ${decodeAdagError(res.revertData).text}`);
    return billFromTuple(id, res.after[0]);
  };
  const writeBasket = async (tag) => [
    await writeBill(usdcCurrency, 300_000n, `${tag}-1`),
    await writeBill(usdcCurrency, 200_000n, `${tag}-2`),
    await writeBill(eurcCurrency, 150_000n, `${tag}-3`),
  ];
  const needed = async (marketId, total) =>
    decode(read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, marketId, 0n]),
      (await simulate([{ from: PAYER, ...read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, marketId, total]) }]))[0].returnData);
  const eurcBal = (who) => read(C.EURC, erc20Abi, 'balanceOf', [who]);
  const ltvOf = (m) => read(C.ADAG_BILLS, adagAbi, 'loanToValue', [PAYER, m]);
  const basketChecks = async (label, bills, plan) => {
    const built = buildPayMany(bills, PAYER, plan);
    const res = await send({ from: PAYER, to: built.to, data: built.data }, {
      before: [payeeBal(), eurcBal(PAYEE)],
      after: [payeeBal(), eurcBal(PAYEE), ltvOf(C.MARKET_USDC), ltvOf(C.MARKET_EURC), ...bills.map((b) => read(C.ADAG_BILLS, adagAbi, 'bill', [b.id]))],
    });
    if (!res.ok) return { ok: false, detail: [`reverted: ${decodeAdagError(res.revertData).text}`] };
    const proofs = billsPaidIn(res.logs.map((l) => ({ ...l, removed: false })), C.ADAG_BILLS, bills.map((b) => b.id));
    const usdcRise = res.after[0] - res.before[0];
    const eurcRise = res.after[1] - res.before[1];
    const [ltvU, ltvE] = [res.after[2], res.after[3]];
    const allPaid = res.after.slice(4).every((b) => b.status === C.BILL_STATUS.Paid);
    const first = proofs.get(bills[0].id);
    const ok = shapeProblems(built).length === 0 && proofs.size === 3 && allPaid && first?.loanChecked === true
      && usdcRise === 500_000n && eurcRise === 150_000n && ltvU <= C.MAX_LTV_WAD && ltvE <= C.MAX_LTV_WAD;
    return {
      ok,
      detail: [
        `${label}: bills #${bills.map((b) => b.id).join(', #')}; ${built.calls.length} calls; ${proofs.size} BillPaid from Adag, loanChecked ${bills.map((b) => proofs.get(b.id)?.loanChecked).join('/')}`,
        `payee +${usdc(usdcRise)} and +${(Number(eurcRise) / 1e6).toFixed(6)} EURC; loan-to-value after: USDC ${(Number(ltvU) / 1e16).toFixed(2)}%, EURC ${(Number(ltvE) / 1e16).toFixed(2)}%; gas ${res.gas}`,
      ],
    };
  };

  // (k) Two USDC bills and one EURC bill, all from bitcoin, in one batch.
  reset();
  const kBills = await writeBasket('K');
  const kUsdcPledge = suggestPledge(await needed(C.MARKET_USDC, 500_000n));
  const kEurcPledge = suggestPledge(await needed(C.MARKET_EURC, 150_000n));
  const k = await basketChecks('all from bitcoin', kBills, {
    USDC: { from: 'bitcoin', pledge: kUsdcPledge, marketParams: usdcParams },
    EURC: { from: 'bitcoin', pledge: kEurcPledge, marketParams: eurcParams },
  });
  record('(k) buildPayMany pays 2 USDC bills and 1 EURC bill from bitcoin in one batch: 3 BillPaid, payees exact, both loans at or under 40%',
    k.ok, [`pledges ${btc(kUsdcPledge)} (USDC market) and ${btc(kEurcPledge)} (EURC market)`, ...k.detail]);

  // (l) The same basket, USDC from balance and EURC from bitcoin.
  reset();
  const lBills = await writeBasket('L');
  const lEurcPledge = suggestPledge(await needed(C.MARKET_EURC, 150_000n));
  const l = await basketChecks('mixed', lBills, {
    USDC: { from: 'balance' },
    EURC: { from: 'bitcoin', pledge: lEurcPledge, marketParams: eurcParams },
  });
  record('(l) the same basket with USDC from balance and EURC from bitcoin', l.ok, [`EURC pledge ${btc(lEurcPledge)}`, ...l.detail]);

  // (m) What buildPayMany refuses.
  const template = kBills[0];
  const eurcBill = kBills[2];
  const fromBtc = { USDC: { from: 'bitcoin', pledge: 1_000n, marketParams: usdcParams }, EURC: { from: 'bitcoin', pledge: 1_000n, marketParams: eurcParams } };
  const refusals = [
    ['a duplicate id', () => buildPayMany([template, template], PAYER, fromBtc)],
    ['11 bills', () => buildPayMany(Array.from({ length: 11 }, (_, i) => ({ ...template, id: 1_000n + BigInt(i) })), PAYER, fromBtc)],
    ['a paid bill', () => buildPayMany([{ ...template, status: C.BILL_STATUS.Paid }], PAYER, fromBtc)],
    ["the payer's own bill", () => buildPayMany([{ ...template, payee: PAYER }], PAYER, fromBtc)],
    ['a currency with no plan', () => buildPayMany([template, eurcBill], PAYER, { USDC: { from: 'balance' } })],
    ['the look-alike market params', () => buildPayMany([template], PAYER, { USDC: { from: 'bitcoin', pledge: 1_000n, marketParams: otherParams } })],
  ].map(([what, fn]) => [what, outcome(fn)]);
  record('(m) buildPayMany refuses a duplicate, 11 bills, a paid bill, its own bill, an unplanned currency and look-alike params',
    refusals.every(([, message]) => message !== null), refusals.map(([what, message]) => `${what}: ${message ?? 'ACCEPTED'}`));

  // (n) A close on a market nobody has touched for a long time: interest accrued since lastUpdate outgrows the 0.1%
  // margin. The simulated block's clock jumps forward; nothing else changes.
  reset();
  const [, nShares, nCollateral] = await ethCall(pos());
  const nMarket = await ethCall(mkt());
  const marketArg = (m) => ({ totalSupplyAssets: m[0], totalSupplyShares: m[1], totalBorrowAssets: m[2], totalBorrowShares: m[3], lastUpdate: m[4], fee: m[5] });
  const rateSpec = read(C.ADAPTIVE_CURVE_IRM, irmAbi, 'borrowRateView', [usdcParams, marketArg(nMarket)]);
  const liveRate = await ethCall(rateSpec);
  // Aim for 0.2% of accrued interest at today's rate, twice the margin the close adds.
  const jump = (2n * 10n ** 15n + liveRate - 1n) / liveRate;
  const jumpedTime = nMarket[4] + jump;
  // The adaptive rate model averages over the gap, so the rate Morpho accrues with is read inside the jumped block.
  const jumpedRate = decode(rateSpec, (await simulate([{ from: PAYER, ...rateSpec }], jumpedTime))[0].returnData);
  const accruedTotal = accrueBorrowAssets(nMarket[2], jumpedRate, jumpedTime - nMarket[4]);
  const storedApproval = closeApproval(nShares, nMarket[2], nMarket[3]);
  const accruedApproval = closeApproval(nShares, accruedTotal, nMarket[3]);
  const nOld = buildCloseLoan(PAYER, usdcCurrency, { shares: nShares, collateral: nCollateral }, storedApproval, usdcParams);
  const nNew = buildCloseLoan(PAYER, usdcCurrency, { shares: nShares, collateral: nCollateral }, accruedApproval, usdcParams);
  // Months of interest at whatever rate the market then runs can outgrow the demo wallet, so the payer gets 1,000 USDC
  // (Arc's native balance is its USDC) in both runs. What differs between them is only the approval.
  const funded = { [PAYER]: { balance: toHex(1_000n * 10n ** 18n) } };
  const oldRes = (await simulate([{ from: PAYER, to: nOld.to, data: nOld.data }], jumpedTime, funded))[0];
  const newOut = await simulate([{ from: PAYER, to: nNew.to, data: nNew.data }, { from: PAYER, ...pos() }, { from: PAYER, ...allowance(C.USDC) }], jumpedTime, funded);
  const newPos = newOut[0].ok ? decode(pos(), newOut[1].returnData) : null;
  const newAllowance = newOut[0].ok ? decode(allowance(C.USDC), newOut[2].returnData) : null;
  const nRepay = newOut[0].ok ? morphoEventsIn(newOut[0].logs.map((l) => ({ ...l, removed: false }))).find((e) => e.name === 'Repay') : null;
  const days = (Number(jump) / 86_400).toFixed(1);
  record('(n) after a long untouched gap, the stored-totals approval is refused and the accrued approval closes the loan to 0 and 0',
    !oldRes.ok && newOut[0].ok && newPos?.[1] === 0n && newPos?.[2] === 0n && newAllowance === 0n && accruedApproval > storedApproval,
    [`live rate ${liveRate} wad/s (${((Math.expm1(Number(liveRate) * 31_536_000 / 1e18)) * 100).toFixed(3)}% a year); jump ${jump} s (${days} days) past lastUpdate ${nMarket[4]}; rate inside the jumped block ${jumpedRate} wad/s`,
      `stored totalBorrowAssets ${usdc(nMarket[2])}, accrued ${usdc(accruedTotal)}; the loan's debt ${usdc(debtFromShares(nShares, nMarket[2], nMarket[3]))} stored vs ${usdc(debtFromShares(nShares, accruedTotal, nMarket[3]))} accrued`,
      `stored-totals approval ${usdc(storedApproval)}: ${oldRes.ok ? 'ACCEPTED, which is wrong' : `refused, "${decodeAdagError(oldRes.revertData).text}"`}`,
      `accrued approval ${usdc(accruedApproval)}: ${newOut[0].ok ? `closed; Morpho Repay ${usdc(nRepay?.assets ?? 0n)}; after: ${newPos[1]} shares, ${newPos[2]} pledged, allowance ${newAllowance}` : `refused, "${decodeAdagError(newOut[0].revertData).text}"`}`]);

  // (o) Repay some: 0.10 USDC off the demo payer's real loan, by amount, straight to Morpho.
  reset();
  const [, oShares] = await ethCall(pos());
  const oMarket = await ethCall(mkt());
  const oRateSpec = read(C.ADAPTIVE_CURVE_IRM, irmAbi, 'borrowRateView', [usdcParams, marketArg(oMarket)]);
  const oTime = nextTime();
  // The rate and the accrual are read for the very block the repay runs in, so the expected shares are exact.
  const oRate = decode(oRateSpec, (await simulate([{ from: PAYER, ...oRateSpec }], oTime))[0].returnData);
  const oAccrued = accrueBorrowAssets(oMarket[2], oRate, oTime - oMarket[4]);
  const oCap = repaySomeCap(oShares, oAccrued, oMarket[3]);
  const oAssets = 100_000n;
  const oBuilt = buildRepaySome(PAYER, usdcCurrency, oAssets, usdcParams, oCap);
  const oRes = await send({ from: PAYER, to: oBuilt.to, data: oBuilt.data }, { before: [pos()], after: [pos(), allowance(C.USDC)] });
  const oRepay = oRes.ok ? morphoEventsIn(oRes.logs.map((l) => ({ ...l, removed: false }))).find((e) => e.name === 'Repay') : null;
  const oExpected = sharesForRepay(oAssets, oAccrued, oMarket[3]);
  const oFell = oRes.ok ? oRes.before[0][1] - oRes.after[0][1] : 0n;
  const oOver = outcome(() => buildRepaySome(PAYER, usdcCurrency, oCap + 1n, usdcParams, oCap));
  const oZero = outcome(() => buildRepaySome(PAYER, usdcCurrency, 0n, usdcParams, oCap));
  record('(o) buildRepaySome repays 0.10 USDC by amount: shares fall by exactly the matching count, no approval left, over the cap refused',
    oRes.ok && shapeProblems(oBuilt).length === 0 && oBuilt.calls.length === 2 && oRepay?.assets === oAssets && oRepay?.shares === oExpected
      && oFell === oExpected && oRes.after[1] === 0n && oOver !== null && oZero !== null,
    [`debt ${usdc(debtFromShares(oShares, oAccrued, oMarket[3]))}, cap (rounded down) ${usdc(oCap)}; ${oBuilt.calls.length} calls`,
      oRes.ok
        ? `Morpho Repay ${usdc(oRepay?.assets ?? 0n)} for ${oRepay?.shares} shares; expected ${oExpected}; position fell by ${oFell}; USDC allowance after ${oRes.after[1]}; gas ${oRes.gas}`
        : `reverted: ${decodeAdagError(oRes.revertData).text}`,
      `cap + 1: ${oOver ?? 'ACCEPTED'}`, `zero: ${oZero ?? 'ACCEPTED'}`]);

  // (p) A Safe pays: a real Safe v1.4.1 deployed inside the simulation through Arc's SafeProxyFactory, funded by the
  // demo payer, with a throwaway owner key. The batch is buildSafeBatch's, signed as EIP-712 and run through the
  // Safe's own execTransaction: once from the Safe's balance, once from the Safe's bitcoin.
  const owner = privateKeyToAccount(keccak256(stringToHex('adag check-batches safe owner')));
  const safeRun = async (label, from) => {
    reset();
    const bill = await writeBill(usdcCurrency, 200_000n, `P-${label}`);
    const setup = encodeFunctionData({
      abi: safeAbi,
      functionName: 'setup',
      args: [[owner.address], 1n, S.ZERO_ADDRESS, '0x', S.SAFE_FALLBACK_HANDLER, S.ZERO_ADDRESS, 0n, S.ZERO_ADDRESS],
    });
    const create = encodeFunctionData({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', args: [S.SAFE_L2_SINGLETON, setup, BigInt(Date.now()) + (from === 'bitcoin' ? 1n : 0n)] });
    const deployed = await send({ from: PAYER, to: S.SAFE_PROXY_FACTORY, data: create });
    if (!deployed.ok) throw new Error(`The Safe could not be deployed in the simulation: ${decodeAdagError(deployed.revertData).text}`);
    const safe = getAddress(decodeFunctionResult({ abi: safeProxyFactoryAbi, functionName: 'createProxyWithNonce', data: deployed.returnData }));
    // The demo payer funds the Safe: USDC for the balance run and the fee-free batch, cirBTC for the bitcoin run.
    const fundUsdc = await send({ from: PAYER, to: C.USDC, data: encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [safe, 500_000n] }) });
    const fundBtc = from === 'bitcoin' ? await send({ from: PAYER, to: C.CIRBTC, data: encodeFunctionData({ abi: transferAbi, functionName: 'transfer', args: [safe, 2_000n] }) }) : { ok: true };
    if (!fundUsdc.ok || !fundBtc.ok) throw new Error('The Safe could not be funded in the simulation.');

    let plan = { USDC: { from: 'balance' } };
    if (from === 'bitcoin') {
      const needed = decode(read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [safe, C.MARKET_USDC, 0n]),
        (await simulate([{ from: PAYER, ...read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [safe, C.MARKET_USDC, bill.amount]) }]))[0].returnData);
      plan = { USDC: { from: 'bitcoin', pledge: suggestPledge(needed), marketParams: usdcParams } };
    }
    const batch = buildSafeBatch(safe, [bill], plan);
    const tx = safeTxFor(batch, 0n);
    assertSafeTxShape(safe, tx);
    const localHash = safeTxHash(safe, tx);
    const chainHash = decode(read(safe, safeAbi, 'getTransactionHash', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce]),
      (await simulate([{ from: PAYER, ...read(safe, safeAbi, 'getTransactionHash', [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce]) }]))[0].returnData);
    const signature = await owner.signTypedData(safeTxTypedData(safe, tx));
    const exec = encodeFunctionData({ abi: safeAbi, functionName: 'execTransaction', args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, signature] });
    const allowanceOf = (token, spender) => read(token, erc20Abi, 'allowance', [safe, spender]);
    const res = await send({ from: PAYER, to: safe, data: exec }, {
      before: [payeeBal()],
      after: [payeeBal(), read(C.ADAG_BILLS, adagAbi, 'bill', [bill.id]), allowanceOf(C.USDC, C.ADAG_BILLS), allowanceOf(C.CIRBTC, C.MORPHO), read(C.MORPHO, morphoAbi, 'position', [C.MARKET_USDC, safe]), read(safe, safeAbi, 'nonce')],
    });
    if (!res.ok) return { ok: false, detail: [`${label}: execTransaction reverted: ${decodeAdagError(res.revertData).text}`] };
    const logs = res.logs.map((l) => ({ ...l, removed: false }));
    const paid = billsPaidIn(logs, C.ADAG_BILLS, [bill.id]).get(bill.id);
    // By selector: Safe 1.3.0 and 1.4.1 differ in whether txHash is indexed, but the event's signature is the same.
    const executed = logs.some((l) => isAddressEqual(l.address, safe) && l.topics[0] === EXECUTION_SUCCESS);
    const [payeeAfter, record, usdcAllowance, btcAllowance, position, nonceAfter] = res.after;
    const rise = payeeAfter - res.before[0];
    const ok = executed && localHash.toLowerCase() === chainHash.toLowerCase() && paid && isAddressEqual(paid.payer, safe) && rise === bill.amount
      && record.status === C.BILL_STATUS.Paid && isAddressEqual(record.payer, safe) && usdcAllowance === 0n && btcAllowance === 0n && nonceAfter === 1n
      && (from === 'bitcoin' ? position[1] > 0n && paid.loanChecked === true : position[1] === 0n);
    return {
      ok,
      detail: [
        `${label}: Safe ${safe} (1 of 1 owner ${owner.address}); ${batch.inner.length} inner calls via MultiSendCallOnly ${batch.to}; hash ${localHash === chainHash ? 'matches' : 'DIFFERS FROM'} getTransactionHash`,
        `ExecutionSuccess ${executed}; BillPaid #${bill.id} payer ${paid ? (isAddressEqual(paid.payer, safe) ? 'the Safe' : paid.payer) : 'none'}, loanChecked ${paid?.loanChecked}; payee +${usdc(rise)}; allowances left ${usdcAllowance} and ${btcAllowance}; Safe's Morpho borrow shares ${position[1]}; nonce ${nonceAfter}; gas ${res.gas}`,
      ],
    };
  };
  const pBalance = await safeRun('from the Safe balance', 'balance');
  const pBitcoin = await safeRun('from the Safe bitcoin', 'bitcoin');
  record("(p) a Safe pays through buildSafeBatch and its own execTransaction: from balance and from bitcoin, the payee credited exactly, the Safe the payer",
    pBalance.ok && pBitcoin.ok, [...pBalance.detail, ...pBitcoin.detail]);

  // (q) The first deployment stays payable: a bill written there is paid from balance by the same builder, the pay goes
  // to that contract through Memo, and only its own BillPaid proves it. A bill naming any other contract is refused.
  const q = await createBill('ADAG-CHECK-Q-FIRST', C.ADAG_BILLS_FIRST);
  const qBuilt = buildPayFromBalance(q.bill, PAYER);
  const qShape = shapeProblems(qBuilt);
  const qMemo = decodeFunctionData({ abi: parseAbi(['function memo(address target, bytes data, bytes32 memoId, bytes memoData)']), data: qBuilt.calls[1].callData });
  const qRes = await send({ from: PAYER, to: qBuilt.to, data: qBuilt.data }, { before: [payeeBal()], after: [payeeBal(), read(C.ADAG_BILLS_FIRST, adagAbi, 'bill', [q.id]), read(C.USDC, erc20Abi, 'allowance', [PAYER, C.ADAG_BILLS_FIRST])] });
  const qLogs = qRes.ok ? qRes.logs.map((l) => ({ ...l, removed: false })) : [];
  const qProof = billsPaidIn(qLogs, C.ADAG_BILLS_FIRST, [q.id]).get(q.id);
  const qCurrentProof = billsPaidIn(qLogs, C.ADAG_BILLS, [q.id]).get(q.id);
  const qRise = qRes.ok ? qRes.after[0] - qRes.before[0] : 0n;
  const qForeign = outcome(() => buildPayFromBalance({ ...q.bill, contract: C.MORPHO }, PAYER));
  record('(q) a bill on the first deployment still pays from balance there: its own BillPaid, the payee credited exactly, and a bill naming another contract is refused',
    q.bill.contract === C.ADAG_BILLS_FIRST && qRes.ok && qShape.length === 0 && isAddressEqual(qMemo.args[0], C.ADAG_BILLS_FIRST) && !!qProof && !qCurrentProof
      && isAddressEqual(qProof.payer, PAYER) && qRise === BILL_AMOUNT && qRes.after[1].status === C.BILL_STATUS.Paid && qRes.after[2] === 0n && qForeign !== null,
    qRes.ok
      ? [`first-deployment bill #${q.id} on ${C.ADAG_BILLS_FIRST}; Memo target ${qMemo.args[0]}; BillPaid from the first deployment: ${!!qProof}, from the current contract: ${!!qCurrentProof}`,
        `payee +${usdc(qRise)}; status ${qRes.after[1].status}; USDC allowance left ${qRes.after[2]}; gas ${qRes.gas}; a bill naming Morpho as its contract: ${qForeign ?? 'ACCEPTED'}`]
      : [`reverted: ${decodeAdagError(qRes.revertData).text}`]);

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
