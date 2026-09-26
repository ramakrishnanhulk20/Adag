// Proves Adag end to end on Arc mainnet: a supplier bills 1 USDC, the payer settles it from bitcoin in one
// signature, and the bitcoin is pledged, never sold.
//
//   node packages/contracts/prove-it/prove-it.mjs              dry run on live mainnet state, sends nothing
//   node packages/contracts/prove-it/prove-it.mjs --close      same, then closes the loan and takes the cirBTC back
//   node packages/contracts/prove-it/prove-it.mjs --broadcast  the real thing, asks for a typed "yes" first
//   add --target enrol to any of these to run against AdagBills with enrol instead of the first deployment; it
//   also proves enrol with a real borrower above 40%, always by simulation
import { createInterface } from 'node:readline/promises';
import { createWalletClient, http, stringToHex, formatUnits, getAddress } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import * as L from './lib.mjs';

const BILL_AMOUNT = 1_000000n;
const REFERENCE = 'ADAG-PROOF-0001';
const DUE_IN = 7n * 86_400n;
const MIN_PAYER_CIRBTC = 2_000n;
const MIN_PAYER_USDC = 100_000n;
const PAYEE_FEE_FLOOR = 20_000n;
const PAYEE_FEE_TOPUP = 50_000n;
const PLEDGE_MARGIN_PCT = 105n;
const STATUS_PAID = 2;

// A real Arc borrower above 40% in the USDC market (reference/rnd/treasury/PROBE-RESULTS.md, S1, about 70%).
// The enrol proof re-reads this loan at the pinned block and stops if it is no longer above 40%.
const ENROL_BORROWER = getAddress('0x87367570B77D92AAC699475d2894539C6092ef24');
const ENROL_BILL = 100_000n;
const ENROL_EXTRA_BORROW = 1_000000n;
const ENROL_REFERENCE = 'ADAG-ENROL-0001';
const MAX_LTV_WAD = 400000000000000000n;

class Stop extends Error {}

function parseArgs(argv) {
  let target = 'first';
  const flags = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--target') {
      target = argv[++i];
      if (!target) throw new Stop('--target needs a value: first or enrol.');
    } else if (argv[i].startsWith('--target=')) {
      target = argv[i].slice('--target='.length);
    } else {
      flags.push(argv[i]);
    }
  }
  if (!L.TARGETS[target]) throw new Stop(`Unknown target ${target}. Use --target first or --target enrol.`);
  const known = new Set(['--broadcast', '--close', '--self-test']);
  const unknown = flags.filter((a) => !known.has(a));
  if (unknown.length) throw new Stop(`Unknown option ${unknown.join(' ')}. Use --broadcast and/or --close and/or --target enrol, or --self-test alone.`);
  const selfTest = flags.includes('--self-test');
  if (selfTest && argv.length > 1) throw new Stop('--self-test runs on its own.');
  return { broadcast: flags.includes('--broadcast'), close: flags.includes('--close'), selfTest, target };
}

// Reads both USDC/cirBTC markets from Morpho and shows the market check accepting MARKET_USDC's params and
// refusing the other market's, the exact swap a lying RPC would try. Reads only, no .env, nothing sent.
async function selfTest() {
  const fetchParams = async (id) => {
    const [loanToken, collateralToken, oracle, irm, lltv] = (await circleRead([
      L.read('p', L.MORPHO, L.morphoAbi, 'idToMarketParams', [id]),
    ])).p;
    return { loanToken, collateralToken, oracle, irm, lltv };
  };
  const describe = (p) => `loan ${p.loanToken}, collateral ${p.collateralToken}, oracle ${p.oracle}, irm ${p.irm}, lltv ${p.lltv}`;
  const outcome = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };

  const real = await fetchParams(L.MARKET_USDC);
  const other = await fetchParams(L.OTHER_USDC_CIRBTC_MARKET);
  line('Market check self-test (reads Morpho on Arc mainnet through Circle\'s RPC)');
  line(`  MARKET_USDC params: ${describe(real)}`);
  line(`  other USDC/cirBTC market ${L.OTHER_USDC_CIRBTC_MARKET} params: ${describe(other)}`);

  const realHash = outcome(() => L.verifyMarketParams(real, L.MARKET_USDC));
  const realConst = outcome(() => L.assertUsdcMarketConstants(real));
  const otherHash = outcome(() => L.verifyMarketParams(other, L.MARKET_USDC));
  const otherConst = outcome(() => L.assertUsdcMarketConstants(other));
  const results = [
    ['MARKET_USDC params pass the hash check', realHash === null, realHash ?? 'accepted'],
    ['MARKET_USDC params match the hardcoded oracle, irm and lltv', realConst === null, realConst ?? 'accepted'],
    ['other market params, offered as MARKET_USDC, are refused by the hash check', otherHash !== null, otherHash ?? 'ACCEPTED'],
    ['other market params are refused by the constants check', otherConst !== null, otherConst ?? 'ACCEPTED'],
  ];
  line();
  for (const [label, ok, detail] of results) line(`  ${ok ? 'PASS' : 'FAIL'}  ${label}: ${detail}`);
  const allOk = results.every(([, ok]) => ok);
  line();
  line(allOk ? 'SELF-TEST PASSED' : 'SELF-TEST FAILED');
  return allOk ? 0 : 1;
}

const feesFor = (baseFee) => {
  const doubled = 2n * baseFee + L.PRIORITY_FEE;
  const maxFeePerGas = doubled > L.MIN_MAX_FEE ? doubled : L.MIN_MAX_FEE;
  const paid = baseFee + L.PRIORITY_FEE;
  return { maxFeePerGas, maxPriorityFeePerGas: L.PRIORITY_FEE, expected: paid < maxFeePerGas ? paid : maxFeePerGas };
};

function decodeAll(specs, results) {
  const out = {};
  specs.forEach((s, i) => {
    const r = results[i];
    if (!r.ok) throw new Stop(`Reading ${s.fn} failed: ${L.decodeRevert(r.revertData)}`);
    out[s.key] = L.decodeRead(s, r.returnData);
  });
  return out;
}

async function circleRead(specs, blockNumber) {
  const results = [];
  for (const s of specs) {
    try {
      const { data } = await L.circle.call({ to: s.to, data: s.data, blockNumber });
      results.push({ ok: true, returnData: data });
    } catch (e) {
      results.push({ ok: false, revertData: e?.cause?.data ?? e?.data });
    }
  }
  return decodeAll(specs, results);
}

// Replays every kept transaction from the pinned block inside one eth_simulateV1 request, so each step sees
// the state the steps before it left behind. Only the transactions are kept between requests, never the reads.
class DryRun {
  constructor({ pin, inject, roles }) {
    this.pin = pin;
    this.inject = inject;
    this.roles = roles;
    this.kept = [];
    this.fees = feesFor(pin.baseFeePerGas ?? 0n);
  }
  nextTime() { return this.pin.timestamp + BigInt(this.kept.length + 1); }
  plainRead(specs) { return circleRead(specs, this.pin.number); }
  async read(specs) {
    const block = { time: this.nextTime(), calls: specs.map((s) => ({ from: this.roles.payer, to: s.to, data: s.data })) };
    const res = await L.simulate([...this.kept, block], this.pin.number, this.inject);
    return decodeAll(specs, res.at(-1));
  }
  async send(label, role, call, { before = [], after = [] } = {}) {
    const from = this.roles[role];
    const tx = { from, to: call.to, data: call.data };
    const asCalls = (specs) => specs.map((s) => ({ from, to: s.to, data: s.data }));
    const time = this.nextTime();
    const res = await L.simulate([...this.kept, { time, calls: [...asCalls(before), tx, ...asCalls(after)] }], this.pin.number, this.inject);
    const out = res.at(-1);
    const r = out[before.length];
    if (!r.ok) throw new Stop(`${label} would revert: ${L.decodeRevert(r.revertData)}`);
    this.kept.push({ time, calls: [tx] });
    return {
      label, hash: null, gas: r.gas, cost: r.gas * this.fees.expected, logs: r.logs,
      before: decodeAll(before, out.slice(0, before.length)),
      after: decodeAll(after, out.slice(before.length + 1)),
    };
  }
}

class Broadcast {
  constructor({ wallets, roles }) {
    this.wallets = wallets;
    this.roles = roles;
  }
  plainRead(specs) { return circleRead(specs, undefined); }
  read(specs) { return circleRead(specs, undefined); }
  async send(label, role, call, { before = [], after = [] } = {}) {
    const wallet = this.wallets[role];
    let estimate;
    try {
      estimate = await L.circle.estimateGas({ account: wallet.account, to: call.to, data: call.data });
    } catch (e) {
      throw new Stop(`${label} would revert, nothing sent: ${L.decodeRevert(e?.cause?.data ?? e?.data) || e.shortMessage}`);
    }
    const block = await L.circle.getBlock();
    const fees = feesFor(block.baseFeePerGas ?? 0n);
    const hash = await wallet.sendTransaction({
      to: call.to, data: call.data, gas: (estimate * 125n) / 100n,
      maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
    console.log(`  sent ${label}: ${L.EXPLORER_TX}${hash}`);
    const rc = await L.circle.waitForTransactionReceipt({ hash, timeout: 180_000 });
    if (rc.status !== 'success') throw new Stop(`${label} reverted on chain: ${L.EXPLORER_TX}${hash}`);
    return {
      label, hash, gas: rc.gasUsed, cost: rc.gasUsed * rc.effectiveGasPrice, logs: rc.logs,
      before: await circleRead(before, rc.blockNumber - 1n),
      after: await circleRead(after, rc.blockNumber),
    };
  }
}

// Keys are read only here, only in --broadcast, and are turned into signing accounts straight away. A key
// that does not produce the address in .env stops the run before anything is sent.
function loadWallets(roles) {
  const env = L.readEnv(['DEPLOYER_PRIVATE_KEY', 'PAYEE_PRIVATE_KEY']);
  const wallets = {};
  for (const [role, keyName, addrName] of [['payer', 'DEPLOYER_PRIVATE_KEY', 'DEPLOYER_ADDRESS'], ['payee', 'PAYEE_PRIVATE_KEY', 'PAYEE_ADDRESS']]) {
    const raw = env[keyName].startsWith('0x') ? env[keyName] : `0x${env[keyName]}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(raw)) throw new Stop(`${keyName} in .env is not a 32-byte hex key.`);
    let account;
    try { account = privateKeyToAccount(raw); } catch { throw new Stop(`${keyName} in .env is not a usable key.`); }
    if (account.address !== roles[role]) throw new Stop(`${keyName} does not belong to ${addrName}.`);
    wallets[role] = createWalletClient({ account, chain: L.arc, transport: http(L.WRITE_RPC, { timeout: 60_000 }) });
  }
  return wallets;
}

async function confirm() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question('\nType yes to send these transactions on Arc mainnet: ');
  rl.close();
  return answer.trim() === 'yes';
}

const short = (a) => `${a.slice(0, 6)}..${a.slice(-4)}`;
const line = (s = '') => console.log(s);
const txLine = (i, t) => {
  line(`  tx ${i} ${t.label.padEnd(24)} gas ${t.gas.toLocaleString('en-US').padStart(9)}   cost ${L.gasUsdc(t.cost)}${t.hash ? `   ${L.EXPLORER_TX}${t.hash}` : ''}`);
};

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  // A dry run needs only public addresses and falls back to the demo wallets. --broadcast signs real transactions,
  // so it insists on .env and stops here, before any network call, when that is missing.
  let payer;
  let payee;
  let demoNote = null;
  if (args.broadcast) {
    let env;
    try {
      env = L.readEnv(['DEPLOYER_ADDRESS', 'PAYEE_ADDRESS']);
    } catch (e) {
      throw new Stop(`--broadcast signs real transactions on Arc mainnet, so it needs DEPLOYER_ADDRESS, PAYEE_ADDRESS and both private keys in .env at the repo root. ${e.message}`);
    }
    payer = L.checkedAddress(env.DEPLOYER_ADDRESS, 'DEPLOYER_ADDRESS');
    payee = L.checkedAddress(env.PAYEE_ADDRESS, 'PAYEE_ADDRESS');
  } else {
    const found = L.dryRunAddresses();
    payer = found.payer;
    payee = found.payee;
    if (!found.fromEnv) demoNote = L.demoWalletsNote();
  }
  if (payer === payee) throw new Stop('DEPLOYER_ADDRESS and PAYEE_ADDRESS are the same wallet; Adag refuses a self-payment.');
  const roles = { payer, payee };

  const target = L.loadTarget(args.target);
  const first = target.name === 'first';
  const artifact = target.artifact;
  const adagAbi = artifact.abi;
  L.setAdagAbi(adagAbi);
  const deployed = target.deployed ? target.address : null;
  if (args.broadcast && !deployed) {
    throw new Stop(first
      ? '--broadcast needs a deployed Adag, and packages/contracts/deployments/arc-mainnet.json does not exist yet. Deploy first, or run without --broadcast for the dry run.'
      : `--broadcast needs ${target.label} deployed, and packages/contracts/deployments/arc-mainnet.json has no ${target.key} entry yet. Deploy first, or run without --broadcast for the dry run.`);
  }
  const adag = target.address;

  const chainId = await L.circle.getChainId();
  if (chainId !== L.CHAIN_ID) throw new Stop(`${L.WRITE_RPC} reports chain ${chainId}, not Arc mainnet ${L.CHAIN_ID}.`);
  if (deployed) {
    const code = await L.circle.getCode({ address: adag });
    if (!code || code === '0x') throw new Stop(`deployments/arc-mainnet.json names ${adag}, but there is no contract there on Arc mainnet.`);
  }

  let exec;
  let now;
  if (args.broadcast) {
    const wallets = loadWallets(roles);
    exec = new Broadcast({ wallets, roles });
    now = (await L.circle.getBlock()).timestamp;
    line(`Adag prove-it: LIVE on Arc mainnet (chain ${chainId}). Adag at ${adag}.`);
  } else {
    const simChain = await L.simChainId();
    if (simChain !== L.CHAIN_ID) throw new Stop(`${L.SIM_RPC} reports chain ${simChain}, not Arc mainnet ${L.CHAIN_ID}.`);
    // A few blocks behind the head, so dRPC is sure to have the block Circle's node just served.
    const head = await L.circle.getBlockNumber();
    const pin = await L.circle.getBlock({ blockNumber: head - 3n });
    if (!deployed && !artifact.deployedBytecode) {
      throw new Stop('Adag is not deployed and there is no local build to inject. Build it with run-tests.sh, or add deployments/arc-mainnet.json.');
    }
    if (target.predicted) {
      // Code already at the predicted address means the deployer's nonce has moved on, so the prediction is stale.
      const code = await L.circle.getCode({ address: adag });
      if (code && code !== '0x') {
        throw new Stop(`${adag}, the predicted address for ${target.key}, already holds code on Arc mainnet, yet deployments/arc-mainnet.json has no ${target.key} entry. Run the deploy dry run again to refresh the prediction.`);
      }
    }
    const inject = deployed ? null : { address: adag, code: artifact.deployedBytecode.object };
    exec = new DryRun({ pin, inject, roles });
    now = pin.timestamp;
    line(`Adag prove-it: DRY RUN on live Arc mainnet state (chain ${chainId}, block ${pin.number}, ${new Date(Number(now) * 1000).toISOString()}).`);
    line('Every step runs in eth_simulateV1 on dRPC. Nothing is signed or sent.');
    if (first) {
      line(deployed
        ? `Adag at ${adag} (from deployments/arc-mainnet.json).`
        : `Adag is not deployed yet, so AdagBills' runtime code from out/AdagBills.sol is injected at the placeholder ${adag} inside the simulation.`);
    } else {
      line(deployed
        ? `${target.label} at ${adag} (key ${target.key} in deployments/arc-mainnet.json).`
        : `${target.label} is not deployed yet, so its runtime code from out/AdagBills.sol is injected inside the simulation at ${adag}, the address the deploy dry run predicted (key ${target.key} in deployments/arc-mainnet.dry-run.json).`);
    }
    if (demoNote) line(demoNote);
  }

  // (0) Starting state and the stop checks.
  const [loanToken, collateralToken, oracle, irm, lltv] = (await exec.plainRead([
    L.read('p', L.MORPHO, L.morphoAbi, 'idToMarketParams', [L.MARKET_USDC]),
  ])).p;
  const params = { loanToken, collateralToken, oracle, irm, lltv };
  if (loanToken !== L.USDC || collateralToken !== L.CIRBTC) throw new Stop('Morpho reports a different USDC market than expected.');
  // The RPC served these params and they go into signed calldata, so they must hash to MARKET_USDC first.
  L.verifyMarketParams(params, L.MARKET_USDC);
  L.assertUsdcMarketConstants(params);

  const start = await exec.plainRead([
    L.read('payerUsdc', L.USDC, L.erc20Abi, 'balanceOf', [payer]),
    L.read('payerBtc', L.CIRBTC, L.erc20Abi, 'balanceOf', [payer]),
    L.read('payeeUsdc', L.USDC, L.erc20Abi, 'balanceOf', [payee]),
    L.read('payeeBtc', L.CIRBTC, L.erc20Abi, 'balanceOf', [payee]),
    L.read('pos', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, payer]),
    L.read('market', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
    L.read('price', oracle, L.oracleAbi, 'price'),
  ]);
  const adagStart = await exec.read([
    L.read('status', adag, adagAbi, 'priceStatus', [L.MARKET_USDC]),
    L.read('needed', adag, adagAbi, 'collateralNeeded', [payer, L.MARKET_USDC, BILL_AMOUNT]),
    L.read('count', adag, adagAbi, 'billCount'),
  ]);
  const [fresh, btcUpdatedAt] = adagStart.status;
  const priceAgeH = (Number(now - btcUpdatedAt) / 3600).toFixed(1);
  const startDebt = start.pos[1] === 0n ? 0n : L.toAssetsUp(start.pos[1], start.market[2], start.market[3]);

  line();
  line('Starting state');
  line(`  payer ${payer}: ${L.usdc(start.payerUsdc)}, ${L.btc(start.payerBtc)} in wallet, ${L.btc(start.pos[2])} pledged, loan ${L.usdc(startDebt)}`);
  line(`  payee ${payee}: ${L.usdc(start.payeeUsdc)}, ${L.btc(start.payeeBtc)}`);
  line(`  BTC price ${L.btcPrice(start.price)}, updated ${priceAgeH} hours ago (${fresh ? 'fresh' : 'STALE'}; Adag accepts new loans up to 26 hours)`);

  if (!fresh) throw new Stop(`The BTC/USD price is ${priceAgeH} hours old, past Adag's 26 hour limit, so Adag would refuse the loan. Run again after the next price update.`);
  if (start.payerBtc < MIN_PAYER_CIRBTC) throw new Stop(`The payer holds ${L.btc(start.payerBtc)}; this proof needs at least ${L.btc(MIN_PAYER_CIRBTC)}.`);
  if (start.payerUsdc < MIN_PAYER_USDC) throw new Stop(`The payer holds ${L.usdc(start.payerUsdc)}; this proof needs at least ${L.usdc(MIN_PAYER_USDC)} for fees.`);

  const needed = adagStart.needed;
  const pledge = (needed * PLEDGE_MARGIN_PCT + 99n) / 100n;
  if (start.payerBtc < pledge) throw new Stop(`The pledge is ${L.btc(pledge)} but the payer holds only ${L.btc(start.payerBtc)}.`);
  const topUp = start.payeeUsdc < PAYEE_FEE_FLOOR;
  if (args.close) {
    // Repaying needs real USDC: the borrowed dollar went to the payee, so the loan comes back out of the payer's own balance.
    const repayNeed = ((startDebt + BILL_AMOUNT) * 1001n) / 1000n + (topUp ? PAYEE_FEE_TOPUP : 0n) + MIN_PAYER_USDC;
    if (start.payerUsdc < repayNeed) throw new Stop(`--close repays the loan from the payer's own USDC: it needs about ${L.usdc(repayNeed)} and holds ${L.usdc(start.payerUsdc)}.`);
  }
  const billId = adagStart.count + 1n;
  const due = now + DUE_IN;

  line();
  line(`Plan (${args.broadcast ? 'LIVE, real money' : 'dry run'})`);
  let n = 0;
  line(topUp
    ? `  ${++n}. payer sends the payee ${L.usdc(PAYEE_FEE_TOPUP)} for its fees (it holds ${L.usdc(start.payeeUsdc)}, under ${L.usdc(PAYEE_FEE_FLOOR)})`
    : `  -  no fee top-up: the payee already holds ${L.usdc(start.payeeUsdc)}`);
  line(`  ${++n}. payee writes a bill for ${L.usdc(BILL_AMOUNT)}, due ${new Date(Number(due) * 1000).toISOString().slice(0, 10)}, reference ${REFERENCE}`);
  line(`  ${++n}. payer signs ONE batch through Multicall3From, every step all-or-nothing:`);
  if (pledge > 0n) {
    line(`       approve ${L.btc(pledge)} to Morpho`);
    line(`       pledge ${L.btc(pledge)} in the cirBTC/USDC market (Adag asks for ${L.btc(needed)}, plus a 5% margin)`);
  } else {
    line('       no new pledge: the cirBTC already pledged covers the loan at 40%');
  }
  line(`       borrow ${L.usdc(BILL_AMOUNT)} against it`);
  line(`       approve Adag for exactly ${L.usdc(BILL_AMOUNT)}`);
  line(`       pay bill #${billId} through Memo, tagged ${REFERENCE}`);
  if (args.close) line(`  ${++n}. payer signs one more batch: approve USDC to Morpho for the live debt plus 0.1%, repay by live shares, withdraw all cirBTC, approval back to 0`);

  if (args.broadcast && !(await confirm())) {
    line('Cancelled. Nothing was sent.');
    return 1;
  }
  line();
  line('Running');

  const txs = [];
  if (topUp) {
    txs.push(await exec.send('fee top-up (payer)', 'payer', L.calls.transfer(L.USDC, payee, PAYEE_FEE_TOPUP)));
    line(`  fee top-up done`);
  }

  const create = await exec.send('create bill (payee)', 'payee', {
    to: adag, data: L.enc(adagAbi, 'createBill', [L.USDC, BILL_AMOUNT, due, stringToHex(REFERENCE)]),
  });
  txs.push(create);
  const created = L.findEvent(create.logs, adag, adagAbi, 'BillCreated');
  if (!created || created.payee !== payee || created.amount !== BILL_AMOUNT || created.currency !== L.USDC) {
    throw new Stop('createBill did not emit the expected BillCreated event.');
  }
  if (!args.broadcast && created.id !== billId) throw new Stop(`The bill came back as #${created.id}, expected #${billId}.`);
  const id = created.id;
  line(`  bill #${id} written by the payee`);

  L.verifyMarketParams(params, L.MARKET_USDC);
  const steps = [];
  if (pledge > 0n) steps.push(L.calls.approve(L.CIRBTC, L.MORPHO, pledge), L.calls.supplyCollateral(params, pledge, payer));
  steps.push(
    L.calls.borrow(params, BILL_AMOUNT, payer, payer),
    L.calls.approve(L.USDC, adag, BILL_AMOUNT),
    L.calls.memo({ to: adag, data: L.enc(adagAbi, 'pay', [id]) }, id, REFERENCE),
  );
  const snap = (sfx) => [
    L.read(`payeeUsdc${sfx}`, L.USDC, L.erc20Abi, 'balanceOf', [payee]),
    L.read(`payerUsdc${sfx}`, L.USDC, L.erc20Abi, 'balanceOf', [payer]),
    L.read(`payerBtc${sfx}`, L.CIRBTC, L.erc20Abi, 'balanceOf', [payer]),
    L.read(`pos${sfx}`, L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, payer]),
  ];
  const payTx = await exec.send('pledge, borrow, pay', 'payer', L.calls.batch(steps), {
    before: snap('0'),
    after: [
      ...snap('1'),
      L.read('market1', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
      L.read('ltv1', adag, adagAbi, 'loanToValue', [payer, L.MARKET_USDC]),
      L.read('bill1', adag, adagAbi, 'bill', [id]),
    ],
  });
  txs.push(payTx);
  line(`  batch of ${steps.length} steps done in one signature`);

  const b = payTx.before;
  const a = payTx.after;
  const paid = L.findEvent(payTx.logs, adag, adagAbi, 'BillPaid');
  const memo = L.findEvent(payTx.logs, L.MEMO, L.memoAbi, 'Memo');
  const rise = a.payeeUsdc1 - b.payeeUsdc0;
  const btcBefore = b.payerBtc0 + b.pos0[2];
  const btcAfter = a.payerBtc1 + a.pos1[2];
  const sold = btcBefore - btcAfter;
  const loan = L.toAssetsUp(a.pos1[1], a.market1[2], a.market1[3]);

  const checks = [
    ['payee received exactly 1.000000 USDC', rise === BILL_AMOUNT],
    ['BillPaid from Adag names this bill, payer, payee and amount',
      !!paid && paid.id === id && paid.payer === payer && paid.payee === payee && paid.currency === L.USDC && paid.amount === BILL_AMOUNT],
    ['Memo from the Memo contract: sender payer, target Adag, memo id = bill id',
      !!memo && memo.sender === payer && memo.target === adag && BigInt(memo.memoId) === id && L.memoText(memo.memo) === REFERENCE],
    ['bill is marked Paid by this payer', a.bill1.status === STATUS_PAID && a.bill1.payer === payer],
    ['bitcoin sold: 0 (wallet plus pledged is unchanged)', sold === 0n],
  ];

  line();
  line('Receipt');
  txs.forEach((t, i) => txLine(i + 1, t));
  if (paid) line(`  BillPaid  bill #${paid.id}, payer ${short(paid.payer)}, payee ${short(paid.payee)}, ${L.usdc(paid.amount)}, loan checked ${paid.loanChecked}`);
  if (memo) line(`  Memo      sender ${short(memo.sender)}, target Adag ${short(memo.target)}, memo id ${BigInt(memo.memoId)}, text "${L.memoText(memo.memo)}", memo index ${memo.memoIndex}`);
  line(`  payee USDC      ${L.usdc(b.payeeUsdc0)} before, ${L.usdc(a.payeeUsdc1)} after (${L.signedUsdc(rise)})`);
  line(`  payer cirBTC    ${L.btc(a.payerBtc1)} in wallet, ${L.btc(a.pos1[2])} pledged, bitcoin sold: ${L.btc(sold)}`);
  line(`  payer USDC      ${L.usdc(b.payerUsdc0)} before, ${L.usdc(a.payerUsdc1)} after (borrowed 1 and paid 1 out; gas is extra on a real run)`);
  line(`  payer loan      ${L.usdc(loan)}, loan-to-value ${L.pct(a.ltv1)} (Adag caps new loans at 40%, Morpho liquidates at ${formatUnits(lltv, 16)}%)`);

  if (args.close) {
    const live = await exec.read([
      L.read('pos', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, payer]),
      L.read('market', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
      L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [payer]),
    ]);
    const shares = live.pos[1];
    const collateral = live.pos[2];
    if (shares === 0n) throw new Stop('The payer has no borrow shares to repay.');
    // Repaying by the live share count, not by assets, is what clears the position to exactly zero; repaying by assets leaves dust that blocks the withdrawal.
    const debt = L.toAssetsUp(shares, live.market[2], live.market[3]);
    const approval = debt + (debt + 999n) / 1000n;
    if (live.usdc < approval) throw new Stop(`Closing needs ${L.usdc(approval)} of USDC to repay; the payer holds ${L.usdc(live.usdc)}.`);
    L.verifyMarketParams(params, L.MARKET_USDC);
    const closeTx = await exec.send('repay, withdraw, reset', 'payer', L.calls.batch([
      L.calls.approve(L.USDC, L.MORPHO, approval),
      L.calls.repayShares(params, shares, payer),
      L.calls.withdrawCollateral(params, collateral, payer, payer),
      L.calls.approve(L.USDC, L.MORPHO, 0n),
    ]), {
      before: [L.read('btc0', L.CIRBTC, L.erc20Abi, 'balanceOf', [payer])],
      after: [
        L.read('btc1', L.CIRBTC, L.erc20Abi, 'balanceOf', [payer]),
        L.read('pos1', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, payer]),
        L.read('allow1', L.USDC, L.erc20Abi, 'allowance', [payer, L.MORPHO]),
        L.read('ltv1', adag, adagAbi, 'loanToValue', [payer, L.MARKET_USDC]),
      ],
    });
    txs.push(closeTx);
    const repaid = L.findEvent(closeTx.logs, L.MORPHO, L.morphoAbi, 'Repay');
    const withdrawn = L.findEvent(closeTx.logs, L.MORPHO, L.morphoAbi, 'WithdrawCollateral');
    const returned = closeTx.after.btc1 - closeTx.before.btc0;
    const endPos = closeTx.after.pos1;
    checks.push(
      ['loan closed: 0 borrow shares, 0 debt, 0 pledged', endPos[1] === 0n && endPos[2] === 0n],
      ['all pledged cirBTC came back to the wallet', returned === collateral && withdrawn?.assets === collateral],
      ['USDC approval to Morpho is back to 0', closeTx.after.allow1 === 0n],
    );
    line();
    line('Close');
    txLine(txs.length, closeTx);
    line(`  repaid          ${repaid ? L.usdc(repaid.assets) : 'no Repay event'} for ${shares} borrow shares (approved ${L.usdc(approval)})`);
    line(`  cirBTC returned ${L.btc(returned)}; wallet now ${L.btc(closeTx.after.btc1)}`);
    line(`  final position  debt ${L.usdc(endPos[1] === 0n ? 0n : L.toAssetsUp(endPos[1], live.market[2], live.market[3]))}, ${endPos[1]} borrow shares, ${L.btc(endPos[2])} pledged, loan-to-value ${L.pct(closeTx.after.ltv1)}`);
  }

  let enrolled = null;
  if (!first) {
    let pin = exec.pin;
    if (args.broadcast) {
      const simChain = await L.simChainId();
      if (simChain !== L.CHAIN_ID) throw new Stop(`${L.SIM_RPC} reports chain ${simChain}, not Arc mainnet ${L.CHAIN_ID}.`);
      pin = await L.circle.getBlock({ blockNumber: (await L.circle.getBlockNumber()) - 3n });
    }
    enrolled = await enrolProof({ adag, adagAbi, inject: exec.inject ?? null, payee, params, pin });
    checks.push(...enrolled.checks);
  }

  const total = txs.reduce((s, t) => s + t.cost, 0n);
  const gasTotal = txs.reduce((s, t) => s + t.gas, 0n);
  line();
  line(`Gas: ${gasTotal.toLocaleString('en-US')} in ${txs.length} transactions, ${L.gasUsdc(total)} ${args.broadcast ? 'paid' : `estimated at the current base fee plus 1 gwei (${formatUnits(exec.fees.expected, 9)} gwei)`}`);
  line();
  line('Checks');
  for (const [label, ok] of checks) line(`  ${ok ? 'PASS' : 'FAIL'}  ${label}`);
  const allOk = checks.every(([, ok]) => ok);
  line();
  line(allOk
    ? `PROVEN${args.broadcast ? '' : ' (dry run)'}: the payee was paid 1 USDC from a loan against the payer's bitcoin, in one signature, and no bitcoin was sold.`
    : 'NOT PROVEN: at least one check failed, see above.');
  if (allOk && enrolled) {
    line(`PROVEN (simulated): a real borrower at ${L.pct(enrolled.ltv)} was refused before enrolling, enrolled, and paid a bill from cash in the next block, while new debt after enrolling was still refused.`);
  }
  return allOk ? 0 : 1;
}

const named = (s) => s.split(L.MARKET_USDC).join('MARKET_USDC');

// Always a simulation, even after a live deploy: it acts as a real borrower's wallet, and only that borrower can
// sign for it. Block N: a bill is written, the borrower's cash payment is refused, the borrower enrols. Block
// N+1: borrowing more in the paying batch is refused, then the same bill paid from cash goes through.
async function enrolProof({ adag, adagAbi, inject, payee, params, pin }) {
  const borrower = ENROL_BORROWER;
  const start = await circleRead([
    L.read('usdcPos', L.MORPHO, L.morphoAbi, 'position', [L.MARKET_USDC, borrower]),
    L.read('market', L.MORPHO, L.morphoAbi, 'market', [L.MARKET_USDC]),
    L.read('price', params.oracle, L.oracleAbi, 'price'),
    L.read('usdc', L.USDC, L.erc20Abi, 'balanceOf', [borrower]),
  ], pin.number);
  const code = await L.circle.getCode({ address: borrower, blockNumber: pin.number });
  const shares = start.usdcPos[1];
  const debt = shares === 0n ? 0n : L.toAssetsUp(shares, start.market[2], start.market[3]);
  const value = (start.usdcPos[2] * start.price) / 10n ** 36n;
  const ltv = value === 0n ? 2n ** 256n - 1n : (debt * 10n ** 18n + value - 1n) / value;

  line();
  line('Enrol proof (always an eth_simulateV1 run: it acts as a real borrower\'s wallet, which only that borrower can sign for)');
  line(`  borrower ${borrower} at block ${pin.number}: loan ${L.usdc(debt)} against ${L.btc(start.usdcPos[2])} pledged, loan-to-value ${L.pct(ltv)}, wallet ${L.usdc(start.usdc)}`);
  if (code && code !== '0x') throw new Stop(`The enrol borrower ${borrower} has contract code, so it cannot send its own batch through Multicall3From.`);
  if (shares === 0n || ltv <= MAX_LTV_WAD) throw new Stop(`The enrol borrower ${borrower} is no longer above 40% (${L.pct(ltv)}), so the proof's premise does not hold. Pick another borrower above 40%.`);
  if (start.usdc < ENROL_BILL) throw new Stop(`The enrol borrower holds ${L.usdc(start.usdc)}, under the ${L.usdc(ENROL_BILL)} bill.`);

  const call = (from, c) => ({ from, to: c.to, data: c.data });
  const adagCall = (fn, args = []) => ({ to: adag, data: L.enc(adagAbi, fn, args) });
  const readAs = (fn, args) => call(borrower, adagCall(fn, args));
  const morphoPos = (marketId) => call(borrower, { to: L.MORPHO, data: L.enc(L.morphoAbi, 'position', [marketId, borrower]) });
  const payeeBalance = call(payee, { to: L.USDC, data: L.enc(L.erc20Abi, 'balanceOf', [payee]) });
  const decode = (abi, fn, r) => L.decodeRead({ abi, fn }, r.returnData);
  const need = (r, what) => {
    if (!r.ok) throw new Stop(`${what} failed in the enrol simulation: ${L.decodeRevert(r.revertData)}`);
    return r;
  };

  const count = decode(adagAbi, 'billCount', need((await L.simulate([
    { time: pin.timestamp + 1n, calls: [readAs('billCount', [])] },
  ], pin.number, inject))[0][0], 'billCount'));
  const id = count + 1n;
  const cashPay = [L.calls.approve(L.USDC, adag, ENROL_BILL), L.calls.memo(adagCall('pay', [id]), id, ENROL_REFERENCE)];
  L.verifyMarketParams(params, L.MARKET_USDC);

  const [n, n1] = await L.simulate([
    { time: pin.timestamp + 1n, calls: [
      call(payee, adagCall('createBill', [L.USDC, ENROL_BILL, pin.timestamp + DUE_IN, stringToHex(ENROL_REFERENCE)])),
      call(borrower, L.calls.batch(cashPay)),
      morphoPos(L.MARKET_USDC),
      morphoPos(L.MARKET_EURC),
      call(borrower, adagCall('enrol')),
      readAs('seenPosition', [borrower, L.MARKET_USDC]),
      readAs('seenPosition', [borrower, L.MARKET_EURC]),
      readAs('enrolledAt', [borrower]),
    ] },
    { time: pin.timestamp + 2n, calls: [
      payeeBalance,
      call(borrower, L.calls.batch([L.calls.borrow(params, ENROL_EXTRA_BORROW, borrower, borrower), ...cashPay])),
      call(borrower, L.calls.batch(cashPay)),
      payeeBalance,
      readAs('bill', [id]),
      readAs('loanToValue', [borrower, L.MARKET_USDC]),
    ] },
  ], pin.number, inject);

  const created = L.findEvent(need(n[0], 'createBill').logs, adag, adagAbi, 'BillCreated');
  if (!created || created.id !== id) throw new Stop(`The enrol bill came back as #${created?.id}, expected #${id}.`);
  const refusedBefore = n[1].ok ? 'success' : named(L.decodeRevert(n[1].revertData));
  const usdcPos = decode(L.morphoAbi, 'position', need(n[2], 'position'));
  const eurcPos = decode(L.morphoAbi, 'position', need(n[3], 'position'));
  const ev = n[4].ok ? L.findEvent(n[4].logs, adag, adagAbi, 'Enrolled') : null;
  const seenUsdc = decode(adagAbi, 'seenPosition', need(n[5], 'seenPosition'));
  const seenEurc = decode(adagAbi, 'seenPosition', need(n[6], 'seenPosition'));
  const enrolBlock = decode(adagAbi, 'enrolledAt', need(n[7], 'enrolledAt'));
  const payeeBefore = decode(L.erc20Abi, 'balanceOf', need(n1[0], 'balanceOf'));
  const borrowMore = n1[1].ok ? 'success' : named(L.decodeRevert(n1[1].revertData));
  const paid = n1[2].ok ? L.findEvent(n1[2].logs, adag, adagAbi, 'BillPaid') : null;
  const payeeAfter = decode(L.erc20Abi, 'balanceOf', need(n1[3], 'balanceOf'));
  const bill = decode(adagAbi, 'bill', need(n1[4], 'bill'));
  const ltvAtPay = decode(adagAbi, 'loanToValue', need(n1[5], 'loanToValue'));
  const rise = payeeAfter - payeeBefore;

  line(`  block ${pin.number + 1n}: payee writes bill #${id} for ${L.usdc(ENROL_BILL)}; the borrower pays it from cash: ${refusedBefore}`);
  line(`  block ${pin.number + 1n}: the borrower enrols: ${n[4].ok ? `success, gas ${n[4].gas.toLocaleString('en-US')}` : named(L.decodeRevert(n[4].revertData))}`);
  if (ev) line(`    Enrolled  USDC market ${ev.usdcShares} shares, ${L.btc(ev.usdcCollateral)}; EURC market ${ev.eurcShares} shares, ${L.btc(ev.eurcCollateral)}; enrol block ${enrolBlock}`);
  line(`  block ${pin.number + 2n}: borrow ${L.usdc(ENROL_EXTRA_BORROW)} more and pay the bill in one batch: ${borrowMore}`);
  line(`  block ${pin.number + 2n}: pay the bill from cash: ${n1[2].ok ? `success, loan checked ${paid?.loanChecked}, loan-to-value ${L.pct(ltvAtPay)}` : named(L.decodeRevert(n1[2].revertData))}`);
  line(`  payee USDC ${L.usdc(payeeBefore)} before, ${L.usdc(payeeAfter)} after (${L.signedUsdc(rise)})`);

  const checks = [
    [`before enrolling, the borrower at ${L.pct(ltv)} is refused a cash payment with LtvAboveLimit`, !n[1].ok && refusedBefore.startsWith('MemoFailed(LtvAboveLimit(MARKET_USDC')],
    ['enrol emits and records exactly Morpho\'s position in both markets, and stores its block',
      n[4].ok && !!ev && ev.payer === borrower
      && ev.usdcShares === usdcPos[1] && ev.usdcCollateral === usdcPos[2] && ev.eurcShares === eurcPos[1] && ev.eurcCollateral === eurcPos[2]
      && seenUsdc[0] === usdcPos[1] && seenUsdc[1] === usdcPos[2] && seenEurc[0] === eurcPos[1] && seenEurc[1] === eurcPos[2]
      && enrolBlock === pin.number + 1n],
    ['next block, borrowing more in the paying batch is refused with LtvAboveLimit', !n1[1].ok && borrowMore.startsWith('MemoFailed(LtvAboveLimit(MARKET_USDC')],
    ['next block, the same bill paid from cash goes through with loanChecked false',
      n1[2].ok && !!paid && paid.id === id && paid.payer === borrower && paid.loanChecked === false],
    [`payee received exactly ${L.usdc(ENROL_BILL)} from the enrolled borrower`, rise === ENROL_BILL],
    ['bill is marked Paid by the enrolled borrower', bill.status === STATUS_PAID && bill.payer === borrower],
  ];
  return { checks, ltv };
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nSTOPPED: ${e instanceof Stop ? e.message : (e?.shortMessage ?? e?.message ?? String(e))}`);
    process.exit(1);
  },
);
