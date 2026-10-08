// Proves, on live Arc mainnet state and without signing anything, the guards behind paying a bill from a loan in the
// other currency (invariants C65 to C75 of the cross-currency threat model): a real Circle swap plan runs inside the
// payer's Multicall3From batch, a short or stolen conversion can never be paid from the payer's own money, and code
// inside the swap cannot act as the payer. Every step runs in dRPC's eth_simulateV1 from the latest block, with
// validation on so Arc charges gas for real.
//
//   node packages/web/scripts/check-fx.mjs
//
// Checks F1 and F2 prove the floor transfer (the built-in balance check); F3 and F4 attack Multicall3From and Memo from
// inside a batch; F5 to F8 run real Circle plans with batches this script writes itself. F9 and F10 do the same job with
// the app's own code: src/lib/fx/circle.ts asks Circle, src/lib/fx/estimate.ts sizes the amount from the euro price,
// src/lib/fx/plan.ts checks the plan and the simulation's transfers, and src/lib/pay/build.ts writes the batch. The
// payer is an address nobody holds a key for, with no code and no history: its cirBTC and USDC come only from state
// overrides, read back through balanceOf under the same override before any check runs, so no real wallet's holdings
// matter. Other overrides plant the test-only contracts in scripts/fx-fixtures (never deployed) and add balances where a
// check needs them; each check says where. F8 may SKIP, only when the USDC market has too little free cash. Exits 0 only
// if nothing fails.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import {
  decodeErrorResult, decodeEventLog, decodeFunctionResult, encodeAbiParameters, encodeFunctionData, formatUnits, getAddress,
  isAddressEqual, keccak256, pad, parseAbi, stringToHex, toHex,
} from 'viem';

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
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code === 'MODULE_TYPELESS_PACKAGE_JSON') return;
  emitWarning(warning, ...rest);
};

const pay = (file) => import(new URL(`../src/lib/pay/${file}`, import.meta.url).href);
const fxLib = (file) => import(new URL(`../src/lib/fx/${file}`, import.meta.url).href);
const C = await pay('constants.ts');
const { adagAbi, erc20Abi, memoAbi, morphoAbi, multicall3FromAbi } = await pay('abi.ts');
const { closeApproval } = await pay('loan.ts');
const { paramsFromTuple } = await pay('market.ts');
const { buildPayConverted, buildCloseWithOtherCurrency, suggestPledge } = await pay('build.ts');
const { requestPlan } = await fxLib('circle.ts');
const { checkEffects } = await fxLib('plan.ts');
const { amountToSell, readEurUsd } = await fxLib('estimate.ts');

const SIM_RPC = 'https://rpc.drpc.mainnet.arc.io';
const CIRCLE_SWAP_URL = 'https://api.circle.com/v1/stablecoinKits/swap';
const CIRCLE_QUOTE_URL = 'https://api.circle.com/v1/stablecoinKits/quote';
const CIRCLE_ADAPTER = getAddress('0x7FB8c7260b63934d8da38aF902f87ae6e284a845');
// Derived from a fixed phrase, so nobody holds its key and nothing on the chain is its own. What it holds here is FUNDING.
const PAYER = getAddress(`0x${keccak256(stringToHex('adag check-fx payer')).slice(-40)}`);
const PAYEE = getAddress('0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B');
// Throwaway addresses where the test-only code is planted, and the account that makes the read calls.
const STAND_IN = getAddress('0x00000000000000000000000000000000000f0001');
const ATTACKER = getAddress('0x00000000000000000000000000000000000f0002');
const READER = getAddress('0x00000000000000000000000000000000000f0003');
// Arc's CallFrom precompile, found by tracing a Multicall3From call (debug_traceCall with a step tracer).
const CALL_FROM = getAddress('0x1800000000000000000000000000000000000003');

const EXPECTED = {
  ADAG_BILLS: '0xaf6C47ae3e2ccD2Cd829Dd8a1DcCb7a7665c08cB', MORPHO: '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD',
  MULTICALL3_FROM: '0x522fAf9A91c41c443c66765030741e4AaCe147D0', USDC: '0x3600000000000000000000000000000000000000',
  EURC: '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1', CIRBTC: '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0',
  MARKET_USDC: '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d',
  MARKET_EURC: '0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4',
};

// One batch is sent with this gas limit and this fee ceiling; the floor on a USDC output is computed from both.
const GAS_LIMIT = 2_000_000n;
const FEE_HEADROOM_PCT = 125n;
const READ_GAS = 600_000n;
const AMOUNT = 100_000_000n;
const UNIT = 10n ** 12n;
const TIMEOUT_MS = 60_000;
const SPACING_MS = 1_500;
const MAX_RESPONSE_BYTES = 5_000_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let lastCallAt = 0;
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
    if (attempt === 0 && (res.status === 429 || /rate|limit|too many/i.test(err.message ?? ''))) {
      await sleep(5_000);
      continue;
    }
    throw new Error(`dRPC ${method} failed: ${JSON.stringify(err)}`);
  }
}

const transferAbi = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const adapterAbi = parseAbi(['function execute(((address target, bytes data, uint256 value, address tokenIn, uint256 amountToApprove, address tokenOut, uint256 minTokenOut)[] instructions, (address token, address beneficiary)[] tokens, uint256 execId, uint256 deadline, bytes metadata) params, (uint8 permitType, address token, uint256 amount, bytes permitCalldata)[] tokenInputs, bytes signature) payable']);
const fixtureAbi = parseAbi([
  'function deliver(address token, address to, uint256 amount)',
  'function viaMulticall(address multicall, address token, address to, uint256 amount, bool allowFailure) returns (bool outerOk, bytes outerData)',
  'function viaMemo(address memo, address token, address to, uint256 amount) returns (bool outerOk, bytes outerData)',
  'function viaCallFrom(address callFrom, address sender, address token, address to, uint256 amount) returns (bool outerOk, bytes outerData)',
]);

const fixturesFile = new URL('./fx-fixtures/', import.meta.url);
const fixtures = JSON.parse(readFileSync(new URL('fixtures.json', fixturesFile), 'utf8'));
// Line endings are normalised so a Windows checkout with CRLF hashes the same as the file the bytecode came from.
const sourceText = readFileSync(new URL('FxFixtures.sol', fixturesFile), 'utf8').split('\r\n').join('\n');
const sourceHash = createHash('sha256').update(sourceText).digest('hex');
const CODE = Object.fromEntries(Object.entries(fixtures.contracts).map(([name, c]) => [name, c.runtimeBytecode]));

const enc = (abi, functionName, args) => encodeFunctionData({ abi, functionName, args });
const read = (to, abi, functionName, args = []) => ({ to, abi, functionName, args, data: enc(abi, functionName, args) });
const decode = (spec, data) => decodeFunctionResult({ abi: spec.abi, functionName: spec.functionName, data });
const call3 = (target, callData) => ({ target, allowFailure: false, callData });
const batchOf = (calls) => enc(multicall3FromAbi, 'aggregate3', [calls]);
const approve = (token, spender, amount) => call3(token, enc(erc20Abi, 'approve', [spender, amount]));
const transfer = (token, to, amount) => call3(token, enc(transferAbi, 'transfer', [to, amount]));
const balanceOf = (token, who) => read(token, erc20Abi, 'balanceOf', [who]);
const allowanceOf = (token, owner, spender) => read(token, erc20Abi, 'allowance', [owner, spender]);
const fmt6 = (v) => {
  const [whole, fraction = ''] = formatUnits(v, 6).split('.');
  return `${whole}.${fraction.padEnd(6, '0')}`;
};
const usdc = (v) => `${fmt6(v)} USDC`;
const tok = (symbol, v) => `${fmt6(v)} ${symbol}`;
const btc = (v) => `${formatUnits(v, 8)} cirBTC`;
const slackUnits = (gasLimit, maxFee) => (gasLimit * maxFee + UNIT - 1n) / UNIT;

function explain(data) {
  if (!data || data === '0x') return 'reverted with no data';
  for (const abi of [adagAbi, memoAbi, erc20Abi]) {
    try {
      const d = decodeErrorResult({ abi, data });
      if (d.errorName === 'MemoFailed') return `MemoFailed -> ${explain(d.args[0])}`;
      return `${d.errorName}(${(d.args ?? []).map(String).join(', ')})`;
    } catch {}
  }
  return `unknown error ${data.slice(0, 10)} (${(data.length - 2) / 2} bytes)`;
}

async function getPin() {
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  const baseFee = BigInt(head.baseFeePerGas);
  return { number: BigInt(head.number), timestamp: BigInt(head.timestamp), baseFee, maxFee: (baseFee * FEE_HEADROOM_PCT + 99n) / 100n };
}
// Every read sees the payer as FUNDING sets it; plainCall is the chain as it is, for the report line only.
const ethCall = async (pin, spec) => decode(spec, await rpc('eth_call', [{ to: spec.to, data: spec.data }, toHex(pin.number), FUNDING]));
const plainCall = async (pin, spec) => decode(spec, await rpc('eth_call', [{ to: spec.to, data: spec.data }, toHex(pin.number)]));

// Several override objects merged per address (balance, code, and storage changes together).
function overrides(...parts) {
  const out = {};
  for (const part of parts) {
    for (const [address, o] of Object.entries(part ?? {})) {
      const cur = out[address] ?? {};
      out[address] = { ...cur, ...o, ...(cur.stateDiff || o.stateDiff ? { stateDiff: { ...cur.stateDiff, ...o.stateDiff } } : {}) };
    }
  }
  return out;
}
const withBalance = (who, units6) => ({ [who]: { balance: toHex(units6 * UNIT) } });
const withCode = (who, code) => ({ [who]: { code } });
// EURC and cirBTC both keep balances in a mapping at slot 9 (Circle's FiatToken layout). For cirBTC this was read off the
// chain: the slot for Morpho holds exactly balanceOf(Morpho). main() proves it again for the payer before any check.
const FIAT_BALANCES_SLOT = 9n;
const fiatBalanceKey = (who) => keccak256(encodeAbiParameters([{ type: 'address' }, { type: 'uint256' }], [who, FIAT_BALANCES_SLOT]));
const withFiatBalance = (token, who, amount) => ({ [token]: { stateDiff: { [fiatBalanceKey(who)]: pad(toHex(amount), { size: 32 }) } } });
const withEurc = (who, amount) => withFiatBalance(C.EURC, who, amount);
// The payer in every read and simulation: 1,000 USDC as its native balance (Arc's USDC is the account balance itself, 18
// decimals) and 0.05 cirBTC, enough for every pledge here. A check that needs more says so and adds it.
const FUND_USDC = 1_000_000_000n;
const FUND_BTC = 5_000_000n;
const FUNDING = overrides(withBalance(PAYER, FUND_USDC), withFiatBalance(C.CIRBTC, PAYER, FUND_BTC));

// blocks: [{ calls: [{ from, to, data, gas?, maxFeePerGas? }], overrides? }], each a block one second after the last.
// The base fee is pinned to the latest real header: dRPC's simulated blocks work it out with the plain Ethereum formula,
// which lands under Arc's 20 gwei floor.
async function simulate(pin, blocks, traceTransfers = false) {
  const body = blocks.map((b, i) => ({
    blockOverrides: { time: toHex(pin.timestamp + BigInt(i + 1)), baseFeePerGas: toHex(pin.baseFee) },
    ...(b.overrides ? { stateOverrides: b.overrides } : {}),
    calls: b.calls.map((c) => ({
      from: c.from, to: c.to, data: c.data, gas: toHex(c.gas ?? READ_GAS), maxFeePerGas: toHex(c.maxFeePerGas ?? pin.maxFee), maxPriorityFeePerGas: toHex(0n),
    })),
  }));
  const result = await rpc('eth_simulateV1', [{ blockStateCalls: body, validation: true, traceTransfers }, toHex(pin.number)]);
  if (!Array.isArray(result) || result.length !== blocks.length) throw new Error('eth_simulateV1 returned an unexpected shape.');
  return result.map((blk) => ({
    baseFee: BigInt(blk.baseFeePerGas),
    calls: blk.calls.map((c) => ({
      ok: c.status === '0x1', returnData: c.returnData, logs: c.logs ?? [], gas: BigInt(c.gasUsed),
      revertData: c.returnData && c.returnData !== '0x' ? c.returnData : c.error?.data,
    })),
  }));
}

// The standard shape of every check: block 1 setup, block 2 reads before, block 3 the payer's transaction, block 4 reads after.
async function scenario(pin, { setup = [], ov, pre = [], tx, post = [], trace = false }) {
  const asRead = (s) => ({ from: READER, to: s.to, data: s.data });
  const out = await simulate(pin, [
    { calls: setup, overrides: overrides(FUNDING, withBalance(READER, 5_000_000n), ov) },
    { calls: pre.map(asRead) },
    { calls: [tx] },
    { calls: post.map(asRead) },
  ], trace);
  const unread = (specs, results) => specs.map((s, i) => {
    if (!results[i].ok) throw new Error(`Reading ${s.functionName} failed inside the simulation.`);
    return decode(s, results[i].returnData);
  });
  const setupFailed = out[0].calls.findIndex((c) => !c.ok);
  if (setupFailed >= 0) throw new Error(`Setup call ${setupFailed} reverted: ${explain(out[0].calls[setupFailed].revertData)}`);
  return { tx: out[2].calls[0], baseFee: out[2].baseFee, before: unread(pre, out[1].calls), after: unread(post, out[3].calls), setup: out[0].calls };
}

const payerTx = (calls, gas = GAS_LIMIT, maxFeePerGas) => ({ from: PAYER, to: C.MULTICALL3_FROM, data: batchOf(calls), gas, maxFeePerGas });
const batchResults = (res) => decodeFunctionResult({ abi: multicall3FromAbi, functionName: 'aggregate3', data: res.returnData });

const results = [];
function record(id, status, summary, detail = []) {
  results.push({ id, status });
  console.log(`  ${status}  ${id}  ${summary}`);
  for (const line of detail) console.log(`        ${line}`);
}

// ---- Circle ----
async function circleFetch(url, init) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch {}
    if (res.ok && json) return json;
    if (attempt === 0 && (res.status === 429 || res.status >= 500)) {
      await sleep(10_000);
      continue;
    }
    throw new Error(`Circle ${res.status}: ${text.slice(0, 200)}`);
  }
}
async function circleRate(tokenIn, tokenOut, sampleIn) {
  const q = new URLSearchParams({ tokenInAddress: tokenIn, tokenInChain: 'Arc', tokenOutAddress: tokenOut, tokenOutChain: 'Arc', fromAddress: PAYER, amount: String(sampleIn), slippageBps: '50' });
  const json = await circleFetch(`${CIRCLE_QUOTE_URL}?${q}`);
  return Number(json.quote.estimatedAmount) / Number(sampleIn);
}
async function circlePlan({ tokenIn, tokenOut, amount, stopLimit }) {
  const body = { tokenInAddress: tokenIn, tokenInChain: 'Arc', tokenOutAddress: tokenOut, tokenOutChain: 'Arc', fromAddress: PAYER, toAddress: PAYER, amount: String(amount), stopLimit: String(stopLimit) };
  const json = await circleFetch(CIRCLE_SWAP_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  if (!json?.transaction?.executionParams) throw new Error('Circle answered without a plan.');
  return json;
}
function planCall(plan, tokenIn, amount) {
  const ep = plan.transaction.executionParams;
  const params = {
    instructions: ep.instructions.map((i) => ({ target: i.target, data: i.data, value: BigInt(i.value), tokenIn: i.tokenIn, amountToApprove: BigInt(i.amountToApprove), tokenOut: i.tokenOut, minTokenOut: BigInt(i.minTokenOut) })),
    tokens: ep.tokens, execId: BigInt(ep.execId), deadline: BigInt(ep.deadline), metadata: ep.metadata,
  };
  const inputs = [{ permitType: 0, token: tokenIn, amount: BigInt(amount), permitCalldata: '0x' }];
  return call3(CIRCLE_ADAPTER, enc(adapterAbi, 'execute', [params, inputs, plan.transaction.signature]));
}

const currency = (symbol) => C.CURRENCIES.find((c) => c.symbol === symbol);
const memoPay = (id, ref) => call3(C.MEMO, enc(memoAbi, 'memo', [C.ADAG_BILLS, enc(adagAbi, 'pay', [id]), toHex(id, { size: 32 }), ref]));
const supplyCollateral = (cur, amount) => call3(C.MORPHO, enc(morphoAbi, 'supplyCollateral', [cur.params, amount, PAYER, '0x']));
const borrow = (cur, amount) => call3(C.MORPHO, enc(morphoAbi, 'borrow', [cur.params, amount, 0n, PAYER, PAYER]));
const paidEvent = (logs, id) => {
  for (const log of logs) {
    if (!isAddressEqual(log.address, C.ADAG_BILLS)) continue;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics });
      if (ev.eventName === 'BillPaid' && ev.args.id === id && isAddressEqual(ev.args.payer, PAYER)) return ev.args;
    } catch {}
  }
  return null;
};

// Everything a bill paid from a loan needs, decided once at a pinned block: the bill, the borrow X, the plan, the pledge,
// and the floor. loan is the loan currency, bill is the bill currency.
async function prepareBillFromLoan({ loan, bill, billAmount, marginBps }) {
  const pin = await getPin();
  const loanCur = currency(loan);
  const billCur = currency(bill);
  const id = (await ethCall(pin, read(C.ADAG_BILLS, adagAbi, 'billCount'))) + 1n;
  const ref = stringToHex(`ADAG-FX-${loan}-${bill}`);
  const createBill = { from: PAYEE, to: C.ADAG_BILLS, data: enc(adagAbi, 'createBill', [billCur.address, billAmount, pin.timestamp + 7n * 86_400n, ref]), gas: 500_000n };
  const rate = await circleRate(loanCur.address, billCur.address, 100_000_000n);
  const X = BigInt(Math.ceil((Number(billAmount) / rate) * (1 + marginBps / 10_000)));
  const plan = await circlePlan({ tokenIn: loanCur.address, tokenOut: billCur.address, amount: X, stopLimit: billAmount });
  const needed = await ethCall(pin, read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, loanCur.marketId, X]));
  const pledge = (needed * 105n) / 100n + 1n;
  const market = await ethCall(pin, read(C.MORPHO, morphoAbi, 'market', [loanCur.marketId]));
  const outBefore = await ethCall(pin, balanceOf(billCur.address, PAYER));
  const slack = bill === 'USDC' ? slackUnits(GAS_LIMIT, pin.maxFee) : 0n;
  const floor = outBefore + billAmount - slack;
  const head = [
    approve(C.CIRBTC, C.MORPHO, pledge),
    supplyCollateral(loanCur, pledge),
    borrow(loanCur, X),
    approve(loanCur.address, CIRCLE_ADAPTER, X),
    planCall(plan, loanCur.address, X),
  ];
  const tail = [approve(billCur.address, C.ADAG_BILLS, billAmount), memoPay(id, ref), approve(loanCur.address, CIRCLE_ADAPTER, 0n)];
  const calls = (withFloor) => [...head, ...(withFloor ? [transfer(billCur.address, PAYER, floor)] : []), ...tail];
  const ep = plan.transaction.executionParams;
  return { pin, loanCur, billCur, billAmount, id, createBill, X, plan, pledge, free: market[0] - market[2], outBefore, slack, floor, calls, loanSymbol: loan, billSymbol: bill, ep };
}

function billReads(ctx) {
  const { loanCur, billCur } = ctx;
  return [
    balanceOf(billCur.address, PAYEE), balanceOf(C.USDC, PAYER), balanceOf(C.EURC, PAYER), balanceOf(C.CIRBTC, PAYER),
    read(C.ADAG_BILLS, adagAbi, 'loanToValue', [PAYER, loanCur.marketId]),
    read(C.MORPHO, morphoAbi, 'position', [loanCur.marketId, PAYER]),
    allowanceOf(C.USDC, PAYER, CIRCLE_ADAPTER), allowanceOf(C.EURC, PAYER, CIRCLE_ADAPTER), allowanceOf(C.CIRBTC, PAYER, CIRCLE_ADAPTER),
    balanceOf(C.EURC, CIRCLE_ADAPTER),
  ];
}
const runBillBatch = (ctx, { withFloor, ov }) =>
  scenario(ctx.pin, { setup: [ctx.createBill], ov, pre: billReads(ctx), tx: payerTx(ctx.calls(withFloor)), post: billReads(ctx) });

function readBill(run) {
  const names = ['payee', 'usdc', 'eurc', 'btc', 'ltv', 'position', 'aUsdc', 'aEurc', 'aBtc', 'adapterEurc'];
  const pick = (vals) => Object.fromEntries(names.map((n, i) => [n, vals[i]]));
  return { before: pick(run.before), after: pick(run.after) };
}

function describePlan(ctx) {
  const n = ctx.ep.instructions.length;
  return `plan: ${n} instruction${n === 1 ? '' : 's'}, deadline ${ctx.ep.deadline}, quoted out ${fmt6(BigInt(ctx.plan.estimatedAmount))} ${ctx.billSymbol} for ${fmt6(ctx.X)} ${ctx.loanSymbol}`;
}

// ---- F1 and F2: the floor self-transfer ----
async function floorChecks() {
  const pin = await getPin();
  const slack = slackUnits(GAS_LIMIT, pin.maxFee);
  const standIn = { code: CODE.SwapStandIn };
  const deliver = (token, amount) => call3(STAND_IN, enc(fixtureAbi, 'deliver', [token, PAYER, amount]));
  const ownEurc = 500_000_000n;
  const eurcOv = overrides(withCode(STAND_IN, standIn.code), withEurc(PAYER, ownEurc), withEurc(STAND_IN, AMOUNT));
  const usdcBefore = await ethCall(pin, balanceOf(C.USDC, PAYER));
  // FUNDING sets the payer's native balance to exactly this; eth_getBalance takes no override, so it is not read back.
  const nativeBefore = FUND_USDC * UNIT;
  const usdcOv = overrides(withCode(STAND_IN, standIn.code), withBalance(STAND_IN, AMOUNT));
  const eurcRun = (delivered) => scenario(pin, {
    ov: eurcOv, pre: [balanceOf(C.EURC, PAYER)], post: [balanceOf(C.EURC, PAYER)],
    tx: payerTx([deliver(C.EURC, delivered), transfer(C.EURC, PAYER, ownEurc + AMOUNT)]),
  });
  const usdcRun = (delivered, withProbe = false) => scenario(pin, {
    ov: usdcOv, pre: [balanceOf(C.USDC, PAYER)], post: [balanceOf(C.USDC, PAYER)],
    tx: payerTx([...(withProbe ? [call3(C.USDC, enc(erc20Abi, 'balanceOf', [PAYER]))] : []), deliver(C.USDC, delivered), transfer(C.USDC, PAYER, usdcBefore + AMOUNT - slack)]),
  });

  const f1e = await eurcRun(AMOUNT);
  const f1u = await usdcRun(AMOUNT, true);
  const f2e = await eurcRun(AMOUNT - 1n);
  const f2u = await usdcRun(AMOUNT - slack - 1n);

  const probe = f1u.tx.ok ? BigInt(batchResults(f1u.tx)[0].returnData) : 0n;
  const upfront = usdcBefore - probe;
  const expectedUpfront = (GAS_LIMIT * f1u.baseFee) / UNIT;
  const netCharge = f1u.tx.ok ? usdcBefore + AMOUNT - f1u.after[0] : 0n;
  const expectedNet = (f1u.tx.gas * f1u.baseFee) / UNIT;
  const near = (a, b) => (a > b ? a - b : b - a) <= 1n;
  const gasModelHolds = f1u.tx.ok && near(upfront, expectedUpfront) && near(netCharge, expectedNet);

  record('F1', f1e.tx.ok && f1u.tx.ok && f1e.after[0] === ownEurc + AMOUNT && gasModelHolds ? 'PASS' : 'FAIL',
    `the floor self-transfer passes when met: EURC ${f1e.tx.ok ? 'ok' : 'REVERTED'}, native USDC ${f1u.tx.ok ? 'ok' : 'REVERTED'} (floor ${usdc(usdcBefore + AMOUNT - slack)} = balance ${usdc(usdcBefore)} + ${usdc(AMOUNT)} - slack ${usdc(slack)})`,
    [
      `EURC: payer owns ${tok('EURC', ownEurc)} (override), stand-in delivers ${tok('EURC', AMOUNT)} (override on the stand-in), floor ${tok('EURC', ownEurc + AMOUNT)}; balance after ${tok('EURC', f1e.after[0])}; ${f1e.tx.ok ? `gas ${f1e.tx.gas}` : explain(f1e.tx.revertData)}`,
      `USDC: payer holds ${usdc(usdcBefore)} (FUNDING), stand-in holds ${usdc(AMOUNT)} (override on the stand-in); ${f1u.tx.ok ? `gas ${f1u.tx.gas}` : explain(f1u.tx.revertData)}`,
      `how Arc charges gas: gas limit ${GAS_LIMIT}, max fee ${Number(pin.maxFee) / 1e9} gwei, base fee ${Number(f1u.baseFee) / 1e9} gwei, tip 0`,
      `  before the first call the balance already fell by ${usdc(upfront)} = gas limit x base fee (${usdc(expectedUpfront)}), not gas limit x max fee (${usdc(slack)})`,
      `  after the batch the net charge is ${usdc(netCharge)} = gas used ${f1u.tx.gas} x base fee (${usdc(expectedNet)}); the unused ${usdc(upfront - netCharge)} came back`,
    ]);

  // The most a short conversion can be and still pass is what the slack leaves over after the real up-front charge.
  const rem = nativeBefore % UNIT;
  const edge = slack - ((GAS_LIMIT * f1u.baseFee - rem + UNIT - 1n) / UNIT);
  const atEdge = await usdcRun(AMOUNT - edge);
  const pastEdge = await usdcRun(AMOUNT - edge - 1n);
  const edgeLine = atEdge.tx.ok && !pastEdge.tx.ok
    ? `named residual measured: a conversion short by up to ${usdc(edge)} passes on a USDC output, short by ${usdc(edge + 1n)} reverts (slack ${usdc(slack)} minus the ${usdc(slack - edge)} Arc takes up front)`
    : `residual model did not hold at ${usdc(edge)}: at the edge ${atEdge.tx.ok ? 'passed' : 'reverted'}, one unit past ${pastEdge.tx.ok ? 'passed' : 'reverted'}`;

  record('F2', !f2e.tx.ok && !f2u.tx.ok ? 'PASS' : 'FAIL',
    `short conversions revert: EURC short by 1 base unit ${f2e.tx.ok ? 'PASSED (wrong)' : 'reverted'}; USDC short by slack + 1 = ${usdc(slack + 1n)} ${f2u.tx.ok ? 'PASSED (wrong)' : 'reverted'}`,
    [
      `EURC: the payer's own ${tok('EURC', ownEurc)} did not fill the 1 missing unit; ${f2e.tx.ok ? '' : explain(f2e.tx.revertData)}`,
      `USDC: ${f2u.tx.ok ? '' : explain(f2u.tx.revertData)}`,
      `gas slack on USDC: ${usdc(slack)} = gas limit ${GAS_LIMIT} x max fee ${Number(pin.maxFee) / 1e9} gwei (a ${FEE_HEADROOM_PCT}% ceiling over the ${Number(pin.baseFee) / 1e9} gwei base fee)`,
      edgeLine,
    ]);
}

// ---- F3 and F4: code inside the batch cannot act as the payer ----
async function attackChecks() {
  const pin = await getPin();
  const ov = withCode(ATTACKER, CODE.SwapAttacker);
  const btcBefore = await ethCall(pin, balanceOf(C.CIRBTC, PAYER));
  const reads = [balanceOf(C.CIRBTC, PAYER), balanceOf(C.CIRBTC, ATTACKER)];
  const oneSat = enc(transferAbi, 'transfer', [ATTACKER, 1n]);
  const groups = [
    {
      id: 'F3', label: 'Multicall3From.aggregate3',
      attempts: [
        { name: 'aggregate3 with allowFailure true', fn: 'viaMulticall', args: [C.MULTICALL3_FROM, C.CIRBTC, ATTACKER, btcBefore, true], nested: true },
        { name: 'aggregate3 with allowFailure false', fn: 'viaMulticall', args: [C.MULTICALL3_FROM, C.CIRBTC, ATTACKER, btcBefore, false], nested: true },
        { name: 'the CallFrom precompile directly, naming the payer as sender', fn: 'viaCallFrom', args: [CALL_FROM, PAYER, C.CIRBTC, ATTACKER, btcBefore], nested: false },
      ],
      control: call3(C.MULTICALL3_FROM, enc(multicall3FromAbi, 'aggregate3', [[call3(C.CIRBTC, oneSat)]])),
    },
    {
      id: 'F4', label: 'Memo.memo',
      attempts: [{ name: 'memo wrapping the transfer', fn: 'viaMemo', args: [C.MEMO, C.CIRBTC, ATTACKER, btcBefore], nested: false }],
      control: call3(C.MEMO, enc(memoAbi, 'memo', [C.CIRBTC, oneSat, toHex(1n, { size: 32 }), '0x'])),
    },
  ];
  for (const g of groups) {
    const run = await scenario(pin, { ov, pre: reads, post: reads, tx: payerTx(g.attempts.map((a) => call3(ATTACKER, enc(fixtureAbi, a.fn, a.args)))) });
    // Control: the payer's own batch calls the same primitive, so a move as the payer is possible and visible in this setup.
    const control = await scenario(pin, { ov, pre: reads, post: reads, tx: payerTx([g.control]) });
    const moved = run.tx.ok ? run.before[0] - run.after[0] : 0n;
    const attackerGot = run.tx.ok ? run.after[1] - run.before[1] : 0n;
    const controlMoved = control.tx.ok ? control.before[0] - control.after[0] : 0n;
    const lines = [];
    const verdicts = [];
    if (run.tx.ok) {
      const outer = batchResults(run.tx);
      g.attempts.forEach((a, i) => {
        const [ok, data] = decodeFunctionResult({ abi: fixtureAbi, functionName: a.fn, data: outer[i].returnData });
        let verdict;
        if (!ok) verdict = `REVERT, ${explain(data)}`;
        else if (a.nested) {
          const inner = decodeFunctionResult({ abi: multicall3FromAbi, functionName: 'aggregate3', data })[0];
          verdict = inner.success ? 'inner call SUCCEEDED' : `NO EFFECT, ${g.label} returned success but the inner transfer failed with ${explain(inner.returnData)}`;
        } else verdict = 'returned success';
        verdicts.push(`${a.name}: ${verdict}`);
      });
    }
    lines.push(...verdicts, `control: the payer's own batch calls ${g.label} with a 1 sat transfer to the attacker and ${control.tx.ok ? `it moves ${controlMoved} sat` : `reverts: ${explain(control.tx.revertData)}`}`);
    const ran = run.tx.ok && verdicts.length === g.attempts.length;
    record(g.id, ran && moved === 0n && attackerGot === 0n && controlMoved === 1n ? 'PASS' : 'FAIL',
      `code inside the batch tries ${g.label} to move the payer's cirBTC (${btc(btcBefore)} asked, ${g.attempts.length} attempt${g.attempts.length === 1 ? '' : 's'}): payer moved ${btc(moved)}, attacker got ${btc(attackerGot)}${ran ? '' : `, but the batch reverted: ${explain(run.tx.revertData)}`}`,
      lines);
  }
}

// ---- F5 and F6: a real plan, and the same batch with a sink where the adapter was ----
async function billFromLoanChecks() {
  const ctx = await prepareBillFromLoan({ loan: 'EURC', bill: 'USDC', billAmount: AMOUNT, marginBps: 40 });
  const real = await runBillBatch(ctx, { withFloor: true });
  const r = readBill(real);
  const paid = real.tx.ok ? paidEvent(real.tx.logs, ctx.id) : null;
  const rise = real.tx.ok ? r.after.payee - r.before.payee : 0n;
  const allowances = real.tx.ok ? [r.after.aUsdc, r.after.aEurc, r.after.aBtc] : [];
  const ok5 = real.tx.ok && rise === AMOUNT && !!paid && r.after.ltv <= C.MAX_LTV_WAD && allowances.every((a) => a === 0n);
  record('F5', ok5 ? 'PASS' : 'FAIL',
    real.tx.ok
      ? `${AMOUNT / 1_000_000n} USDC bill paid from a EURC loan with a real Circle plan: payee +${usdc(rise)}, BillPaid #${paid?.id ?? 'none'} by the payer, EURC loan-to-value ${(Number(r.after.ltv) / 1e16).toFixed(2)}%, adapter allowances USDC/EURC/cirBTC ${allowances.join('/')}, gas ${real.tx.gas}`
      : `the batch reverted: ${explain(real.tx.revertData)}`,
    [
      `bill #${ctx.id}; borrow ${tok('EURC', ctx.X)} (the loan market had ${tok('EURC', ctx.free)} free); pledge ${btc(ctx.pledge)}; ${describePlan(ctx)}`,
      `${ctx.calls(true).length} calls in one aggregate3: approve cirBTC, supplyCollateral, borrow, approve adapter, execute, floor transfer, approve AdagBills, Memo.memo(pay), approve adapter 0`,
      `floor ${usdc(ctx.floor)} = balance ${usdc(ctx.outBefore)} + bill ${usdc(AMOUNT)} - gas slack ${usdc(ctx.slack)}`,
      ...(real.tx.ok ? [`payer USDC ${usdc(r.before.usdc)} -> ${usdc(r.after.usdc)} (the surplus from the plan, less gas); payer EURC ${tok('EURC', r.before.eurc)} -> ${tok('EURC', r.after.eurc)}; BillPaid loanChecked ${paid?.loanChecked}`] : []),
    ]);

  const sink = withCode(CIRCLE_ADAPTER, CODE.SinkAdapter);
  const topUp = r.before.usdc < AMOUNT + ctx.slack ? withBalance(PAYER, 2n * AMOUNT) : {};
  const guarded = await runBillBatch(ctx, { withFloor: true, ov: overrides(sink, topUp) });
  const naked = await runBillBatch(ctx, { withFloor: false, ov: overrides(sink, topUp) });
  const g = readBill(guarded);
  const n = readBill(naked);
  const nPaid = naked.tx.ok ? paidEvent(naked.tx.logs, ctx.id) : null;
  const nRise = naked.tx.ok ? n.after.payee - n.before.payee : 0n;
  const ownSpent = naked.tx.ok ? n.before.usdc - n.after.usdc : 0n;
  const gasPaid = naked.tx.ok ? (naked.tx.gas * naked.baseFee) / UNIT : 0n;
  const eurcKept = naked.tx.ok ? n.after.adapterEurc - n.before.adapterEurc : 0n;
  const guardHolds = !guarded.tx.ok && g.after.payee === g.before.payee;
  const controlLoses = naked.tx.ok && !!nPaid && nRise === AMOUNT && ownSpent >= AMOUNT;
  record('F6', guardHolds && controlLoses ? 'PASS' : 'FAIL',
    `a sink in place of the adapter: with the floor the batch ${guarded.tx.ok ? 'SUCCEEDED (wrong)' : 'reverts'} and the payee gets ${usdc(g.after.payee - g.before.payee)}; without the floor it ${naked.tx.ok ? 'succeeds' : 'REVERTED (control broken)'} and the payer's USDC fell by ${usdc(ownSpent)} (the ${usdc(AMOUNT)} bill from their own money, plus ${usdc(gasPaid)} gas)`,
    [
      `payer held ${usdc(r.before.usdc)} before${topUp[PAYER] ? ' (topped up by override)' : ''}; the sink took ${tok('EURC', ctx.X)} borrowed EURC and returned nothing`,
      `with the floor: ${guarded.tx.ok ? 'no revert' : `revert from the floor transfer, ${explain(guarded.tx.revertData)}`}; same batch minus only the floor call`,
      naked.tx.ok
        ? `loss without the floor: payee +${usdc(nRise)} (BillPaid #${nPaid?.id}, loanChecked ${nPaid?.loanChecked}); payer USDC ${usdc(n.before.usdc)} -> ${usdc(n.after.usdc)}, so their own money paid the bill; the sink kept ${tok('EURC', eurcKept)} while the payer still owes ${tok('EURC', ctx.X)}`
        : `control reverted: ${explain(naked.tx.revertData)}`,
    ]);
}

// ---- F7: closing a EURC loan with USDC ----
async function closeLoanCheck() {
  const pin = await getPin();
  const eurc = currency('EURC');
  const borrowed = 100_000_000n;
  const needed = await ethCall(pin, read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, eurc.marketId, borrowed]));
  const pledge = (needed * 105n) / 100n + 1n;
  const eurcAtPin = await ethCall(pin, balanceOf(C.EURC, PAYER));
  // The payer has borrowed 100 EURC and spent all their EURC, which is the situation a close with the other currency is for.
  const setup = [{
    ...payerTx([approve(C.CIRBTC, C.MORPHO, pledge), supplyCollateral(eurc, pledge), borrow(eurc, borrowed), transfer(C.EURC, PAYEE, eurcAtPin + borrowed)]),
  }];
  const stateReads = [
    read(C.MORPHO, morphoAbi, 'position', [eurc.marketId, PAYER]), read(C.MORPHO, morphoAbi, 'market', [eurc.marketId]),
    balanceOf(C.EURC, PAYER), balanceOf(C.CIRBTC, PAYER),
  ];
  const probe = await scenario(pin, { setup, pre: stateReads, tx: { from: READER, to: C.USDC, data: balanceOf(C.USDC, READER).data }, post: [] });
  const [position, market, eurcHeld] = probe.before;
  const shares = position[1];
  const collateral = position[2];
  const approval = closeApproval(shares, market[2], market[3]);
  const rate = await circleRate(C.USDC, C.EURC, 100_000_000n);
  const Y = BigInt(Math.ceil((Number(approval) / rate) * 1.004));
  const plan = await circlePlan({ tokenIn: C.USDC, tokenOut: C.EURC, amount: Y, stopLimit: approval });
  const floor = eurcHeld + approval;
  const calls = [
    approve(C.USDC, CIRCLE_ADAPTER, Y),
    planCall(plan, C.USDC, Y),
    transfer(C.EURC, PAYER, floor),
    approve(C.EURC, C.MORPHO, approval),
    call3(C.MORPHO, enc(morphoAbi, 'repay', [eurc.params, 0n, shares, PAYER, '0x'])),
    call3(C.MORPHO, enc(morphoAbi, 'withdrawCollateral', [eurc.params, collateral, PAYER, PAYER])),
    approve(C.EURC, C.MORPHO, 0n),
    approve(C.USDC, CIRCLE_ADAPTER, 0n),
  ];
  const reads = [
    read(C.MORPHO, morphoAbi, 'position', [eurc.marketId, PAYER]), balanceOf(C.CIRBTC, PAYER), balanceOf(C.EURC, PAYER), balanceOf(C.USDC, PAYER),
    allowanceOf(C.USDC, PAYER, CIRCLE_ADAPTER), allowanceOf(C.EURC, PAYER, CIRCLE_ADAPTER), allowanceOf(C.CIRBTC, PAYER, CIRCLE_ADAPTER),
    allowanceOf(C.EURC, PAYER, C.MORPHO),
  ];
  const run = await scenario(pin, { setup, pre: reads, tx: payerTx(calls), post: reads });
  const ep = plan.transaction.executionParams;
  if (!run.tx.ok) {
    record('F7', 'FAIL', `the close batch reverted: ${explain(run.tx.revertData)}`, [`loan ${tok('EURC', borrowed)}, ${btc(collateral)} pledged, close approval ${tok('EURC', approval)}, input ${usdc(Y)}`]);
    return;
  }
  const [posAfter, btcAfter, eurcAfter, usdcAfter, aUsdc, aEurc, aBtc, aMorpho] = run.after;
  const back = btcAfter - run.before[1];
  const ok = posAfter[1] === 0n && posAfter[2] === 0n && back === collateral && [aUsdc, aEurc, aBtc, aMorpho].every((a) => a === 0n);
  record('F7', ok ? 'PASS' : 'FAIL',
    `EURC loan closed with USDC through a real plan: debt ${posAfter[1]} shares, collateral ${posAfter[2]}, ${btc(back)} back to the payer, allowances adapter USDC/EURC/cirBTC and Morpho EURC ${aUsdc}/${aEurc}/${aBtc}/${aMorpho}, gas ${run.tx.gas}`,
    [
      `loan ${tok('EURC', borrowed)} (${shares} shares), ${btc(collateral)} pledged, close approval ${tok('EURC', approval)}; plan sells ${usdc(Y)} for at least ${tok('EURC', approval)}, quoted ${fmt6(BigInt(plan.estimatedAmount))} EURC, ${ep.instructions.length} instruction(s)`,
      `${calls.length} calls: approve USDC, execute, floor transfer on EURC (${tok('EURC', floor)} = held ${tok('EURC', eurcHeld)} + approval), approve Morpho, repay by shares, withdrawCollateral, approve Morpho 0, approve adapter 0`,
      `payer EURC after ${tok('EURC', eurcAfter)} (the spare from the buffer); payer USDC ${usdc(run.before[3])} -> ${usdc(usdcAfter)}`,
    ]);
}

// ---- F8: a 3 EURC bill paid from a USDC loan ----
async function reverseCheck() {
  const billAmount = 3_000_000n;
  const ctx = await prepareBillFromLoan({ loan: 'USDC', bill: 'EURC', billAmount, marginBps: 150 });
  if (ctx.free < ctx.X) {
    record('F8', 'SKIP', `a 3 EURC bill from a USDC loan: the USDC market has ${usdc(ctx.free)} free and the borrow needs ${usdc(ctx.X)}`);
    return;
  }
  const run = await runBillBatch(ctx, { withFloor: true });
  const r = readBill(run);
  const paid = run.tx.ok ? paidEvent(run.tx.logs, ctx.id) : null;
  const rise = run.tx.ok ? r.after.payee - r.before.payee : 0n;
  const allowances = run.tx.ok ? [r.after.aUsdc, r.after.aEurc, r.after.aBtc] : [];
  const ok = run.tx.ok && rise === billAmount && !!paid && r.after.ltv <= C.MAX_LTV_WAD && allowances.every((a) => a === 0n);
  record('F8', ok ? 'PASS' : 'FAIL',
    run.tx.ok
      ? `3 EURC bill paid from a USDC loan with a real Circle plan: payee +${tok('EURC', rise)}, BillPaid #${paid?.id ?? 'none'} by the payer, USDC loan-to-value ${(Number(r.after.ltv) / 1e16).toFixed(2)}%, adapter allowances ${allowances.join('/')}, gas ${run.tx.gas}`
      : `the batch reverted: ${explain(run.tx.revertData)}`,
    [
      `bill #${ctx.id}; borrow ${usdc(ctx.X)} (the USDC market had ${usdc(ctx.free)} free); pledge ${btc(ctx.pledge)}; ${describePlan(ctx)}`,
      `floor ${tok('EURC', ctx.floor)} = payer EURC ${tok('EURC', ctx.outBefore)} + bill ${tok('EURC', billAmount)}; no gas slack because the output is EURC`,
    ]);
}

// What the app's code works from, read the way the app reads it: the euro price AdagBills uses, through the same viem-shaped
// reads, here served by this script's own RPC helper so the 1.5 second spacing against dRPC still applies.
const appClient = {
  async getBlock() {
    const b = await rpc('eth_getBlockByNumber', ['latest', false]);
    return { number: BigInt(b.number), timestamp: BigInt(b.timestamp), baseFeePerGas: BigInt(b.baseFeePerGas) };
  },
  async readContract({ address, abi, functionName, args = [], blockNumber }) {
    const out = await rpc('eth_call', [{ to: address, data: enc(abi, functionName, args) }, blockNumber === undefined ? 'latest' : toHex(blockNumber)]);
    return decodeFunctionResult({ abi, functionName, data: out });
  },
};

// Transfers out of the payer in a batch's logs, for the report line: what the app's rule had to account for.
function outOfPayer(logs) {
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
  return logs.filter((l) => l.topics?.[0] === topic && l.topics.length >= 3 && isAddressEqual(`0x${l.topics[1].slice(26)}`, PAYER));
}

// ---- F9: the 100 USDC bill from a EURC loan, built by the app ----
async function appBillCheck() {
  const pin = await getPin();
  const eur = await readEurUsd(appClient);
  const eurc = currency('EURC');
  const usdcCur = currency('USDC');
  const id = (await ethCall(pin, read(C.ADAG_BILLS, adagAbi, 'billCount'))) + 1n;
  const ref = stringToHex('ADAG-FX-APP');
  const createBill = { from: PAYEE, to: C.ADAG_BILLS, data: enc(adagAbi, 'createBill', [usdcCur.address, AMOUNT, pin.timestamp + 7n * 86_400n, ref]), gas: 500_000n };
  const X = amountToSell(AMOUNT, 'USDC', eur.reading, 40n);
  const asked = await requestPlan({ tokenIn: C.EURC, amountIn: X, tokenOut: C.USDC, minOut: AMOUNT, account: PAYER });
  if (!asked.ok) throw new Error(`circle.ts returned its fixed sentence: ${asked.error}`);
  const tuple = await ethCall(pin, read(C.MORPHO, morphoAbi, 'idToMarketParams', [eurc.marketId]));
  const needed = await ethCall(pin, read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, eurc.marketId, X]));
  const outputBalance = await ethCall(pin, balanceOf(C.USDC, PAYER));
  const bill = { contract: C.ADAG_BILLS, id, payee: PAYEE, status: C.BILL_STATUS.Open, due: pin.timestamp + 7n * 86_400n, currency: C.USDC, createdAt: pin.timestamp, amount: AMOUNT, payer: getAddress('0x0000000000000000000000000000000000000000'), paidAt: 0n, ref };
  const built = buildPayConverted(bill, PAYER, {
    from: 'convert', loan: 'EURC', amountIn: X, pledge: suggestPledge(needed), marketParams: paramsFromTuple(tuple), plan: asked.plan.calldata,
    outputBalance, maxFeePerGas: pin.maxFee, chainTime: pin.timestamp, rate: eur.reading,
  });
  const ctx = { pin, loanCur: eurc, billCur: usdcCur, createBill };
  const tx = { from: PAYER, to: built.to, data: built.data, gas: built.conversion.gas, maxFeePerGas: built.conversion.maxFeePerGas };
  const run = await scenario(pin, { setup: [createBill], pre: billReads(ctx), tx, post: billReads(ctx), trace: true });
  if (!run.tx.ok) {
    record('F9', 'FAIL', `the app's batch reverted: ${explain(run.tx.revertData)}`, [`bill #${id}; borrow ${tok('EURC', X)}; ${built.calls.length} calls`]);
    return;
  }
  const r = readBill(run);
  let effectsLine;
  let effectsOk = true;
  try {
    checkEffects(run.tx.logs, built.conversion);
    effectsLine = `the app's effects rule accepted the simulation's logs: ${outOfPayer(run.tx.logs).length} transfers out of the payer, each one the pledge, the amount sold, the bill or the floor`;
  } catch (error) {
    effectsOk = false;
    effectsLine = `the app's effects rule REFUSED the simulation's logs: ${error.message}`;
  }
  const paid = paidEvent(run.tx.logs, id);
  const rise = r.after.payee - r.before.payee;
  const allowances = [r.after.aUsdc, r.after.aEurc, r.after.aBtc];
  const gasFits = (run.tx.gas * 125n) / 100n <= C.FX_GAS_CAP;
  const ok = rise === AMOUNT && !!paid && r.after.ltv <= C.MAX_LTV_WAD && allowances.every((a) => a === 0n) && effectsOk && gasFits;
  record('F9', ok ? 'PASS' : 'FAIL',
    `100 USDC bill paid from a EURC loan with the app's own build.ts, circle.ts, estimate.ts and plan.ts: payee +${usdc(rise)}, BillPaid #${paid?.id ?? 'none'} by the payer, EURC loan-to-value ${(Number(r.after.ltv) / 1e16).toFixed(2)}%, adapter allowances ${allowances.join('/')}, gas ${run.tx.gas} of the ${C.FX_GAS_CAP} cap`,
    [
      `bill #${id}; euro price ${Number(eur.reading.answer) / 10 ** eur.reading.decimals} (updated ${eur.chainTime - eur.reading.updatedAt} s before the block); sells ${tok('EURC', X)} (0.40% buffer), pledge ${btc(suggestPledge(needed))}; plan deadline ${asked.plan.deadline}`,
      `${built.calls.length} calls in one aggregate3 from build.ts; floor ${usdc(built.conversion.floor)} = balance ${usdc(outputBalance)} + bill ${usdc(AMOUNT)} - gas slack ${usdc(outputBalance + AMOUNT - built.conversion.floor)}`,
      effectsLine,
    ]);
}

// ---- F10: a EURC loan closed with USDC, built by the app ----
async function appCloseCheck() {
  const pin = await getPin();
  const eur = await readEurUsd(appClient);
  const eurc = currency('EURC');
  const borrowed = 100_000_000n;
  const needed = await ethCall(pin, read(C.ADAG_BILLS, adagAbi, 'collateralNeeded', [PAYER, eurc.marketId, borrowed]));
  const pledge = suggestPledge(needed);
  const eurcAtPin = await ethCall(pin, balanceOf(C.EURC, PAYER));
  const tuple = await ethCall(pin, read(C.MORPHO, morphoAbi, 'idToMarketParams', [eurc.marketId]));
  const setup = [{
    ...payerTx([approve(C.CIRBTC, C.MORPHO, pledge), supplyCollateral(eurc, pledge), borrow(eurc, borrowed), transfer(C.EURC, PAYEE, eurcAtPin + borrowed)]),
  }];
  const stateReads = [
    read(C.MORPHO, morphoAbi, 'position', [eurc.marketId, PAYER]), read(C.MORPHO, morphoAbi, 'market', [eurc.marketId]),
    balanceOf(C.EURC, PAYER), balanceOf(C.CIRBTC, PAYER),
  ];
  const probe = await scenario(pin, { setup, pre: stateReads, tx: { from: READER, to: C.USDC, data: balanceOf(C.USDC, READER).data }, post: [] });
  const [position, market, eurcHeld] = probe.before;
  const shares = position[1];
  const collateral = position[2];
  const approval = closeApproval(shares, market[2], market[3]);
  const Y = amountToSell(approval, 'EURC', eur.reading, 40n);
  const asked = await requestPlan({ tokenIn: C.USDC, amountIn: Y, tokenOut: C.EURC, minOut: approval, account: PAYER });
  if (!asked.ok) throw new Error(`circle.ts returned its fixed sentence: ${asked.error}`);
  const built = buildCloseWithOtherCurrency(PAYER, eurc, { shares, collateral }, approval, paramsFromTuple(tuple), {
    amountIn: Y, plan: asked.plan.calldata, outputBalance: eurcHeld, maxFeePerGas: pin.maxFee, chainTime: pin.timestamp, rate: eur.reading,
  });
  const reads = [
    read(C.MORPHO, morphoAbi, 'position', [eurc.marketId, PAYER]), balanceOf(C.CIRBTC, PAYER), balanceOf(C.EURC, PAYER), balanceOf(C.USDC, PAYER),
    allowanceOf(C.USDC, PAYER, CIRCLE_ADAPTER), allowanceOf(C.EURC, PAYER, CIRCLE_ADAPTER), allowanceOf(C.CIRBTC, PAYER, CIRCLE_ADAPTER),
    allowanceOf(C.EURC, PAYER, C.MORPHO),
  ];
  const tx = { from: PAYER, to: built.to, data: built.data, gas: built.conversion.gas, maxFeePerGas: built.conversion.maxFeePerGas };
  const run = await scenario(pin, { setup, pre: reads, tx, post: reads, trace: true });
  if (!run.tx.ok) {
    record('F10', 'FAIL', `the app's close batch reverted: ${explain(run.tx.revertData)}`, [`loan ${tok('EURC', borrowed)}, ${btc(collateral)} pledged, close approval ${tok('EURC', approval)}, input ${usdc(Y)}`]);
    return;
  }
  let effectsLine;
  let effectsOk = true;
  try {
    checkEffects(run.tx.logs, built.conversion);
    effectsLine = `the app's effects rule accepted the simulation's logs: ${outOfPayer(run.tx.logs).length} transfers out of the payer, each one the amount sold, the repayment or the floor`;
  } catch (error) {
    effectsOk = false;
    effectsLine = `the app's effects rule REFUSED the simulation's logs: ${error.message}`;
  }
  const [posAfter, btcAfter, eurcAfter, usdcAfter, aUsdc, aEurc, aBtc, aMorpho] = run.after;
  const back = btcAfter - run.before[1];
  const gasFits = (run.tx.gas * 125n) / 100n <= C.FX_GAS_CAP;
  const ok = posAfter[1] === 0n && posAfter[2] === 0n && back === collateral && [aUsdc, aEurc, aBtc, aMorpho].every((a) => a === 0n) && effectsOk && gasFits;
  record('F10', ok ? 'PASS' : 'FAIL',
    `EURC loan closed with USDC with the app's own build.ts, circle.ts, estimate.ts and plan.ts: debt ${posAfter[1]} shares, collateral ${posAfter[2]}, ${btc(back)} back to the payer, allowances adapter USDC/EURC/cirBTC and Morpho EURC ${aUsdc}/${aEurc}/${aBtc}/${aMorpho}, gas ${run.tx.gas} of the ${C.FX_GAS_CAP} cap`,
    [
      `loan ${tok('EURC', borrowed)} (${shares} shares), ${btc(collateral)} pledged, close approval ${tok('EURC', approval)}; sells ${usdc(Y)} (0.40% buffer over the euro price) for at least ${tok('EURC', approval)}; plan deadline ${asked.plan.deadline}`,
      `${built.calls.length} calls from build.ts; floor ${tok('EURC', built.conversion.floor)} = held ${tok('EURC', eurcHeld)} + approval ${tok('EURC', approval)}`,
      effectsLine,
      `payer EURC after ${tok('EURC', eurcAfter)} (the spare from the buffer); payer USDC ${usdc(run.before[3])} -> ${usdc(usdcAfter)}`,
    ]);
}

async function main() {
  const chainId = Number(await rpc('eth_chainId', []));
  if (chainId !== C.CHAIN_ID) throw new Error(`${SIM_RPC} reports chain ${chainId}, not Arc mainnet ${C.CHAIN_ID}.`);
  if (sourceHash !== fixtures.sourceSha256) throw new Error('fx-fixtures/fixtures.json was not built from the current FxFixtures.sol. Recompile it first.');
  const wrong = Object.entries(EXPECTED).filter(([name, value]) => String(C[name]).toLowerCase() !== value.toLowerCase());
  const head = await rpc('eth_getBlockByNumber', ['latest', false]);
  console.log(`check-fx: cross-currency guards on live Arc mainnet state (chain ${chainId}, latest block ${BigInt(head.number)}, base fee ${Number(BigInt(head.baseFeePerGas)) / 1e9} gwei).`);
  console.log(`Every step runs in eth_simulateV1 on dRPC with validation on. Nothing is signed or sent. Payer ${PAYER}, payee ${PAYEE}, adapter ${CIRCLE_ADAPTER}.`);
  console.log(`Gas for F1 to F8: limit ${GAS_LIMIT}, max fee ${FEE_HEADROOM_PCT}% of the base fee; F9 and F10 use the app's cap of ${C.FX_GAS_CAP} and the same fee. Test-only contracts built with solc ${fixtures.compiler.split('+')[0]}. Code addresses ${wrong.length ? `DIFFER from the list pinned in this script for ${wrong.map(([n]) => n).join(', ')} (the code's value is used)` : 'match the list pinned in this script'}.`);

  // The funding must read back exactly through the tokens' own balanceOf, or nothing below means anything.
  const qualifyPin = await getPin();
  if ((await rpc('eth_getCode', [PAYER, toHex(qualifyPin.number)])) !== '0x') throw new Error(`Payer ${PAYER} has code on Arc; these checks need a plain address.`);
  const usdcFunded = await ethCall(qualifyPin, balanceOf(C.USDC, PAYER));
  const btcFunded = await ethCall(qualifyPin, balanceOf(C.CIRBTC, PAYER));
  const usdcReal = await plainCall(qualifyPin, balanceOf(C.USDC, PAYER));
  const btcReal = await plainCall(qualifyPin, balanceOf(C.CIRBTC, PAYER));
  if (usdcFunded !== FUND_USDC || btcFunded !== FUND_BTC) {
    throw new Error(`The funding overrides did not take: balanceOf under them reads ${usdc(usdcFunded)} and ${btc(btcFunded)}, not ${usdc(FUND_USDC)} and ${btc(FUND_BTC)}. Nothing was checked.`);
  }
  console.log(`Payer ${PAYER}: no key, no code. Funded only by state overrides, in every read and every simulation:`);
  console.log(`  USDC ${usdc(FUND_USDC)}: the account's native balance set to ${FUND_USDC * UNIT} wei`);
  console.log(`  cirBTC ${btc(FUND_BTC)}: ${C.CIRBTC} storage slot ${fiatBalanceKey(PAYER)} (balances mapping at slot ${FIAT_BALANCES_SLOT})`);
  console.log(`  balanceOf under the overrides reads ${usdc(usdcFunded)} and ${btc(btcFunded)}; on the chain itself the payer holds ${usdc(usdcReal)} and ${btc(btcReal)}.`);
  console.log();

  const steps = [floorChecks, attackChecks, billFromLoanChecks, closeLoanCheck, reverseCheck, appBillCheck, appCloseCheck];
  for (const step of steps) {
    try {
      await step();
    } catch (error) {
      const ids = { floorChecks: 'F1/F2', attackChecks: 'F3/F4', billFromLoanChecks: 'F5/F6', closeLoanCheck: 'F7', reverseCheck: 'F8', appBillCheck: 'F9', appCloseCheck: 'F10' };
      record(ids[step.name], 'FAIL', `could not run: ${error?.shortMessage ?? error?.message ?? String(error)}`);
    }
  }

  const failed = results.filter((r) => r.status === 'FAIL').length;
  const skipped = results.filter((r) => r.status === 'SKIP').length;
  console.log();
  console.log(failed === 0 ? `ALL CHECKS PASSED (${results.filter((r) => r.status === 'PASS').length} pass, ${skipped} skipped)` : `${failed} CHECK(S) FAILED`);
  return failed === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (error) => {
    console.error(`\nSTOPPED: ${error?.shortMessage ?? error?.message ?? String(error)}`);
    process.exit(1);
  },
);
