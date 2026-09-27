// Tries to break AdagGuard on live Arc mainnet state and shows every attempt behaving as the threat model says
// (C34 to C41 as amended: a rule is trigger, target and expiry; the approval is the lifetime ceiling).
// Every attack runs inside eth_simulateV1 on dRPC from one real mainnet block, against the demo payer's real
// Morpho loan. Nothing is signed or sent, and no key is read.
//
//   node packages/contracts/prove-it/guard-attack.mjs
//
// Before AdagGuard is deployed its runtime code is injected at its predicted address, exactly as guard-prove.mjs
// explains; after the deploy the same run targets the live contract.
//
// Every row starts from the same SIMULATED PREMISE, run as the first block of every simulation and printed:
// the payer clears any live guard rule and approval it holds, then borrows or repays on Morpho so the loan sits
// at 38.00% (loanPremise in guard-prove.mjs). These are ordinary calls the payer really can make; no contract
// storage is overridden for them. State overrides are used for three things only: giving the simulated stranger
// some native USDC, topping the payer's wallet up to 1 USDC (labelled SIMULATED FUNDING) only if the premise
// leaves it under that, and in G8 and G9 a mock oracle at the market oracle's address, labelled as a simulated
// price crash to zero. AdagGuard and Morpho state are never overridden.
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getAddress, keccak256, parseAbi, stringToHex, toFunctionSelector } from 'viem';
import * as L from './lib.mjs';
import { PREMISE_LTV, STRANGER, STRANGER_FUNDS, Stop, baseline, debtDown, debtUp, loadGuard, loanPremise, ltvOf, makeSim } from './guard-prove.mjs';

const TRIGGER = 350000000000000000n;
const TARGET = 300000000000000000n;
const MU = L.MARKET_USDC;
// MARKET_USDC with its last hex digit changed: one character off, the kind of id a careless or hostile UI builds.
const LOOK_ALIKE = `${MU.slice(0, -1)}${MU.endsWith('d') ? 'e' : 'd'}`;
const NO_LOAN = getAddress(`0x${keccak256(stringToHex('adag guard wallet with no loan')).slice(-40)}`);

// lib.mjs's Morpho ABI has no accrueInterest; copied from morpho-blue v1.0.0 IMorpho.sol.
const accrueAbi = parseAbi(['function accrueInterest((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams)']);

const rows = [];
const ctx = {};

function row(id, attack, stopper, actual, pass) {
  rows.push({ id, attack, stopper, actual: actual.split(MU).join('MARKET_USDC').split(L.OTHER_USDC_CIRBTC_MARKET).join('OTHER_MARKET').split(LOOK_ALIKE).join('LOOK_ALIKE'), pass });
}

const bal = (who) => ctx.s.from(STRANGER, L.USDC, L.erc20Abi, 'balanceOf', [who]);
const allowance = (owner, spender) => ctx.s.from(STRANGER, L.USDC, L.erc20Abi, 'allowance', [owner, spender]);
const pos = (who) => ctx.s.from(STRANGER, L.MORPHO, L.morphoAbi, 'position', [MU, who]);
const mkt = () => ctx.s.from(STRANGER, L.MORPHO, L.morphoAbi, 'market', [MU]);
const rule = (trigger, target, expiry = 0n) => ctx.s.g(ctx.payer, 'setRule', [MU, trigger, target, expiry]);
const approve = (amount) => ctx.s.from(ctx.payer, L.USDC, L.erc20Abi, 'approve', [ctx.guard.address, amount]);
const protect = (who = ctx.payer, market = MU) => ctx.s.g(STRANGER, 'protect', [who, market]);
const quote = (who = ctx.payer, market = MU) => ctx.s.g(STRANGER, 'quote', [who, market]);
const num = (r) => ctx.s.decode(L.erc20Abi, 'balanceOf', r);
const repaidOf = (r) => (r.ok ? ctx.s.decode(ctx.guard.abi, 'protect', r) : null);
const quoteOf = (r) => ctx.s.decode(ctx.guard.abi, 'quote', r);
const out = (r) => ctx.s.outcome(r);
const protectedEvent = (r) => L.findEvent(r.logs ?? [], ctx.guard.address, ctx.guard.abi, 'Protected');
const crash = () => ({ [L.USDC_MARKET_ORACLE]: { code: L.mockOracleCode(0n, ctx.b.baseFeed, ctx.b.quoteFeed) } });

function setupOk(results, what) {
  const bad = results.find((r) => !r.ok);
  if (bad) throw new Stop(`setup (${what}) failed: ${out(bad)}`);
}

// An approval that never binds: twice this run's debt, and at least 1 USDC.
const fullApproval = () => (ctx.b.debt * 2n > 1_000000n ? ctx.b.debt * 2n : 1_000000n);

// Half of what the loan needs (G6 measures it first), so the approval, not the target, is what binds.
const halfNeed = () => (ctx.need > 1n ? ctx.need / 2n : 100_000n);

async function G1() {
  const cap = halfNeed();
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approve(cap), bal(ctx.payer)] },
    { time: ctx.s.t(2), calls: [quote(), protect(), bal(ctx.payer), allowance(ctx.payer, ctx.guard.address), bal(ctx.guard.address)] },
    { time: ctx.s.t(3), calls: [protect(), bal(ctx.payer)] },
  ]);
  setupOk(res[0].slice(0, 2), 'rule and a 0.1 USDC approval');
  const need = quoteOf(res[1][0])[1];
  const first = repaidOf(res[1][1]);
  const pulled = num(res[0][2]) - num(res[1][2]);
  const second = repaidOf(res[2][0]);
  row('G1', `Pull above the approval: the loan needs about ${L.usdc(ctxNeed())} but the payer approved only ${L.usdc(cap)}; protect twice`,
    'the approval is the lifetime ceiling (C38 as amended); protect caps at the allowance (C36)',
    `first protect ${first === null ? out(res[1][1]) : `repaid ${L.usdc(first)}`}, pulled ${L.usdc(pulled)}, approval left ${L.usdc(num(res[1][3]))}; second protect ${second === null ? out(res[2][0]) : `repaid ${L.usdc(second)}`}; guard holds ${L.usdc(num(res[1][4]))}`,
    need === cap && first === cap && pulled === cap && num(res[1][3]) === 0n && second === 0n && num(res[2][1]) === num(res[1][2]) && num(res[1][4]) === 0n);
}

// The amount the payer's loan needs to reach the target, from quote with a full approval. Used for labels only.
function ctxNeed() {
  return ctx.need ?? 0n;
}

async function G2() {
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approve(fullApproval())] },
    { time: ctx.s.t(2), calls: [
      protect(ctx.payer, L.OTHER_USDC_CIRBTC_MARKET),
      ctx.s.g(ctx.payer, 'setRule', [LOOK_ALIKE, TRIGGER, TARGET, 0n]),
      protect(ctx.payer, LOOK_ALIKE),
      bal(ctx.payer),
      protect(ctx.payer, L.MARKET_EURC),
      bal(ctx.payer),
    ] },
  ]);
  setupOk(res[0], 'rule and approval');
  const [other, setLook, protLook, balBefore, eurc, balAfter] = res[1];
  row('G2a', 'protect the payer\'s loan through the other real USDC/cirBTC market on Morpho (same tokens, different oracle and rate model)',
    'AdagGuard accepts only its two fixed market ids and checks their params on Morpho (C35, C41)',
    out(other), !other.ok && out(other) === `BadMarket(${L.OTHER_USDC_CIRBTC_MARKET})`);
  row('G2b', 'Set a rule, then call protect, with a look-alike id one hex digit away from MARKET_USDC',
    'same fixed-id check: a near miss is a different id',
    `setRule: ${out(setLook)}; protect: ${out(protLook)}`,
    !setLook.ok && out(setLook) === `BadMarket(${LOOK_ALIKE})` && !protLook.ok && out(protLook) === `BadMarket(${LOOK_ALIKE})`);
  const eurcRepaid = repaidOf(eurc);
  row('G2c', 'protect the payer in the EURC market, where they hold a USDC approval but have no loan and no rule',
    'each market repays only in its own loan token, and only a real, triggered rule acts (C35, C36)',
    `${eurcRepaid === null ? out(eurc) : `repaid ${L.usdc(eurcRepaid)}`}; payer USDC moved ${L.usdc(num(balBefore) - num(balAfter))}`,
    eurcRepaid === 0n && num(balBefore) === num(balAfter));
}

async function G3() {
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(500000000000000000n, 400000000000000000n), approve(fullApproval()), bal(ctx.payer)] },
    { time: ctx.s.t(2), calls: [quote(), protect(), bal(ctx.payer)] },
  ]);
  setupOk(res[0].slice(0, 2), 'a 50% / 40% rule');
  const [wouldAct, amount, ltv] = quoteOf(res[1][0]);
  const repaid = repaidOf(res[1][1]);
  row('G3', `A stranger calls protect while the loan (${L.pct(ltv)}) is under the payer's 50% trigger`,
    'protect acts only at or above the trigger; otherwise nothing moves and nothing is emitted (C36)',
    `quote would act ${wouldAct} (${L.usdc(amount)}); protect ${repaid === null ? out(res[1][1]) : `repaid ${L.usdc(repaid)}`}, event ${protectedEvent(res[1][1]) ? 'emitted' : 'none'}`,
    !wouldAct && amount === 0n && repaid === 0n && !protectedEvent(res[1][1]) && num(res[0][2]) === num(res[1][2]));
}

async function G4() {
  const expiry = ctx.s.t(1) + 60n;
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET, expiry), approve(fullApproval()), quote(), bal(ctx.payer)] },
    { time: expiry, calls: [quote(), protect(), bal(ctx.payer)] },
  ]);
  setupOk(res[0].slice(0, 2), 'a rule that expires in 60 seconds');
  const early = quoteOf(res[0][2]);
  const late = quoteOf(res[1][0]);
  const repaid = repaidOf(res[1][1]);
  row('G4', 'The payer\'s rule expires 60 seconds after it is set; a stranger calls protect at the expiry second',
    'an expired rule is inert (C41)',
    `before expiry quote would act ${early[0]} (${L.usdc(early[1])}); at expiry quote would act ${late[0]}, protect ${repaid === null ? out(res[1][1]) : `repaid ${L.usdc(repaid)}`}`,
    early[0] === true && late[0] === false && repaid === 0n && num(res[0][3]) === num(res[1][2]));
}

async function G5() {
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET)] },
    { time: ctx.s.t(2), calls: [
      ctx.s.g(STRANGER, 'clearRule', [MU]),
      ctx.s.g(STRANGER, 'setRule', [MU, 800000000000000000n, 10000000000000000n, 0n]),
      ctx.s.g(STRANGER, 'ruleOf', [ctx.payer, MU]),
      ctx.s.g(STRANGER, 'ruleOf', [STRANGER, MU]),
    ] },
  ]);
  setupOk(res[0], 'payer rule');
  const [clear, set, payerRule, strangerRule] = res[1];
  const pr = ctx.s.decode(ctx.guard.abi, 'ruleOf', payerRule);
  const sr = ctx.s.decode(ctx.guard.abi, 'ruleOf', strangerRule);
  const intact = pr.triggerWad === TRIGGER && pr.targetWad === TARGET && pr.expiry === 0n;
  row('G5a', 'A stranger clears the payer\'s rule', 'rules are keyed by the sender; nobody can name another wallet (C34)',
    `${out(clear)}; payer's rule still ${L.pct(pr.triggerWad)} / ${L.pct(pr.targetWad)}`,
    !clear.ok && out(clear) === `NoRule(${STRANGER}, ${MU})` && intact);
  row('G5b', 'A stranger sets a rule (80% / 1%) hoping it lands on the payer', 'same: setRule writes only the sender\'s own rule (C34)',
    `${out(set)}; payer's rule still ${L.pct(pr.triggerWad)} / ${L.pct(pr.targetWad)}; the stranger's own rule is ${L.pct(sr.triggerWad)} / ${L.pct(sr.targetWad)}`,
    set.ok && intact && sr.triggerWad === 800000000000000000n && sr.targetWad === 10000000000000000n);
}

async function G6() {
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approve(fullApproval()), quote()] },
    { time: ctx.s.t(2), calls: [protect(), protect(), bal(ctx.payer)] },
    { time: ctx.s.t(3), calls: [protect(), bal(ctx.payer)] },
  ]);
  setupOk(res[0].slice(0, 2), 'rule and approval');
  ctx.need = quoteOf(res[0][2])[1];
  const a = repaidOf(res[1][0]);
  const b = repaidOf(res[1][1]);
  const c = repaidOf(res[2][0]);
  row('G6', 'Protect three times at the same price: twice in one block, once in the next',
    'each protect repays only what brings the loan back to the target, so a repeat finds nothing to do (C38 as amended)',
    `repaid ${[a, b, c].map((x) => (x === null ? 'reverted' : L.usdc(x))).join(', then ')}`,
    a === ctx.need && a > 0n && b === 0n && c === 0n && num(res[1][2]) === num(res[2][1]));
}

async function G7() {
  const keep = halfNeed();
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approve(fullApproval())] },
    { time: ctx.s.t(2), calls: [ctx.s.from(ctx.payer, L.USDC, L.erc20Abi, 'transfer', [L.DEMO_PAYEE, ctx.b.usdc - keep]), bal(ctx.payer)] },
    { time: ctx.s.t(3), calls: [protect(), bal(ctx.payer), bal(ctx.guard.address)] },
  ]);
  setupOk([...res[0], res[1][0]], 'rule, approval, and the payer moving most of its USDC away');
  const repaid = repaidOf(res[2][0]);
  row('G7', `The payer's wallet holds only ${L.usdc(num(res[1][1]))} when the loan needs about ${L.usdc(ctxNeed())}`,
    'protect never pulls more than the wallet holds, and does not revert (C36)',
    `${repaid === null ? out(res[2][0]) : `repaid ${L.usdc(repaid)}`}; wallet now ${L.usdc(num(res[2][1]))}; guard holds ${L.usdc(num(res[2][2]))}`,
    num(res[1][1]) === keep && repaid === keep && num(res[2][1]) === 0n && num(res[2][2]) === 0n);
}

// SIMULATED PRICE CRASH TO ZERO: mock/MockOracle.sol sits at the market oracle's address from the second block on.
async function G8() {
  // Twice the debt: enough that only the debt rounded down can bind.
  const approval = ctx.b.debt * 2n;
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [rule(TRIGGER, TARGET), approve(approval)] },
    { time: ctx.s.t(2), overrides: crash(), calls: [
      ctx.s.from(STRANGER, L.MORPHO, accrueAbi, 'accrueInterest', [ctx.b.params]),
      pos(ctx.payer), mkt(), quote(), protect(), pos(ctx.payer), mkt(), bal(ctx.guard.address),
    ] },
  ]);
  setupOk(res[0], `rule and a ${L.usdc(approval)} approval`);
  if (!res[1][0].ok) throw new Stop(`accrueInterest failed: ${out(res[1][0])}`);
  const p0 = ctx.s.decode(L.morphoAbi, 'position', res[1][1]);
  const m0 = ctx.s.decode(L.morphoAbi, 'market', res[1][2]);
  const cap = debtDown(p0[1], m0);
  const [wouldAct, quoted, ltv] = quoteOf(res[1][3]);
  const repaid = repaidOf(res[1][4]);
  const left = res[1][5].ok && res[1][6].ok
    ? debtUp(ctx.s.decode(L.morphoAbi, 'position', res[1][5])[1], ctx.s.decode(L.morphoAbi, 'market', res[1][6]))
    : null;
  row('G8', `SIMULATED PRICE CRASH TO ZERO (mock oracle): protect with a ${L.usdc(approval)} approval against a ${L.usdc(debtUp(p0[1], m0))} loan`,
    'the repay is capped at the debt rounded down, so Morpho\'s share maths cannot underflow; no revert (C36, C37)',
    `quote ${wouldAct} at ${L.pct(ltv)}, ${L.usdc(quoted)}; protect ${repaid === null ? out(res[1][4]) : `repaid ${L.usdc(repaid)}`} against a rounded-down debt of ${L.usdc(cap)}; debt left ${left === null ? '?' : L.usdc(left)}; guard holds ${L.usdc(num(res[1][7]))}`,
    wouldAct && quoted === cap && repaid === cap && left !== null && left <= 1n && num(res[1][7]) === 0n);
}

async function G9() {
  const res = await ctx.s.run([
    { time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: [approve(1_000000n), bal(ctx.payer)] },
    { time: ctx.s.t(2), overrides: crash(), calls: [quote(), protect(), bal(ctx.payer), protect(NO_LOAN), quote(NO_LOAN)] },
  ]);
  setupOk(res[0].slice(0, 1), '1 USDC approval, no rule');
  const [wouldAct, amount, ltv] = quoteOf(res[1][0]);
  const repaid = repaidOf(res[1][1]);
  row('G9a', 'SIMULATED PRICE CRASH TO ZERO: protect a payer who approved 1 USDC but never set a rule',
    'no rule, no action, even at a zero price (C36, C41)',
    `quote would act ${wouldAct} at ${L.pct(ltv)} (${L.usdc(amount)}); protect ${repaid === null ? out(res[1][1]) : `repaid ${L.usdc(repaid)}`}; payer USDC moved ${L.usdc(num(res[0][1]) - num(res[1][2]))}`,
    !wouldAct && amount === 0n && repaid === 0n && num(res[0][1]) === num(res[1][2]));
  const none = repaidOf(res[1][3]);
  const q = quoteOf(res[1][4]);
  row('G9b', `protect a wallet with no loan and no rule (${NO_LOAN})`, 'nothing to repay, nothing moves (C36)',
    `${none === null ? out(res[1][3]) : `repaid ${L.usdc(none)}`}; quote would act ${q[0]}`, none === 0n && !q[0]);
}

// C39: no privileged role. The ABI's state-changing functions are exactly the three a borrower and a keeper need,
// and the admin calls a drain would use do not exist in the code at all.
async function G10() {
  const writes = ctx.guard.abi.filter((e) => e.type === 'function' && !['view', 'pure'].includes(e.stateMutability)).map((e) => e.name).sort();
  const hasFallback = ctx.guard.abi.some((e) => e.type === 'fallback' || e.type === 'receive');
  const tries = ['transferOwnership(address)', 'withdraw(address,uint256)', 'rescue(address,address,uint256)', 'pause()', 'upgradeToAndCall(address,bytes)'];
  const res = await ctx.s.run([{ time: ctx.s.t(1), overrides: STRANGER_FUNDS, calls: tries.map((sig) => ({
    from: STRANGER, to: ctx.guard.address, data: `${toFunctionSelector(sig)}${'00'.repeat(96)}`,
  })) }]);
  const refused = res[0].every((r) => !r.ok);
  row('G10', `Call admin functions a drain would need: ${tries.join(', ')}`,
    'no owner, pause, rescue or upgrade exists; only setRule, clearRule and protect change state (C39)',
    `state-changing functions: ${writes.join(', ')}; fallback or receive: ${hasFallback ? 'yes' : 'none'}; admin calls: ${refused ? 'all reverted' : 'SOME SUCCEEDED'}`,
    writes.join(',') === 'clearRule,protect,setRule' && !hasFallback && refused);
}

// The shared SIMULATED PREMISE, run as the first block of every row's simulation: the payer clears any live guard
// rule and approval, then borrows or repays on Morpho to put the loan at 38.00%. Sets ctx.s and moves ctx.b to
// the state every row starts from. Returns the lines to print.
async function setPremise() {
  const b = ctx.b;
  const probe = makeSim(b.pin, ctx.guard);
  const reads = await probe.run([{ time: probe.t(1), calls: [
    probe.g(STRANGER, 'ruleOf', [ctx.payer, MU]),
    probe.from(STRANGER, L.USDC, L.erc20Abi, 'allowance', [ctx.payer, ctx.guard.address]),
  ] }]);
  const liveRule = probe.decode(ctx.guard.abi, 'ruleOf', reads[0][0]);
  const liveApproval = probe.decode(L.erc20Abi, 'allowance', reads[0][1]);

  const calls = [];
  const lines = [];
  const hasRule = liveRule.triggerWad !== 0n;
  if (hasRule) calls.push(probe.g(ctx.payer, 'clearRule', [MU]));
  if (liveApproval !== 0n) calls.push(probe.from(ctx.payer, L.USDC, L.erc20Abi, 'approve', [ctx.guard.address, 0n]));
  if (calls.length) {
    const what = [
      ...(hasRule ? [`clears its live guard rule (${L.pct(liveRule.triggerWad)} / ${L.pct(liveRule.targetWad)})`] : []),
      ...(liveApproval !== 0n ? [`sets its ${L.usdc(liveApproval)} approval to AdagGuard to 0`] : []),
    ];
    lines.push(`SIMULATED PREMISE: the payer ${what.join(' and ')}, so every row starts with neither.`);
  }
  const loan = loanPremise(b, ctx.payer);
  if (loan.calls.length) {
    calls.push(...loan.calls.map((c) => ({ from: ctx.payer, ...c })));
    lines.push(loan.line);
  }

  const least = 1_000000n;
  const walletAfter = b.usdc + (loan.kind === 'borrow' ? loan.amount : 0n) - (loan.kind === 'repay' ? loan.amount : 0n);
  let overrides;
  if (walletAfter < least) {
    const start = least + (loan.kind === 'repay' ? loan.amount : 0n) - (loan.kind === 'borrow' ? loan.amount : 0n);
    overrides = L.nativeBalance(ctx.payer, start * 10n ** 12n);
    lines.push(`SIMULATED FUNDING: a state override sets the payer's wallet to ${L.usdc(start)} before the premise, so it holds ${L.usdc(least)} after it, the least these rows assume.`);
  }
  if (lines.length) lines.push('These are ordinary steps the payer can take (the funding aside), run inside the simulation only; no contract storage is overridden.');

  ctx.s = makeSim(b.pin, ctx.guard, calls.length ? [{ overrides, calls }] : []);
  const after = await ctx.s.run([{ time: ctx.s.t(1), calls: [pos(ctx.payer), mkt(), bal(ctx.payer)] }]);
  const p = ctx.s.decode(L.morphoAbi, 'position', after[0][0]);
  b.market = ctx.s.decode(L.morphoAbi, 'market', after[0][1]);
  b.usdc = num(after[0][2]);
  b.shares = p[1];
  b.collateral = p[2];
  b.debt = debtUp(b.shares, b.market);
  b.ltv = ltvOf(b.debt, b.collateral, b.price);
  if (L.pct(b.ltv) !== L.pct(PREMISE_LTV)) throw new Stop(`The simulated premise left the loan at ${L.pct(b.ltv)}, not ${L.pct(PREMISE_LTV)}.`);
  if (b.usdc < least) throw new Stop(`The payer holds ${L.usdc(b.usdc)} after the premise; these attacks assume at least 1 USDC.`);
  return lines;
}

const cell = (s) => String(s).replace(/\|/g, '\\|');
function table() {
  const lines = ['| # | Attack | What should stop it | Actual | Result |', '|---|---|---|---|---|'];
  for (const r of rows) lines.push(`| ${r.id} | ${cell(r.attack)} | ${cell(r.stopper)} | ${cell(r.actual)} | ${r.pass ? 'PASS' : 'FAIL'} |`);
  return lines.join('\n');
}

async function main() {
  const wallets = L.dryRunAddresses();
  ctx.payer = wallets.payer;
  ctx.guard = await loadGuard();
  L.setAdagAbi(ctx.guard.abi);
  ctx.b = await baseline(ctx.payer);
  const b = ctx.b;
  const when = new Date(Number(b.pin.timestamp) * 1000).toISOString();
  if (b.shares === 0n) throw new Stop('The payer has no USDC-market loan, so these attacks have nothing to aim at.');
  const live = `Payer ${ctx.payer} on chain: loan ${L.usdc(b.debt)} against ${L.btc(b.collateral)} pledged, loan-to-value ${L.pct(b.ltv)}; wallet ${L.usdc(b.usdc)}. BTC price ${L.btcPrice(b.price)}.`;
  const premiseLines = await setPremise();

  const state = [
    ...(wallets.fromEnv ? [] : [L.demoWalletsNote()]),
    `Block ${b.pin.number} (${when}), dRPC eth_simulateV1. ${ctx.guard.how}`,
    live,
    ...premiseLines,
    `Every row starts from: loan ${L.usdc(b.debt)} against ${L.btc(b.collateral)} pledged, loan-to-value ${L.pct(b.ltv)}; wallet ${L.usdc(b.usdc)}; no guard rule and no approval. Simulated stranger ${STRANGER}.`,
    'Unless a row says otherwise the payer\'s rule is: act at 35%, bring the loan back to 30%, no expiry.',
  ];
  console.log(state.join('\n'));

  // G6 runs first because it measures what the loan needs with a full approval, which other rows quote.
  for (const attack of [G6, G1, G2, G3, G4, G5, G7, G8, G9, G10]) {
    try {
      await attack();
    } catch (e) {
      row(attack.name, 'attack could not run', '', `error: ${e.shortMessage ?? e.message}`, false);
    }
  }

  const allOk = rows.every((r) => r.pass);
  const verdict = allOk
    ? `All ${rows.length} checks behaved as the threat model says: nothing was pulled beyond the approval, the balance, the rounded-down debt or the target, and every refusal named the right reason.`
    : `${rows.filter((r) => !r.pass).length} of ${rows.length} checks did not behave as expected. See the FAIL rows.`;
  const t = table();
  console.log(`\n${t}\n\n${verdict}`);

  const date = when.slice(0, 10);
  const file = new URL(`../deployments/attacks-${date}-guard.md`, import.meta.url);
  if (!existsSync(file)) {
    writeFileSync(file, [
      `# AdagGuard attack runs, ${date}`,
      '',
      'Each run tries to break AdagGuard with `node packages/contracts/prove-it/guard-attack.mjs`. Every attack is',
      'simulated with eth_simulateV1 from a real mainnet block against the demo payer\'s real Morpho loan. Nothing',
      'is signed or sent. Before the deploy, AdagGuard\'s runtime code is injected at its predicted address. Every',
      'row starts from a printed SIMULATED PREMISE: ordinary calls by the payer that clear any live guard rule and',
      'put the loan at 38.00% on Morpho. State overrides only fund a simulated stranger (and the payer, labelled,',
      'if the premise leaves it under 1 USDC); G8 and G9 alone swap in a mock oracle, labelled as a simulated',
      'price crash to zero.',
      '',
    ].join('\n'));
  }
  appendFileSync(file, `\n## Run at block ${b.pin.number}\n\n${state.join('\n\n')}\n\n${t}\n\n${verdict}\n`);
  console.log(`\nSaved to ${fileURLToPath(file)}`);
  return allOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nSTOPPED: ${e instanceof Stop ? e.message : (e?.shortMessage ?? e?.message ?? String(e))}`);
    process.exit(1);
  },
);
