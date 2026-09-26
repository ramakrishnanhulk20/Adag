// Proves AdagGuard on live Arc mainnet state: the demo payer sets a rule (act at 35%, bring it back to 30%) and
// approves 1 USDC, then a stranger calls protect, which repays just enough of the payer's real Morpho loan from
// the payer's own wallet to land at or under 30%, and a second call at the same price repays nothing.
//
//   node packages/contracts/prove-it/guard-prove.mjs
//
// Every step runs inside eth_simulateV1 on dRPC from one real mainnet block. Nothing is signed or sent and no
// key is read. Before AdagGuard is deployed, its runtime code from the local build (out-guard) is injected at
// the address a real deploy will give it; once deployments/adag-guard.arc-mainnet.json exists, the same run
// uses the live contract and injects nothing. The only other state override gives the simulated stranger some
// native USDC.
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAddress, getContractAddress, isAddress, keccak256, stringToHex } from 'viem';
import * as L from './lib.mjs';

export const DEPLOYER = getAddress('0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE');
export const WAD = 10n ** 18n;
export const MAX_UINT = 2n ** 256n - 1n;
export const STRANGER = getAddress(`0x${keccak256(stringToHex('adag guard stranger')).slice(-40)}`);
export const STRANGER_FUNDS = L.nativeBalance(STRANGER, 100n * 10n ** 18n);

const TRIGGER = 350000000000000000n;
const TARGET = 300000000000000000n;
const APPROVAL = 1_000000n;

export class Stop extends Error {}

const artifactUrl = new URL('../out-guard/AdagGuard.sol/AdagGuard.json', import.meta.url);
const guardRecordUrl = new URL('../deployments/adag-guard.arc-mainnet.json', import.meta.url);
const mainRecordUrl = new URL('../deployments/arc-mainnet.json', import.meta.url);

function recordedGuard() {
  const found = [];
  for (const url of [guardRecordUrl, mainRecordUrl]) {
    if (!existsSync(url)) continue;
    const d = JSON.parse(readFileSync(url, 'utf8'));
    if (!d.AdagGuard) continue;
    if (d.chainId !== L.CHAIN_ID) throw new Stop(`${fileURLToPath(url)} names chain ${d.chainId}, not ${L.CHAIN_ID}.`);
    if (!isAddress(d.AdagGuard.address ?? '', { strict: false })) throw new Stop(`${fileURLToPath(url)} has no valid AdagGuard.address.`);
    found.push({ address: getAddress(d.AdagGuard.address), day: String(d.AdagGuard.deployedAt ?? '').slice(0, 10), file: fileURLToPath(url) });
  }
  if (found.length === 2 && found[0].address !== found[1].address) {
    throw new Stop(`The two deployment records disagree on AdagGuard: ${found[0].address} and ${found[1].address}.`);
  }
  return found[0] ?? null;
}

function localArtifact() {
  if (!existsSync(artifactUrl)) return null;
  return JSON.parse(readFileSync(artifactUrl, 'utf8'));
}

// Where AdagGuard is, and what code the simulation uses there. Deployed: the recorded address, nothing injected.
// Not deployed: deploy.sh sends AdagBills with enrol first and deploy-guard.sh sends AdagGuard next, so while
// "AdagBillsEnrol" is missing from arc-mainnet.json the guard lands at the deployer's nonce plus one; after it,
// at the deployer's nonce itself.
export async function loadGuard() {
  const record = recordedGuard();
  if (record) {
    const code = await L.circle.getCode({ address: record.address });
    if (!code || code === '0x') throw new Stop(`${record.file} names ${record.address}, but there is no contract there on Arc mainnet.`);
    const abiUrl = new URL(`../deployments/${record.day}/AdagGuard.abi.json`, import.meta.url);
    const abi = existsSync(abiUrl) ? JSON.parse(readFileSync(abiUrl, 'utf8')) : localArtifact()?.abi;
    if (!abi) throw new Stop(`No ABI for the deployed AdagGuard: run bash packages/contracts/verify-guard.sh, which writes ${fileURLToPath(abiUrl)}.`);
    return { address: record.address, deployed: true, inject: null, abi, how: `AdagGuard at ${record.address} (from ${record.file}).` };
  }
  const artifact = localArtifact();
  if (!artifact?.deployedBytecode?.object) {
    throw new Stop('AdagGuard is not deployed and there is no local build to inject. Build it with bash packages/contracts/run-guard-tests.sh.');
  }
  const nonce = await L.circle.getTransactionCount({ address: DEPLOYER });
  const enrolDeployed = L.loadDeployment('AdagBillsEnrol') !== null;
  const guardNonce = BigInt(nonce + (enrolDeployed ? 0 : 1));
  const address = getContractAddress({ from: DEPLOYER, nonce: guardNonce });
  const code = await L.circle.getCode({ address });
  if (code && code !== '0x') {
    throw new Stop(`${address}, the predicted AdagGuard address (deployer nonce ${guardNonce}), already holds code, yet no record names AdagGuard. Check the deployer's history before trusting this prediction.`);
  }
  const order = enrolDeployed
    ? `AdagBills with enrol is already recorded, so AdagGuard takes the deployer's current nonce ${guardNonce}`
    : `nonce ${nonce} goes to AdagBills with enrol (not yet in arc-mainnet.json), so AdagGuard takes nonce ${guardNonce}`;
  return {
    address, deployed: false, abi: artifact.abi,
    inject: { address, code: artifact.deployedBytecode.object },
    how: `AdagGuard is not deployed yet, so its runtime code from out-guard/AdagGuard.sol is injected at ${address}: deployer ${DEPLOYER} is at nonce ${nonce}, and ${order}.`,
  };
}

// Morpho's own rounding, restated here so the checks do not lean on AdagGuard's maths.
export const debtUp = (shares, market) => (shares === 0n ? 0n : L.toAssetsUp(shares, market[2], market[3]));
export const debtDown = (shares, market) => (shares * (market[2] + 1n)) / (market[3] + 1_000_000n);
export function ltvOf(debt, collateral, price) {
  if (debt === 0n) return 0n;
  const value = (collateral * price) / 10n ** 36n;
  if (value === 0n) return MAX_UINT;
  return (debt * WAD + value - 1n) / value;
}

export function makeSim(pin, guard) {
  const from = (who, to, abi, fn, args = []) => ({ from: who, to, data: L.enc(abi, fn, args) });
  const g = (who, fn, args = []) => from(who, guard.address, guard.abi, fn, args);
  const run = (blocks) => L.simulate(blocks, pin.number, guard.inject);
  const t = (k) => pin.timestamp + BigInt(k);
  const outcome = (r) => (r.ok ? 'success' : L.decodeRevert(r.revertData));
  const decode = (abi, fn, r) => {
    if (!r.ok) throw new Stop(`${fn} failed: ${outcome(r)}`);
    return L.decodeRead({ abi, fn }, r.returnData);
  };
  return { from, g, run, t, outcome, decode };
}

// The pinned block, the verified USDC market, and the payer's loan in it.
export async function baseline(payer) {
  const chainId = await L.circle.getChainId();
  if (chainId !== L.CHAIN_ID) throw new Stop(`${L.WRITE_RPC} reports chain ${chainId}, not Arc mainnet ${L.CHAIN_ID}.`);
  const simChain = await L.simChainId();
  if (simChain !== L.CHAIN_ID) throw new Stop(`${L.SIM_RPC} reports chain ${simChain}, not Arc mainnet ${L.CHAIN_ID}.`);
  const pin = await L.simHead();
  const specs = [
    L.read('p', L.MORPHO, L.morphoAbi, 'idToMarketParams', [L.MARKET_USDC]),
    L.read('pos', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, payer]),
    L.read('market', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
    L.read('price', L.USDC_MARKET_ORACLE, L.oracleAbi, 'price'),
    L.read('baseFeed', L.USDC_MARKET_ORACLE, L.oracleAbi, 'BASE_FEED_1'),
    L.read('quoteFeed', L.USDC_MARKET_ORACLE, L.oracleAbi, 'QUOTE_FEED_1'),
    L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [payer]),
    L.read('btc', L.CIRBTC, L.erc20Abi, 'balanceOf', [payer]),
  ];
  const res = await L.simulate([{ time: pin.timestamp + 1n, calls: specs.map((s) => ({ from: payer, to: s.to, data: s.data })) }], pin.number, null);
  const b = { pin };
  specs.forEach((s, i) => {
    if (!res[0][i].ok) throw new Stop(`Reading ${s.fn} failed: ${L.decodeRevert(res[0][i].revertData)}`);
    b[s.key] = L.decodeRead(s, res[0][i].returnData);
  });
  b.params = { loanToken: b.p[0], collateralToken: b.p[1], oracle: b.p[2], irm: b.p[3], lltv: b.p[4] };
  L.verifyMarketParams(b.params, L.MARKET_USDC);
  L.assertUsdcMarketConstants(b.params);
  b.shares = b.pos[1];
  b.collateral = b.pos[2];
  b.debt = debtUp(b.shares, b.market);
  b.ltv = ltvOf(b.debt, b.collateral, b.price);
  return b;
}

const line = (s = '') => console.log(s);
// Every digit of an 18-decimal ratio as a percentage, so "at or under 30%" is visible without rounding.
export const exactPct = (wad) => {
  if (wad === MAX_UINT) return 'no collateral';
  const s = wad.toString().padStart(17, '0');
  return `${s.slice(0, -16) || '0'}.${s.slice(-16)}%`;
};
const gasOf = (r) => r.gas.toLocaleString('en-US').padStart(9);

async function main() {
  const wallets = L.dryRunAddresses();
  const payer = wallets.payer;
  const guard = await loadGuard();
  L.setAdagAbi(guard.abi);
  const b = await baseline(payer);
  const s = makeSim(b.pin, guard);
  const when = new Date(Number(b.pin.timestamp) * 1000).toISOString();

  line(`AdagGuard prove-it: DRY RUN on live Arc mainnet state (chain ${L.CHAIN_ID}, block ${b.pin.number}, ${when}).`);
  line('Every step runs in eth_simulateV1 on dRPC. Nothing is signed or sent, and no key is read.');
  line(guard.how);
  if (!wallets.fromEnv) line(L.demoWalletsNote());
  line();
  line('Starting state');
  line(`  payer ${payer}: loan ${L.usdc(b.debt)} against ${L.btc(b.collateral)} pledged, loan-to-value ${L.pct(b.ltv)}`);
  line(`  payer wallet: ${L.usdc(b.usdc)}, ${L.btc(b.btc)}`);
  line(`  BTC price ${L.btcPrice(b.price)}; Morpho liquidates this market at ${L.pct(b.params.lltv)}`);

  if (b.shares === 0n) throw new Stop('The payer has no USDC-market loan, so there is nothing for the guard to protect.');
  if (b.ltv < TRIGGER) throw new Stop(`The loan is at ${L.pct(b.ltv)}, under the 35% trigger, so the guard would rightly do nothing and this run would prove nothing.`);

  line();
  line('Plan');
  line(`  1. payer sets a rule on the USDC market: act at ${L.pct(TRIGGER)}, bring the loan back to ${L.pct(TARGET)}, no expiry`);
  line(`  2. payer approves AdagGuard for ${L.usdc(APPROVAL)}, the most it can ever take`);
  line(`  3. a stranger (${STRANGER}, no relation to the payer) reads quote, then calls protect`);
  line('  4. the stranger calls protect again at the same price');

  const snap = [
    L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [payer]),
    L.read('btc', L.CIRBTC, L.erc20Abi, 'balanceOf', [payer]),
    L.read('pos', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, payer]),
    L.read('market', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
    L.read('guardUsdc', L.USDC, L.erc20Abi, 'balanceOf', [guard.address]),
    L.read('guardToMorpho', L.USDC, L.erc20Abi, 'allowance', [guard.address, L.MORPHO]),
    L.read('payerToGuard', L.USDC, L.erc20Abi, 'allowance', [payer, guard.address]),
    L.read('price', L.USDC_MARKET_ORACLE, L.oracleAbi, 'price'),
  ];
  const asCalls = (specs) => specs.map((x) => ({ from: STRANGER, to: x.to, data: x.data }));
  const res = await s.run([
    { time: s.t(1), overrides: STRANGER_FUNDS, calls: [
      s.g(payer, 'setRule', [L.MARKET_USDC, TRIGGER, TARGET, 0n]),
      s.from(payer, L.USDC, L.erc20Abi, 'approve', [guard.address, APPROVAL]),
      s.g(payer, 'ruleOf', [payer, L.MARKET_USDC]),
    ] },
    { time: s.t(2), calls: [
      ...asCalls(snap),
      s.g(STRANGER, 'quote', [payer, L.MARKET_USDC]),
      s.g(STRANGER, 'protect', [payer, L.MARKET_USDC]),
      ...asCalls(snap),
    ] },
    { time: s.t(3), calls: [s.g(STRANGER, 'protect', [payer, L.MARKET_USDC]), ...asCalls(snap)] },
  ]);

  const [setRule, approve, ruleRead] = res[0];
  for (const [label, r] of [['setRule', setRule], ['approve', approve]]) {
    if (!r.ok) throw new Stop(`${label} would revert: ${s.outcome(r)}`);
  }
  const rule = s.decode(guard.abi, 'ruleOf', ruleRead);
  const ruleSet = L.findEvent(setRule.logs, guard.address, guard.abi, 'RuleSet');

  const n = snap.length;
  const readSnap = (results) => Object.fromEntries(snap.map((x, i) => [x.key, s.decode(x.abi, x.fn, results[i])]));
  const before = readSnap(res[1].slice(0, n));
  const [wouldAct, quoted, quotedLtv] = s.decode(guard.abi, 'quote', res[1][n]);
  const protect = res[1][n + 1];
  if (!protect.ok) throw new Stop(`protect would revert: ${s.outcome(protect)}`);
  const repaid = s.decode(guard.abi, 'protect', protect);
  const after = readSnap(res[1].slice(n + 2));
  const again = res[2][0];
  const repaidAgain = again.ok ? s.decode(guard.abi, 'protect', again) : null;
  const final = readSnap(res[2].slice(1));

  const event = L.findEvent(protect.logs, guard.address, guard.abi, 'Protected');
  const morphoRepay = L.findEvent(protect.logs, L.MORPHO, L.morphoAbi, 'Repay');
  const eventAgain = L.findEvent(again.logs ?? [], guard.address, guard.abi, 'Protected');

  const debtBefore = debtUp(before.pos[1], before.market);
  const debtAfter = debtUp(after.pos[1], after.market);
  const ltvBefore = ltvOf(debtBefore, before.pos[2], before.price);
  const ltvAfter = ltvOf(debtAfter, after.pos[2], after.price);
  const pulled = before.usdc - after.usdc;
  const btcBefore = before.btc + before.pos[2];
  const btcAfter = after.btc + after.pos[2];

  line();
  line('Running');
  line(`  tx 1 setRule 35% / 30% (payer)          gas ${gasOf(setRule)}`);
  line(`  tx 2 approve 1 USDC to AdagGuard (payer)  gas ${gasOf(approve)}`);
  line(`  quote (free read): would act ${wouldAct}, repay ${L.usdc(quoted)}, loan-to-value now ${L.pct(quotedLtv)}`);
  line(`  tx 3 protect (stranger)                 gas ${gasOf(protect)}   repaid ${L.usdc(repaid)}`);
  line(`  tx 4 protect again (stranger)           gas ${again.ok ? gasOf(again) : '        -'}   repaid ${repaidAgain === null ? s.outcome(again) : L.usdc(repaidAgain)}`);

  line();
  line('Receipt');
  if (event) line(`  Protected  borrower ${event.borrower}, repaid ${L.usdc(event.repaid)}, loan-to-value ${L.pct(event.ltvBeforeWad)} to ${L.pct(event.ltvAfterWad)}`);
  if (morphoRepay) line(`  Morpho Repay  caller ${morphoRepay.caller} (AdagGuard), on behalf of ${morphoRepay.onBehalf}, ${L.usdc(morphoRepay.assets)}, ${morphoRepay.shares} shares`);
  line(`  payer USDC        ${L.usdc(before.usdc)} before, ${L.usdc(after.usdc)} after (${L.signedUsdc(-pulled)})`);
  line(`  payer loan        ${L.usdc(debtBefore)} before, ${L.usdc(debtAfter)} after; loan-to-value ${L.pct(ltvBefore)} to ${L.pct(ltvAfter)} (exactly ${exactPct(ltvAfter)}, target ${exactPct(TARGET)})`);
  line(`  payer bitcoin     ${L.btc(btcBefore)} before, ${L.btc(btcAfter)} after (wallet plus pledged), sold ${L.btc(btcBefore - btcAfter)}`);
  line(`  payer approval    ${L.usdc(before.payerToGuard)} to AdagGuard before, ${L.usdc(after.payerToGuard)} after`);
  line(`  AdagGuard         holds ${L.usdc(before.guardUsdc)} before and ${L.usdc(after.guardUsdc)} after; its approval to Morpho ${L.usdc(before.guardToMorpho)} before and ${L.usdc(after.guardToMorpho)} after`);

  const checks = [
    ['the rule is stored as set, and RuleSet names the payer',
      rule.triggerWad === TRIGGER && rule.targetWad === TARGET && rule.expiry === 0n && ruleSet?.borrower === payer],
    [`quote says it would act, and by how much (${L.usdc(quoted)})`, wouldAct === true && quoted > 0n],
    ['protect by a stranger repaid exactly what quote said', repaid === quoted && event?.repaid === repaid],
    [`the loan-to-value landed at or under 30% (${L.pct(ltvAfter)}), and Protected reports the same`,
      ltvAfter <= TARGET && event?.ltvAfterWad === ltvAfter && event?.ltvBeforeWad === ltvBefore],
    ['the pull equals the repay: payer USDC fell by the repay, Morpho took exactly that for the payer',
      pulled === repaid && morphoRepay?.assets === repaid && morphoRepay?.onBehalf === payer && morphoRepay?.caller === guard.address],
    ['the payer\'s approval fell by exactly the repay', before.payerToGuard - after.payerToGuard === repaid],
    ['AdagGuard\'s USDC balance and its approval to Morpho are unchanged',
      after.guardUsdc === before.guardUsdc && after.guardToMorpho === before.guardToMorpho],
    ['bitcoin sold: 0 (wallet plus pledged is unchanged)', btcAfter === btcBefore],
    ['a second protect at the same price repays 0, emits nothing and moves no USDC',
      repaidAgain === 0n && !eventAgain && final.usdc === after.usdc],
  ];
  line();
  line('Checks');
  for (const [label, ok] of checks) line(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  const allOk = checks.every(([, ok]) => ok);
  line();
  line(allOk
    ? `PROVEN (dry run): a stranger's protect repaid ${L.usdc(repaid)} of the payer's own loan from the payer's own wallet, taking it from ${L.pct(ltvBefore)} to ${L.pct(ltvAfter)}, and no bitcoin was sold.`
    : 'NOT PROVEN: at least one check failed, see above.');
  return allOk ? 0 : 1;
}

const runDirectly = process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === resolve(process.argv[1]).toLowerCase();
if (runDirectly) {
  main().then(
    (code) => process.exit(code),
    (e) => {
      console.error(`\nSTOPPED: ${e instanceof Stop ? e.message : (e?.shortMessage ?? e?.message ?? String(e))}`);
      process.exit(1);
    },
  );
}
