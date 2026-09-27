// Proves AdagGuard on live Arc mainnet state: the demo payer sets a rule (act at 35%, bring it back to 30%) and
// approves 1 USDC, then a stranger calls protect, which repays just enough of the payer's real Morpho loan from
// the payer's own wallet to land at or under 30%, and a second call at the same price repays nothing.
//
//   node packages/contracts/prove-it/guard-prove.mjs              dry run on live mainnet state, sends nothing
//   node packages/contracts/prove-it/guard-prove.mjs --broadcast  the real thing, asks for a typed "yes" first
//   node packages/contracts/prove-it/guard-prove.mjs --clear      removes the payer's rule and sets the approval to 0
//   add --block N to the dry run to pin it to an earlier mainnet block; --help lists every option
//
// When the live loan is under 35% or over 40%, the dry run starts with a SIMULATED PREMISE block: the payer
// borrows or repays on Morpho to put the loan at 38.00% (see loanPremise). It is a step the payer really can
// take, printed as such, and it overrides no contract storage.
//
// The dry run: every step runs inside eth_simulateV1 on dRPC from one real mainnet block. Nothing is signed or
// sent and no key is read. Before AdagGuard is deployed, its runtime code from the local build (out-guard) is
// injected at the address a real deploy will give it; once deployments/adag-guard.arc-mainnet.json exists, the
// same run uses the live contract and injects nothing. The only other state override gives the simulated
// stranger some native USDC.
//
// --broadcast and --clear sign real transactions from the wallets in the repo .env: the payer is DEPLOYER_ADDRESS
// and the stranger that calls protect is PAYEE_ADDRESS. Each prints its plan and sends nothing until "yes" is
// typed; the keys are read only after that, only by name, and never printed. A real run writes its receipt to
// deployments/guard-prove-<date>.md.
import { appendFileSync, createReadStream, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWalletClient, getAddress, getContractAddress, http, isAddress, keccak256, stringToHex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as L from './lib.mjs';

export const DEPLOYER = getAddress('0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE');
export const WAD = 10n ** 18n;
export const MAX_UINT = 2n ** 256n - 1n;
export const STRANGER = getAddress(`0x${keccak256(stringToHex('adag guard stranger')).slice(-40)}`);
export const STRANGER_FUNDS = L.nativeBalance(STRANGER, 100n * 10n ** 18n);

const TRIGGER = 350000000000000000n;
const TARGET = 300000000000000000n;
const APPROVAL = 1_000000n;
// Above this the dry run also moves the loan to 38.00% first, so every run shows the same size of step.
const PREMISE_HIGH = 400000000000000000n;

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

export const PREMISE_LTV = 380000000000000000n;
const ceilDiv = (a, b) => (a + b - 1n) / b;

// SIMULATED PREMISE. Puts the payer's USDC-market loan at `level` with one action the payer really can take on
// Morpho: borrow more, or repay part. The amount follows Morpho's own rounding (shares minted rounded up on a
// borrow, burned rounded down on a repay, debt read back rounded up) on the pinned block's stored totals, so the
// loan lands at or just under the level; the seconds of interest before the simulated block move it far less
// than the 0.01% printed. `b` is what baseline() returns. The calls are sent from the payer; none is needed when
// the loan already sits exactly at the level.
export function loanPremise(b, payer, level = PREMISE_LTV) {
  if (b.shares === 0n || b.collateral === 0n) {
    throw new Stop('The payer has no USDC-market loan with collateral behind it, so no premise can place it at a level.');
  }
  const value = (b.collateral * b.price) / 10n ** 36n;
  const maxDebt = (value * level) / WAD;
  const P = b.market[2] + 1n;
  const Q = b.market[3] + 1_000_000n;
  const s = b.shares;
  const range = `taking the loan from ${L.pct(b.ltv)} to ${L.pct(level)}`;
  if (b.debt === maxDebt) return { kind: 'none', amount: 0n, calls: [], line: '' };
  if (b.debt < maxDebt) {
    const debtAfter = (x) => {
      const minted = ceilDiv(x * Q, P);
      return ceilDiv((s + minted) * (P + x), Q + minted);
    };
    let x = maxDebt - b.debt;
    while (x > 0n && debtAfter(x) > maxDebt) x -= 1n;
    return {
      kind: 'borrow', amount: x, calls: [L.calls.borrow(b.params, x, payer, payer)],
      line: `SIMULATED PREMISE: the payer borrows ${L.usdc(x)} more on Morpho, ${range}.`,
    };
  }
  const debtAfter = (x) => {
    const burned = (x * Q) / P;
    return burned >= s ? 0n : ceilDiv((s - burned) * (P - x), Q - burned);
  };
  let x = b.debt - maxDebt;
  while (debtAfter(x) > maxDebt) x += 1n;
  // Never past the debt rounded down, the most a repayment by amount can be without Morpho underflowing.
  const most = (s * P) / Q;
  if (x > most) x = most;
  return {
    kind: 'repay', amount: x,
    calls: [L.calls.approve(L.USDC, L.MORPHO, x), { to: L.MORPHO, data: L.enc(L.morphoAbi, 'repay', [b.params, x, 0n, payer, '0x']) }],
    line: `SIMULATED PREMISE: the payer repays ${L.usdc(x)} of the loan on Morpho, ${range}.`,
  };
}

// `prefix` blocks ({ calls, overrides? }) run first in every request, one second apart from the pinned block; the
// blocks a caller passes come after them, and only their results are returned. A prefix call that reverts stops
// the run, so no result ever rests on a premise that did not happen.
export function makeSim(pin, guard, prefix = []) {
  const from = (who, to, abi, fn, args = []) => ({ from: who, to, data: L.enc(abi, fn, args) });
  const g = (who, fn, args = []) => from(who, guard.address, guard.abi, fn, args);
  const lead = prefix.map((p, i) => ({ time: pin.timestamp + BigInt(i + 1), overrides: p.overrides, calls: p.calls }));
  const run = async (blocks) => {
    const res = await L.simulate([...lead, ...blocks], pin.number, guard.inject);
    lead.forEach((_, i) => {
      const bad = res[i].find((r) => !r.ok);
      if (bad) throw new Stop(`The simulated premise reverted: ${L.decodeRevert(bad.revertData)}`);
    });
    return res.slice(lead.length);
  };
  const t = (k) => pin.timestamp + BigInt(lead.length + k);
  const outcome = (r) => (r.ok ? 'success' : L.decodeRevert(r.revertData));
  const decode = (abi, fn, r) => {
    if (!r.ok) throw new Stop(`${fn} failed: ${outcome(r)}`);
    return L.decodeRead({ abi, fn }, r.returnData);
  };
  return { from, g, run, t, outcome, decode };
}

// The pinned block (dRPC's latest, or `atBlock` when given), the verified USDC market, and the payer's loan in it.
export async function baseline(payer, atBlock = null) {
  const chainId = await L.circle.getChainId();
  if (chainId !== L.CHAIN_ID) throw new Stop(`${L.WRITE_RPC} reports chain ${chainId}, not Arc mainnet ${L.CHAIN_ID}.`);
  const simChain = await L.simChainId();
  if (simChain !== L.CHAIN_ID) throw new Stop(`${L.SIM_RPC} reports chain ${simChain}, not Arc mainnet ${L.CHAIN_ID}.`);
  let pin;
  if (atBlock === null) {
    pin = await L.simHead();
  } else {
    const head = await L.simHead();
    if (atBlock > head.number) throw new Stop(`Block ${atBlock} is past the latest block dRPC has, ${head.number}.`);
    const blk = await L.circle.getBlock({ blockNumber: atBlock });
    pin = { number: blk.number, timestamp: blk.timestamp };
  }
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

async function dryRun(atBlock) {
  const wallets = L.dryRunAddresses();
  const payer = wallets.payer;
  const guard = await loadGuard();
  L.setAdagAbi(guard.abi);
  const b = await baseline(payer, atBlock);
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
  // The proof needs a loan at or over the 35% trigger and near it. When the live loan is elsewhere (the guard
  // itself brought it to 30% on 26 September), a first simulated block puts it at 38.00% with an ordinary Morpho
  // call from the payer. No storage of AdagGuard, Morpho or the oracle is overridden for it.
  const premise = b.ltv < TRIGGER || b.ltv > PREMISE_HIGH ? loanPremise(b, payer) : null;
  if (premise?.kind === 'repay' && b.usdc < premise.amount) {
    throw new Stop(`The loan is at ${L.pct(b.ltv)}; bringing it to ${L.pct(PREMISE_LTV)} needs a ${L.usdc(premise.amount)} repay, and the payer holds ${L.usdc(b.usdc)}.`);
  }
  const s = makeSim(b.pin, guard, premise?.calls.length ? [{ calls: premise.calls.map((c) => ({ from: payer, ...c })) }] : []);
  if (premise?.calls.length) {
    line();
    line(premise.line);
    line(`  The live loan is outside the 35% to 40% range this proof needs, so the first simulated block takes this ordinary`);
    line('  Morpho step as the payer. It is not on chain, and no contract storage is overridden for it.');
  }

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
    ? `PROVEN (dry run${premise?.calls.length ? ', after the simulated premise above' : ''}): a stranger's protect repaid ${L.usdc(repaid)} of the payer's own loan from the payer's own wallet, taking it from ${L.pct(ltvBefore)} to ${L.pct(ltvAfter)}, and no bitcoin was sold.`
    : 'NOT PROVEN: at least one check failed, see above.');
  return allOk ? 0 : 1;
}

// The live runs from here on. Payer gas is kept apart from the repay so the loan can always be paid down.
const MIN_PAYER_GAS = 50_000n;
const MIN_STRANGER_GAS_WEI = 10n ** 16n;
const reportUrl = (date) => new URL(`../deployments/guard-prove-${date}.md`, import.meta.url);

const HELP = `Usage: node packages/contracts/prove-it/guard-prove.mjs [option]

  (no option)    dry run on live Arc mainnet state, simulated on dRPC; sends nothing and reads no key. When the
                 demo loan is under 35% or over 40%, the first simulated block borrows or repays on Morpho as the
                 payer to put it at 38.00%, printed as a SIMULATED PREMISE line.
  --block N      the same dry run pinned to mainnet block N instead of the latest block.
  --broadcast    the real run: signs from DEPLOYER_ADDRESS and PAYEE_ADDRESS in .env after a typed yes. Refuses
                 when the live loan is under the 35% trigger.
  --clear        removes the payer's rule and sets its approval to AdagGuard to 0, after a typed yes.
  --help         this text.`;

function parseArgs(argv) {
  const out = { broadcast: false, clear: false, help: false, block: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--broadcast') out.broadcast = true;
    else if (a === '--clear') out.clear = true;
    else if (a === '--help' || a === '-h') out.help = true;
    else if (a === '--block' || a.startsWith('--block=')) {
      const v = a === '--block' ? argv[++i] : a.slice('--block='.length);
      if (!/^[0-9]+$/.test(v ?? '')) throw new Stop('--block needs a block number, for example --block 22867200.');
      out.block = BigInt(v);
    } else {
      throw new Stop(`Unknown option ${a}.\n\n${HELP}`);
    }
  }
  if (out.broadcast && out.clear) throw new Stop('--broadcast and --clear run separately.');
  if (out.block !== null && (out.broadcast || out.clear)) throw new Stop('--block pins the dry run only; --broadcast and --clear always act at the latest block.');
  return out;
}

// Same fee rule as prove-it.mjs: twice the base fee plus the tip, never under Arc's 20 gwei floor.
const feesFor = (baseFee) => {
  const doubled = 2n * baseFee + L.PRIORITY_FEE;
  return { maxFeePerGas: doubled > L.MIN_MAX_FEE ? doubled : L.MIN_MAX_FEE, maxPriorityFeePerGas: L.PRIORITY_FEE };
};

// Reads the answer from the terminal itself when there is one, so a piped stdin cannot answer for the person, and from
// stdin otherwise. Closed input counts as no.
function askYes(question) {
  let input = process.stdin;
  let fd = null;
  try {
    fd = openSync('/dev/tty', 'r');
    input = createReadStream(null, { fd });
  } catch {
    fd = null;
  }
  process.stdout.write(question);
  return new Promise((done) => {
    const rl = createInterface({ input, terminal: false });
    let answered = false;
    const finish = (answer) => {
      if (answered) return;
      answered = true;
      rl.close();
      if (fd !== null) input.destroy();
      if (!answer) process.stdout.write('\n');
      done(answer.trim() === 'yes');
    };
    rl.once('line', finish);
    rl.once('close', () => finish(''));
  });
}

// Keys are read only after the typed yes, only by name, and turned into signing accounts straight away. A key
// that does not produce its address in .env stops the run before anything is sent.
function loadSigners(roles) {
  const env = L.readEnv(roles.map((r) => r.keyName));
  const out = {};
  for (const { role, keyName, addrName, address } of roles) {
    const raw = env[keyName].startsWith('0x') ? env[keyName] : `0x${env[keyName]}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Stop(`${keyName} in .env is not a 32-byte hex key.`);
    let account;
    try { account = privateKeyToAccount(raw); } catch { throw new Stop(`${keyName} in .env is not a usable key.`); }
    if (account.address !== address) throw new Stop(`${keyName} does not belong to ${addrName}.`);
    out[role] = createWalletClient({ account, chain: L.arc, transport: http(L.WRITE_RPC, { timeout: 60_000 }) });
  }
  return out;
}

async function readAt(specs, blockNumber) {
  const out = {};
  for (const s of specs) {
    let data;
    try {
      ({ data } = await L.circle.call({ to: s.to, data: s.data, blockNumber }));
    } catch (e) {
      throw new Stop(`Reading ${s.fn} failed: ${L.decodeRevert(e?.cause?.data ?? e?.data)}`);
    }
    out[s.key] = L.decodeRead(s, data);
  }
  return out;
}

const liveSnap = (guard, payer) => [
  L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [payer]),
  L.read('btc', L.CIRBTC, L.erc20Abi, 'balanceOf', [payer]),
  L.read('pos', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, payer]),
  L.read('market', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
  L.read('price', L.USDC_MARKET_ORACLE, L.oracleAbi, 'price'),
  L.read('guardUsdc', L.USDC, L.erc20Abi, 'balanceOf', [guard.address]),
  L.read('guardToMorpho', L.USDC, L.erc20Abi, 'allowance', [guard.address, L.MORPHO]),
  L.read('payerToGuard', L.USDC, L.erc20Abi, 'allowance', [payer, guard.address]),
  L.read('rule', guard.address, guard.abi, 'ruleOf', [payer, L.MARKET_USDC]),
];

// Chain first, then the addresses from .env, then the recorded AdagGuard, then the market params proven against
// the fixed market id. Nothing here signs.
async function liveSetup(flag, needStranger) {
  const chainId = await L.circle.getChainId();
  if (chainId !== L.CHAIN_ID) throw new Stop(`${L.WRITE_RPC} reports chain ${chainId}, not Arc mainnet ${L.CHAIN_ID}. Nothing sent.`);
  const names = needStranger ? ['DEPLOYER_ADDRESS', 'PAYEE_ADDRESS'] : ['DEPLOYER_ADDRESS'];
  let env;
  try {
    env = L.readEnv(names);
  } catch (e) {
    throw new Stop(`${flag} signs real transactions on Arc mainnet, so it needs ${names.join(' and ')} and the matching private keys in .env at the repo root. ${e.message}`);
  }
  const payer = L.checkedAddress(env.DEPLOYER_ADDRESS, 'DEPLOYER_ADDRESS');
  const stranger = needStranger ? L.checkedAddress(env.PAYEE_ADDRESS, 'PAYEE_ADDRESS') : null;
  if (stranger === payer) throw new Stop('DEPLOYER_ADDRESS and PAYEE_ADDRESS are the same wallet; the protect must come from a second wallet.');
  const guard = await loadGuard();
  if (!guard.deployed) throw new Stop(`${flag} needs the deployed AdagGuard, and no deployment record names it yet. Nothing sent.`);
  L.setAdagAbi(guard.abi);
  const head = await L.circle.getBlock();
  const p = (await readAt([L.read('p', L.MORPHO, L.morphoAbi, 'idToMarketParams', [L.MARKET_USDC])], head.number)).p;
  const params = { loanToken: p[0], collateralToken: p[1], oracle: p[2], irm: p[3], lltv: p[4] };
  L.verifyMarketParams(params, L.MARKET_USDC);
  L.assertUsdcMarketConstants(params);
  return { payer, stranger, guard, head, params };
}

async function sendChecked(wallet, label, call) {
  let estimate;
  try {
    estimate = await L.circle.estimateGas({ account: wallet.account, to: call.to, data: call.data });
  } catch (e) {
    throw new Stop(`${label} would revert, so it was not sent: ${L.decodeRevert(e?.cause?.data ?? e?.data) || e.shortMessage}`);
  }
  const block = await L.circle.getBlock();
  const fees = feesFor(block.baseFeePerGas ?? 0n);
  const hash = await wallet.sendTransaction({ to: call.to, data: call.data, gas: (estimate * 125n) / 100n, ...fees });
  console.log(`  sent ${label}: ${L.EXPLORER_TX}${hash}`);
  const rc = await L.circle.waitForTransactionReceipt({ hash, timeout: 180_000 });
  if (rc.status !== 'success') throw new Stop(`${label} reverted on chain: ${L.EXPLORER_TX}${hash}`);
  if (getAddress(rc.from) !== wallet.account.address || getAddress(rc.to) !== getAddress(call.to)) {
    throw new Stop(`${label}: the receipt names ${rc.from} to ${rc.to}, not the wallet and target this script sent.`);
  }
  const blk = await L.circle.getBlock({ blockNumber: rc.blockNumber });
  return { label, hash, rc, block: rc.blockNumber, time: blk.timestamp, gas: rc.gasUsed, cost: rc.gasUsed * rc.effectiveGasPrice };
}

// quote at the protect's own moment: the parent block's state at the protect block's time, on dRPC.
async function quoteAt(guard, stranger, payer, parent, time) {
  for (let i = 0; i < 12 && (await L.simHead()).number < parent; i++) await new Promise((r) => setTimeout(r, 5_000));
  const res = await L.simulate([{ time, calls: [{ from: stranger, to: guard.address, data: L.enc(guard.abi, 'quote', [payer, L.MARKET_USDC]) }] }], parent, null);
  if (!res[0][0].ok) throw new Stop(`quote at block ${parent} failed: ${L.decodeRevert(res[0][0].revertData)}`);
  return L.decodeRead({ abi: guard.abi, fn: 'quote' }, res[0][0].returnData);
}

function writeReport(date, title, lines) {
  const file = reportUrl(date);
  if (!existsSync(file)) {
    writeFileSync(file, [
      `# AdagGuard live runs, ${date}`,
      '',
      'Written by `node packages/contracts/prove-it/guard-prove.mjs --broadcast` and `--clear` after real transactions on',
      'Arc mainnet. Every hash links to explorer.arc.io.',
      '',
    ].join('\n'));
  }
  appendFileSync(file, `\n## ${title}\n\n${lines.join('\n')}\n`);
  return fileURLToPath(file);
}

const txRow = (i, t) => `  tx ${i} ${t.label.padEnd(30)} block ${t.block}, gas ${t.gas.toLocaleString('en-US')}, cost ${L.gasUsdc(t.cost)}   ${L.EXPLORER_TX}${t.hash}`;

async function broadcastRun() {
  const { payer, stranger, guard, head, params } = await liveSetup('--broadcast', true);
  const s0 = await readAt(liveSnap(guard, payer), head.number);
  const strangerGas = await L.circle.getBalance({ address: stranger, blockNumber: head.number });
  const debt = debtUp(s0.pos[1], s0.market);
  const ltv = ltvOf(debt, s0.pos[2], s0.price);

  line(`AdagGuard prove-it: LIVE on Arc mainnet (chain ${L.CHAIN_ID}, block ${head.number}). AdagGuard at ${guard.address}.`);
  line();
  line('Starting state');
  line(`  payer ${payer}: loan ${L.usdc(debt)} against ${L.btc(s0.pos[2])} pledged, loan-to-value ${L.pct(ltv)}; wallet ${L.usdc(s0.usdc)}`);
  line(`  stranger ${stranger}: ${L.gasUsdc(strangerGas)} for gas`);
  line(`  BTC price ${L.btcPrice(s0.price)}; Morpho liquidates this market at ${L.pct(params.lltv)}`);
  line(`  payer's current approval to AdagGuard: ${L.usdc(s0.payerToGuard)}`);

  if (s0.rule.triggerWad !== 0n) {
    throw new Stop(`The payer already has a guard rule in the USDC market (${L.pct(s0.rule.triggerWad)} / ${L.pct(s0.rule.targetWad)}), so a second run would stack another approval on it. Run with --clear first. Nothing sent.`);
  }
  if (s0.pos[1] === 0n) throw new Stop('The payer has no USDC-market loan, so there is nothing to protect. Nothing sent.');
  if (ltv < TRIGGER) throw new Stop(`The payer's loan is at ${L.pct(ltv)} at block ${head.number}, under the 35% trigger, so the guard would rightly do nothing. Nothing sent. The dry run (no option) shows the same steps with a simulated premise that first puts the loan at 38.00%.`);

  // Rehearse the exact plan on dRPC first, as these two wallets, so the plan shows the amount it will repay.
  const pin = await L.simHead();
  const batch = L.calls.batch([
    { to: guard.address, data: L.enc(guard.abi, 'setRule', [L.MARKET_USDC, TRIGGER, TARGET, 0n]) },
    L.calls.approve(L.USDC, guard.address, APPROVAL),
  ]);
  const protectCall = { to: guard.address, data: L.enc(guard.abi, 'protect', [payer, L.MARKET_USDC]) };
  const rehearsal = await L.simulate([
    { time: pin.timestamp + 1n, calls: [{ from: payer, ...batch }] },
    { time: pin.timestamp + 2n, calls: [
      { from: stranger, to: guard.address, data: L.enc(guard.abi, 'quote', [payer, L.MARKET_USDC]) },
      { from: stranger, ...protectCall },
    ] },
    { time: pin.timestamp + 3n, calls: [{ from: stranger, ...protectCall }] },
  ], pin.number, null);
  const failed = [rehearsal[0][0], rehearsal[1][1], rehearsal[2][0]].find((r) => !r.ok);
  if (failed) throw new Stop(`The rehearsal on dRPC reverted: ${L.decodeRevert(failed.revertData)}. Nothing sent.`);
  const [wouldAct, expected] = L.decodeRead({ abi: guard.abi, fn: 'quote' }, rehearsal[1][0].returnData);
  if (!wouldAct) throw new Stop('In the rehearsal the guard would not act. Nothing sent.');
  if (s0.usdc < expected + MIN_PAYER_GAS) throw new Stop(`The payer holds ${L.usdc(s0.usdc)}; this run needs about ${L.usdc(expected + MIN_PAYER_GAS)} (the repay plus gas). Nothing sent.`);
  if (strangerGas < MIN_STRANGER_GAS_WEI) throw new Stop(`The stranger holds ${L.gasUsdc(strangerGas)}, under 0.01 USDC for gas. Nothing sent.`);
  const gasEstimate = rehearsal[0][0].gas + rehearsal[1][1].gas + rehearsal[2][0].gas;

  line();
  line('Plan (LIVE, real money)');
  line(`  1. payer signs ONE Multicall3From batch, both steps all-or-nothing:`);
  line(`       setRule on the USDC market: act at ${L.pct(TRIGGER)}, bring the loan back to ${L.pct(TARGET)}, no expiry`);
  line(`       approve AdagGuard for exactly ${L.usdc(APPROVAL)}, the most it can ever take`);
  line(`  2. stranger calls protect(payer, USDC market): about ${L.usdc(expected)} of the payer's loan is repaid from the payer's wallet`);
  line('  3. stranger calls protect again at the same price, which should repay 0');
  const likelyFee = (head.baseFeePerGas ?? 0n) + L.PRIORITY_FEE;
  line(`  Gas about ${gasEstimate.toLocaleString('en-US')} in all, split between the two wallets: about ${L.gasUsdc(gasEstimate * likelyFee)} at the current base fee plus the tip, at most ${L.gasUsdc(gasEstimate * feesFor(head.baseFeePerGas ?? 0n).maxFeePerGas)}.`);
  line('  Afterwards the rule and the unused approval stay; remove them with --clear.');

  if (!(await askYes('\nType yes to send these transactions on Arc mainnet: '))) {
    line('Cancelled. Nothing was sent, and no key was read.');
    return 1;
  }
  const w = loadSigners([
    { role: 'payer', keyName: 'DEPLOYER_PRIVATE_KEY', addrName: 'DEPLOYER_ADDRESS', address: payer },
    { role: 'stranger', keyName: 'PAYEE_PRIVATE_KEY', addrName: 'PAYEE_ADDRESS', address: stranger },
  ]);

  // Minutes may have passed at the prompt, so the two refusals are checked again at the latest block.
  const now = await L.circle.getBlockNumber();
  const s1 = await readAt(liveSnap(guard, payer), now);
  const ltvNow = ltvOf(debtUp(s1.pos[1], s1.market), s1.pos[2], s1.price);
  if (s1.rule.triggerWad !== 0n) throw new Stop('A rule appeared for the payer while waiting. Nothing sent.');
  if (ltvNow < TRIGGER) throw new Stop(`The loan fell to ${L.pct(ltvNow)} at block ${now}, under the trigger. Nothing sent.`);

  line();
  line('Running');
  L.verifyMarketParams(params, L.MARKET_USDC);
  const t1 = await sendChecked(w.payer, 'setRule and approve (payer)', batch);
  const ruleSet = L.findEvent(t1.rc.logs, guard.address, guard.abi, 'RuleSet');
  const afterRule = await readAt(liveSnap(guard, payer), t1.block);
  const t2 = await sendChecked(w.stranger, 'protect (stranger)', protectCall);
  const before = await readAt(liveSnap(guard, payer), t2.block - 1n);
  const after = await readAt(liveSnap(guard, payer), t2.block);
  const [qAct, quoted] = await quoteAt(guard, stranger, payer, t2.block - 1n, t2.time);
  const t3 = await sendChecked(w.stranger, 'protect again (stranger)', protectCall);
  const beforeAgain = await readAt([L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [payer])], t3.block - 1n);
  const afterAgain = await readAt([L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [payer])], t3.block);

  const event = L.findEvent(t2.rc.logs, guard.address, guard.abi, 'Protected');
  const morphoRepay = L.findEvent(t2.rc.logs, L.MORPHO, L.morphoAbi, 'Repay');
  const eventAgain = L.findEvent(t3.rc.logs, guard.address, guard.abi, 'Protected');
  const repayAgain = L.findEvent(t3.rc.logs, L.MORPHO, L.morphoAbi, 'Repay');
  const repaid = event?.repaid ?? 0n;
  const debtBefore = debtUp(before.pos[1], before.market);
  const debtAfter = debtUp(after.pos[1], after.market);
  const ltvBefore = ltvOf(debtBefore, before.pos[2], before.price);
  const ltvAfter = ltvOf(debtAfter, after.pos[2], after.price);
  const pulled = before.usdc - after.usdc;
  const btcBefore = before.btc + before.pos[2];
  const btcAfter = after.btc + after.pos[2];
  const txs = [t1, t2, t3];

  const receipt = [
    ...txs.map((t, i) => txRow(i + 1, t)),
    event ? `  Protected  borrower ${event.borrower}, repaid ${L.usdc(event.repaid)}, loan-to-value ${L.pct(event.ltvBeforeWad)} to ${L.pct(event.ltvAfterWad)}` : '  Protected  no event',
    morphoRepay ? `  Morpho Repay  caller ${morphoRepay.caller} (AdagGuard), on behalf of ${morphoRepay.onBehalf}, ${L.usdc(morphoRepay.assets)}, ${morphoRepay.shares} shares` : '  Morpho Repay  no event',
    `  quote for the protect block: would act ${qAct}, ${L.usdc(quoted)}`,
    `  payer USDC        ${L.usdc(before.usdc)} before, ${L.usdc(after.usdc)} after (${L.signedUsdc(-pulled)})`,
    `  payer loan        ${L.usdc(debtBefore)} before, ${L.usdc(debtAfter)} after; loan-to-value ${L.pct(ltvBefore)} to ${L.pct(ltvAfter)} (exactly ${exactPct(ltvAfter)}, target ${exactPct(TARGET)})`,
    `  payer bitcoin     ${L.btc(btcBefore)} before, ${L.btc(btcAfter)} after (wallet plus pledged), sold ${L.btc(btcBefore - btcAfter)}`,
    `  payer approval    ${L.usdc(before.payerToGuard)} to AdagGuard before, ${L.usdc(after.payerToGuard)} after`,
    `  AdagGuard         holds ${L.usdc(before.guardUsdc)} before and ${L.usdc(after.guardUsdc)} after; its approval to Morpho ${L.usdc(before.guardToMorpho)} before and ${L.usdc(after.guardToMorpho)} after`,
    `  gas               ${L.gasUsdc(txs.reduce((a, t) => a + t.cost, 0n))} paid in all`,
  ];
  const checks = [
    ['each transaction succeeded, from the expected wallet to the expected fixed address', true],
    ['the rule is stored as set, and RuleSet names the payer',
      afterRule.rule.triggerWad === TRIGGER && afterRule.rule.targetWad === TARGET && afterRule.rule.expiry === 0n && ruleSet?.borrower === payer],
    ['the approval to AdagGuard is exactly 1 USDC', afterRule.payerToGuard === APPROVAL],
    [`quote for the protect block says it would act, and by how much (${L.usdc(quoted)})`, qAct === true && quoted > 0n],
    ['protect by the stranger repaid exactly what quote said', repaid === quoted && repaid > 0n],
    [`the loan-to-value landed at or under 30% (${L.pct(ltvAfter)}), and Protected reports the same`,
      ltvAfter <= TARGET && event?.ltvAfterWad === ltvAfter && event?.ltvBeforeWad === ltvBefore],
    ['the pull equals the repay: payer USDC fell by the repay, Morpho took exactly that for the payer',
      pulled === repaid && morphoRepay?.assets === repaid && getAddress(morphoRepay?.onBehalf ?? '0x0000000000000000000000000000000000000000') === payer
        && getAddress(morphoRepay?.caller ?? '0x0000000000000000000000000000000000000000') === guard.address],
    ['the payer\'s approval fell by exactly the repay', before.payerToGuard - after.payerToGuard === repaid],
    ['AdagGuard\'s USDC balance and its approval to Morpho are unchanged',
      after.guardUsdc === before.guardUsdc && after.guardToMorpho === before.guardToMorpho],
    ['bitcoin sold: 0 (wallet plus pledged is unchanged)', btcAfter === btcBefore],
    ['a second protect at the same price repays 0, emits nothing and moves no USDC',
      !eventAgain && !repayAgain && beforeAgain.usdc === afterAgain.usdc],
  ];
  const allOk = checks.every(([, ok]) => ok);
  const verdict = allOk
    ? `PROVEN on Arc mainnet: a second wallet's protect repaid ${L.usdc(repaid)} of the payer's own loan from the payer's own wallet, taking it from ${L.pct(ltvBefore)} to ${L.pct(ltvAfter)}, and no bitcoin was sold.`
    : 'NOT PROVEN: at least one check failed, see above.';
  const checkLines = checks.map(([label, ok]) => `  ${ok ? 'PASS' : 'FAIL'}  ${label}`);

  line();
  line('Receipt');
  receipt.forEach((r) => line(r));
  line();
  line('Checks');
  checkLines.forEach((c) => line(c));
  line();
  line(verdict);
  const date = new Date(Number(t2.time) * 1000).toISOString().slice(0, 10);
  const file = writeReport(date, `Protect at block ${t2.block}`, [
    `AdagGuard ${guard.address}. Payer ${payer}, stranger ${stranger}. Rule 35% / 30%, approval ${L.usdc(APPROVAL)}.`,
    '', '```', ...receipt, '', ...checkLines, '```', '', verdict,
  ]);
  line(`Saved to ${file}`);
  line('Remove the rule and the unused approval with: node packages/contracts/prove-it/guard-prove.mjs --clear');
  return allOk ? 0 : 1;
}

async function clearRun() {
  const { payer, guard, head } = await liveSetup('--clear', false);
  const s0 = await readAt(liveSnap(guard, payer), head.number);
  const hasRule = s0.rule.triggerWad !== 0n;

  line(`AdagGuard prove-it --clear: LIVE on Arc mainnet (chain ${L.CHAIN_ID}, block ${head.number}). AdagGuard at ${guard.address}.`);
  line(`  payer ${payer}: rule ${hasRule ? `${L.pct(s0.rule.triggerWad)} / ${L.pct(s0.rule.targetWad)}` : 'none'} in the USDC market; approval to AdagGuard ${L.usdc(s0.payerToGuard)}`);
  if (!hasRule && s0.payerToGuard === 0n) {
    line('Nothing to clear: no rule and no approval. Nothing sent.');
    return 0;
  }
  const steps = [
    ...(hasRule ? [{ to: guard.address, data: L.enc(guard.abi, 'clearRule', [L.MARKET_USDC]) }] : []),
    L.calls.approve(L.USDC, guard.address, 0n),
  ];
  line();
  line('Plan (LIVE)');
  line('  payer signs ONE Multicall3From batch, every step all-or-nothing:');
  if (hasRule) line('       clearRule on the USDC market');
  line('       approve AdagGuard for 0 USDC');
  line('  No USDC moves apart from gas.');

  if (!(await askYes('\nType yes to send this transaction on Arc mainnet: '))) {
    line('Cancelled. Nothing was sent, and no key was read.');
    return 1;
  }
  const w = loadSigners([{ role: 'payer', keyName: 'DEPLOYER_PRIVATE_KEY', addrName: 'DEPLOYER_ADDRESS', address: payer }]);
  const s1 = await readAt(liveSnap(guard, payer), await L.circle.getBlockNumber());
  if ((s1.rule.triggerWad !== 0n) !== hasRule) throw new Stop('The rule changed while waiting. Nothing sent; run --clear again.');

  line();
  line('Running');
  const t = await sendChecked(w.payer, 'clearRule and approve 0 (payer)', L.calls.batch(steps));
  const after = await readAt(liveSnap(guard, payer), t.block);
  const cleared = L.findEvent(t.rc.logs, guard.address, guard.abi, 'RuleCleared');
  const checks = [
    ['the transaction succeeded, from the payer to Multicall3From', true],
    ['no rule is left for the payer in the USDC market', after.rule.triggerWad === 0n && after.rule.targetWad === 0n],
    ['RuleCleared names the payer (when there was a rule)', !hasRule || cleared?.borrower === payer],
    ['the payer\'s approval to AdagGuard is 0', after.payerToGuard === 0n],
  ];
  const checkLines = checks.map(([label, ok]) => `  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  const allOk = checks.every(([, ok]) => ok);
  line();
  line(txRow(1, t));
  checkLines.forEach((c) => line(c));
  line();
  line(allOk ? 'CLEARED: the payer has no guard rule and no approval to AdagGuard.' : 'NOT CLEARED: at least one check failed, see above.');
  const date = new Date(Number(t.time) * 1000).toISOString().slice(0, 10);
  line(`Saved to ${writeReport(date, `Clear at block ${t.block}`, ['```', txRow(1, t), '', ...checkLines, '```'])}`);
  return allOk ? 0 : 1;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    line(HELP);
    return 0;
  }
  if (args.broadcast) return broadcastRun();
  if (args.clear) return clearRun();
  return dryRun(args.block);
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
