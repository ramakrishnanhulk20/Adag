// Shared pieces for prove-it.mjs: the env reader, the two RPC clients, ABIs, call builders, event decoders and
// formatting. Nothing in this file signs a transaction; prove-it.mjs owns the one place that does.
import { existsSync, readFileSync } from 'node:fs';
import {
  createPublicClient, defineChain, http, parseAbi, encodeFunctionData, decodeFunctionResult, decodeEventLog,
  decodeErrorResult, formatUnits, hexToString, isAddress, getAddress, pad, stringToHex, toHex, parseGwei,
  keccak256, encodeAbiParameters,
} from 'viem';

export const CHAIN_ID = 5042;
export const WRITE_RPC = 'https://rpc.mainnet.arc.io';
// Circle's RPC does not serve eth_simulateV1, so the dry run simulates on dRPC's public endpoint.
export const SIM_RPC = 'https://rpc.drpc.mainnet.arc.io';
export const EXPLORER_TX = 'https://explorer.arc.io/tx/';

export const MORPHO = '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD';
export const MEMO = '0x5294E9927c3306DcBaDb03fe70b92e01cCede505';
export const M3F = '0x522fAf9A91c41c443c66765030741e4AaCe147D0';
export const USDC = '0x3600000000000000000000000000000000000000';
export const CIRBTC = '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0';
export const MARKET_USDC = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
// MARKET_USDC's own oracle, rate model and liquidation line. A second USDC/cirBTC market exists with other
// values, so the script checks every fetched field against these, not only the two tokens.
export const USDC_MARKET_ORACLE = '0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab';
export const USDC_MARKET_IRM = '0xF02615d094Fc02fC031C35fe705e175aA4653f20';
export const USDC_MARKET_LLTV = 860000000000000000n;
// The other USDC/cirBTC market on Morpho. Only --self-test reads it, to show the market check refuses it.
export const OTHER_USDC_CIRBTC_MARKET = '0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566';
// Only used when nothing is deployed yet: the dry run puts AdagBills' runtime code here inside the simulation.
export const PLACEHOLDER_ADAG = getAddress('0x000000000000000000000000000000000000ada9');

// Arc drops transactions priced under 20 gwei without an error, so this is a floor, never a target.
export const MIN_MAX_FEE = parseGwei('20');
export const PRIORITY_FEE = parseGwei('1');

export const arc = defineChain({
  id: CHAIN_ID,
  name: 'Arc',
  nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 },
  rpcUrls: { default: { http: [WRITE_RPC] } },
});

const ENV_PATH = new URL('../../../.env', import.meta.url);

// The public demo wallets from the first live run (deployments/prove-it-2026-09-25.md). Dry runs and the attack
// suite only read and simulate, so they need addresses, never keys.
export const DEMO_PAYER = getAddress('0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE');
export const DEMO_PAYEE = getAddress('0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B');

// Reads the named values when .env exists, without failing on missing names. Used where a public default is fine.
function readEnvIfPresent(names) {
  if (!existsSync(ENV_PATH)) return {};
  const wanted = new Set(names);
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    if (!wanted.has(name)) continue;
    const value = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
    if (value) out[name] = value;
  }
  return out;
}

// The payer and payee for a dry run: both from .env when set there, otherwise the public demo wallets.
export function dryRunAddresses() {
  const env = readEnvIfPresent(['DEPLOYER_ADDRESS', 'PAYEE_ADDRESS']);
  if (env.DEPLOYER_ADDRESS && env.PAYEE_ADDRESS) {
    return { payer: checkedAddress(env.DEPLOYER_ADDRESS, 'DEPLOYER_ADDRESS'), payee: checkedAddress(env.PAYEE_ADDRESS, 'PAYEE_ADDRESS'), fromEnv: true };
  }
  if (env.DEPLOYER_ADDRESS || env.PAYEE_ADDRESS) {
    throw new Error('.env sets only one of DEPLOYER_ADDRESS and PAYEE_ADDRESS. Set both, or neither to use the public demo wallets.');
  }
  return { payer: DEMO_PAYER, payee: DEMO_PAYEE, fromEnv: false };
}

export const demoWalletsNote = () =>
  `No DEPLOYER_ADDRESS or PAYEE_ADDRESS in .env, so using the public demo wallets: payer ${DEMO_PAYER}, payee ${DEMO_PAYEE}.`;

// Returns only the names asked for. Every other line of .env is skipped without being kept, so a key that was
// not requested never enters this process's memory. Missing or blank names fail loudly without echoing values.
export function readEnv(names) {
  if (!existsSync(ENV_PATH)) throw new Error('No .env file at the repo root.');
  const wanted = new Set(names);
  const out = {};
  for (const line of readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const name = line.slice(0, eq).trim();
    if (!wanted.has(name)) continue;
    out[name] = line.slice(eq + 1).trim().replace(/^["']|["']$/g, '');
  }
  const missing = names.filter((n) => !out[n]);
  if (missing.length) throw new Error(`.env is missing a value for: ${missing.join(', ')}`);
  return out;
}

export function checkedAddress(value, label) {
  if (!isAddress(value, { strict: false })) throw new Error(`${label} in .env is not a valid address.`);
  return getAddress(value);
}

const artifactUrl = new URL('../out/AdagBills.sol/AdagBills.json', import.meta.url);
// The ABI of the deployment recorded under "AdagBills" in arc-mainnet.json, the first one, from 25 September.
const publishedAbiUrl = new URL('../deployments/2026-09-25/AdagBills.abi.json', import.meta.url);
const deploymentUrl = new URL('../deployments/arc-mainnet.json', import.meta.url);

// A local arc-forge build when there is one; otherwise the ABI published beside the deployment, which is all a
// run against the live contract needs. deployedBytecode is null in that case.
export function loadAdagAbi() {
  if (existsSync(artifactUrl)) return JSON.parse(readFileSync(artifactUrl, 'utf8'));
  if (!existsSync(publishedAbiUrl)) {
    throw new Error('Neither a local build (packages/contracts/out) nor deployments/2026-09-25/AdagBills.abi.json was found.');
  }
  return { abi: JSON.parse(readFileSync(publishedAbiUrl, 'utf8')), deployedBytecode: null };
}

// Returns the deployed address, or null when the file does not exist yet. A file that exists but names another
// chain or holds a malformed address is an error, never a silent fallback to the injected code.
export function loadDeployment() {
  if (!existsSync(deploymentUrl)) return null;
  const d = JSON.parse(readFileSync(deploymentUrl, 'utf8'));
  if (d.chainId !== CHAIN_ID) throw new Error(`deployments/arc-mainnet.json names chain ${d.chainId}, not ${CHAIN_ID}.`);
  const address = d?.AdagBills?.address;
  if (!address || !isAddress(address, { strict: false })) throw new Error('deployments/arc-mainnet.json has no valid AdagBills.address.');
  return getAddress(address);
}

const mp = '(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)';
export const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'function balanceOf(address account) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
]);
export const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32 id) view returns ${mp}`,
  'function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)',
  'function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)',
  `function supplyCollateral(${mp} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function borrow(${mp} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
  `function repay(${mp} marketParams, uint256 assets, uint256 shares, address onBehalf, bytes data) returns (uint256, uint256)`,
  `function withdrawCollateral(${mp} marketParams, uint256 assets, address onBehalf, address receiver)`,
  'event Repay(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets, uint256 shares)',
  'event WithdrawCollateral(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets)',
]);
export const memoAbi = parseAbi([
  'function memo(address target, bytes data, bytes32 memoId, bytes memoData)',
  'event Memo(address indexed sender, address indexed target, bytes32 callDataHash, bytes32 indexed memoId, bytes memo, uint256 memoIndex)',
  'error MemoFailed(bytes returnData)',
]);
export const m3fAbi = parseAbi([
  'struct Call3 { address target; bool allowFailure; bytes callData; }',
  'struct Result { bool success; bytes returnData; }',
  'function aggregate3(Call3[] calls) returns (Result[] returnData)',
]);
export const oracleAbi = parseAbi([
  'function price() view returns (uint256)',
  'function BASE_FEED_1() view returns (address)',
  'function QUOTE_FEED_1() view returns (address)',
]);

// Arc's native balance is the USDC balance (18 decimals); this gives a simulated address some, nothing else.
export const nativeBalance = (address, wei) => ({ [address]: { balance: toHex(wei) } });

const mockOracleUrl = new URL('./mock/MockOracle.json', import.meta.url);
// Simulation only: runtime code for mock/MockOracle.sol with its three sentinels patched to a fixed price and
// the real oracle's feeds, so Adag's freshness check still reads the real Chainlink feeds.
export function mockOracleCode(price, baseFeed, quoteFeed) {
  const swap = (code, sentinel, value) => {
    if (code.split(sentinel).length !== 2) throw new Error(`MockOracle sentinel ${sentinel.slice(0, 8)} not found exactly once.`);
    return code.replace(sentinel, value);
  };
  let code = JSON.parse(readFileSync(mockOracleUrl, 'utf8')).deployedBytecode.toLowerCase();
  code = swap(code, '5eed'.repeat(16), price.toString(16).padStart(64, '0'));
  code = swap(code, 'b0'.repeat(20), baseFeed.slice(2).toLowerCase());
  code = swap(code, 'c0'.repeat(20), quoteFeed.slice(2).toLowerCase());
  return code;
}

export const enc = (abi, functionName, args = []) => encodeFunctionData({ abi, functionName, args });

// A read is { key, to, abi, fn, args }; a write is { to, data }.
export const read = (key, to, abi, fn, args = []) => ({ key, to, abi, fn, args, data: enc(abi, fn, args) });

export const calls = {
  transfer: (token, to, amount) => ({ to: token, data: enc(erc20Abi, 'transfer', [to, amount]) }),
  approve: (token, spender, amount) => ({ to: token, data: enc(erc20Abi, 'approve', [spender, amount]) }),
  supplyCollateral: (p, assets, onBehalf) => ({ to: MORPHO, data: enc(morphoAbi, 'supplyCollateral', [p, assets, onBehalf, '0x']) }),
  borrow: (p, assets, onBehalf, receiver) => ({ to: MORPHO, data: enc(morphoAbi, 'borrow', [p, assets, 0n, onBehalf, receiver]) }),
  repayShares: (p, shares, onBehalf) => ({ to: MORPHO, data: enc(morphoAbi, 'repay', [p, 0n, shares, onBehalf, '0x']) }),
  withdrawCollateral: (p, assets, onBehalf, receiver) => ({ to: MORPHO, data: enc(morphoAbi, 'withdrawCollateral', [p, assets, onBehalf, receiver]) }),
  memo: (inner, billId, refText) => ({ to: MEMO, data: enc(memoAbi, 'memo', [inner.to, inner.data, memoId(billId), stringToHex(refText)]) }),
  // allowFailure false on every step: one failing step reverts the whole batch, so nothing half-happens.
  batch: (steps) => ({ to: M3F, data: enc(m3fAbi, 'aggregate3', [steps.map((s) => ({ target: s.to, allowFailure: false, callData: s.data }))]) }),
};

export const memoId = (billId) => pad(toHex(billId), { size: 32 });

// Morpho's market id is keccak256 of the abi-encoded params (MarketParamsLib.id), so a match proves every field,
// oracle and rate model included, whatever the RPC that served them. Throws on any mismatch or malformed field.
export function verifyMarketParams(params, marketId) {
  let id;
  try {
    id = keccak256(encodeAbiParameters(
      [{ type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }],
      [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
    ));
  } catch {
    throw new Error(`Market params for ${marketId} are malformed; refusing to sign with them.`);
  }
  if (id.toLowerCase() !== marketId.toLowerCase()) {
    throw new Error(`Market params hash to ${id}, not ${marketId}; refusing to sign with them.`);
  }
}

// Belt and braces beside verifyMarketParams: the fetched fields must also equal the values written above.
export function assertUsdcMarketConstants(params) {
  const same = (a, b) => getAddress(a) === getAddress(b);
  if (!same(params.loanToken, USDC) || !same(params.collateralToken, CIRBTC) || !same(params.oracle, USDC_MARKET_ORACLE)
    || !same(params.irm, USDC_MARKET_IRM) || params.lltv !== USDC_MARKET_LLTV) {
    throw new Error(`Market params for ${MARKET_USDC} differ from the expected USDC market; refusing to sign with them.`);
  }
}

export const circle = createPublicClient({ chain: arc, transport: http(WRITE_RPC, { timeout: 60_000 }) });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SIM_SPACING_MS = 1_500;
const RATE_LIMIT_WAIT_MS = 5_000;
let lastSimAt = 0;

const isRateLimit = (status, err) =>
  status === 429 || /rate|limit|too many|exceeded/i.test(`${err?.message ?? ''} ${err?.code ?? ''}`);

async function drpc(method, params) {
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method, params });
  for (let attempt = 0; attempt < 2; attempt++) {
    const wait = lastSimAt + SIM_SPACING_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastSimAt = Date.now();
    const res = await fetch(SIM_RPC, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: AbortSignal.timeout(60_000),
    });
    let json = null;
    try { json = await res.json(); } catch {}
    if (json && !json.error && res.ok) return json.result;
    const err = json?.error ?? { message: `HTTP ${res.status}` };
    if (attempt === 0 && isRateLimit(res.status, err)) {
      await sleep(RATE_LIMIT_WAIT_MS);
      continue;
    }
    throw new Error(`dRPC ${method} failed: ${JSON.stringify(err)}`);
  }
}

export const simChainId = async () => Number(await drpc('eth_chainId', []));

// dRPC's own latest block, so a simulation pinned to it is sure to exist on the node that runs it.
export async function simHead() {
  const blk = await drpc('eth_getBlockByNumber', ['latest', false]);
  return { number: BigInt(blk.number), timestamp: BigInt(blk.timestamp) };
}

// blocks: [{ time, overrides?, calls: [{ from, to, data }] }]. When `inject` is set, AdagBills' runtime code is
// placed at the placeholder address in the first block. Any override lasts for the rest of the request.
export async function simulate(blocks, atBlock, inject) {
  const blockStateCalls = blocks.map((b, i) => {
    const out = { blockOverrides: { time: toHex(b.time) }, calls: b.calls.map((c) => ({ from: c.from, to: c.to, data: c.data })) };
    const overrides = { ...(i === 0 && inject ? { [inject.address]: { code: inject.code } } : {}), ...(b.overrides || {}) };
    if (Object.keys(overrides).length) out.stateOverrides = overrides;
    return out;
  });
  const result = await drpc('eth_simulateV1', [{ blockStateCalls, validation: false, traceTransfers: false }, toHex(atBlock)]);
  if (!Array.isArray(result) || result.length !== blocks.length) throw new Error('eth_simulateV1 returned an unexpected shape.');
  return result.map((blk) => blk.calls.map((c) => ({
    ok: c.status === '0x1',
    gas: BigInt(c.gasUsed),
    returnData: c.returnData,
    logs: c.logs || [],
    revertData: c.returnData && c.returnData !== '0x' ? c.returnData : c.error?.data,
  })));
}

let errorAbis = [memoAbi];
export const setAdagAbi = (abi) => { errorAbis = [abi, memoAbi]; };

// Names a revert, unwrapping Memo's MemoFailed so Adag's or Morpho's own reason shows through.
export function decodeRevert(data) {
  if (!data || data === '0x') return 'reverted with no reason';
  for (const abi of errorAbis) {
    try {
      const r = decodeErrorResult({ abi, data });
      if (r.errorName === 'MemoFailed') return `MemoFailed(${decodeRevert(r.args[0])})`;
      if (r.errorName === 'Error') return `"${r.args[0]}"`;
      if (r.errorName === 'Panic') return `Panic(0x${r.args[0].toString(16)})`;
      return `${r.errorName}(${(r.args || []).map(String).join(', ')})`;
    } catch {}
  }
  return `unknown error ${data.slice(0, 10)}`;
}

export function decodeRead(spec, returnData) {
  return decodeFunctionResult({ abi: spec.abi, functionName: spec.fn, data: returnData });
}

// Events are only trusted from the contract that is supposed to emit them; a look-alike log from any other
// address is ignored.
export function findEvent(logs, emitter, abi, eventName) {
  for (const log of logs) {
    if (log.address.toLowerCase() !== emitter.toLowerCase()) continue;
    try {
      const ev = decodeEventLog({ abi, data: log.data, topics: log.topics });
      if (ev.eventName === eventName) return ev.args;
    } catch {}
  }
  return null;
}

export const memoText = (hex) => {
  try { return hexToString(hex); } catch { return hex; }
};

// Morpho's SharesMathLib.toAssetsUp, so the close approves what Morpho will actually pull.
export const toAssetsUp = (shares, totalAssets, totalShares) => {
  const num = shares * (totalAssets + 1n);
  const den = totalShares + 1_000_000n;
  return (num + den - 1n) / den;
};

// Every base unit shown, so a result like +1.000000 reads as exact rather than rounded.
const fixed = (v, decimals) => {
  const [whole, frac = ''] = formatUnits(v, decimals).split('.');
  return `${whole}.${frac.padEnd(decimals, '0')}`;
};
export const usdc = (v) => `${fixed(v, 6)} USDC`;
export const btc = (v) => `${fixed(v, 8)} cirBTC`;
export const gasUsdc = (wei) => `${Number(formatUnits(wei, 18)).toFixed(6)} USDC`;
export const pct = (wad) => (wad === 2n ** 256n - 1n ? 'no collateral' : `${(Number(wad) / 1e16).toFixed(2)}%`);
export const signedUsdc = (v) => `${v >= 0n ? '+' : '-'}${fixed(v >= 0n ? v : -v, 6)} USDC`;
// Oracle price is loan-token base units per collateral base unit, times 1e36: 1e34 turns it into USDC per cirBTC.
export const btcPrice = (price) => `${(Number(price) / 1e34).toLocaleString('en-US', { maximumFractionDigits: 2 })} USDC per cirBTC`;
