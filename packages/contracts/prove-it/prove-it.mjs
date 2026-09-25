// Proves Adag end to end on Arc mainnet: a supplier bills 1 USDC, the payer settles it from bitcoin in one
// signature, and the bitcoin is pledged, never sold.
//
//   node packages/contracts/prove-it/prove-it.mjs              dry run on live mainnet state, sends nothing
//   node packages/contracts/prove-it/prove-it.mjs --close      same, then closes the loan and takes the cirBTC back
//   node packages/contracts/prove-it/prove-it.mjs --broadcast  the real thing, asks for a typed "yes" first
import { createInterface } from 'node:readline/promises';
import { createWalletClient, http, stringToHex, formatUnits } from 'viem';
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

class Stop extends Error {}

function parseArgs(argv) {
  const known = new Set(['--broadcast', '--close']);
  const unknown = argv.filter((a) => !known.has(a));
  if (unknown.length) throw new Stop(`Unknown option ${unknown.join(' ')}. Use --broadcast and/or --close.`);
  return { broadcast: argv.includes('--broadcast'), close: argv.includes('--close') };
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
  const env = L.readEnv(['DEPLOYER_ADDRESS', 'PAYEE_ADDRESS']);
  const payer = L.checkedAddress(env.DEPLOYER_ADDRESS, 'DEPLOYER_ADDRESS');
  const payee = L.checkedAddress(env.PAYEE_ADDRESS, 'PAYEE_ADDRESS');
  if (payer === payee) throw new Stop('DEPLOYER_ADDRESS and PAYEE_ADDRESS are the same wallet; Adag refuses a self-payment.');
  const roles = { payer, payee };

  const artifact = L.loadAdagAbi();
  const adagAbi = artifact.abi;
  L.setAdagAbi(adagAbi);
  const deployed = L.loadDeployment();
  if (args.broadcast && !deployed) {
    throw new Stop('--broadcast needs a deployed Adag, and packages/contracts/deployments/arc-mainnet.json does not exist yet. Deploy first, or run without --broadcast for the dry run.');
  }
  const adag = deployed ?? L.PLACEHOLDER_ADAG;

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
    const inject = deployed ? null : { address: adag, code: artifact.deployedBytecode.object };
    exec = new DryRun({ pin, inject, roles });
    now = pin.timestamp;
    line(`Adag prove-it: DRY RUN on live Arc mainnet state (chain ${chainId}, block ${pin.number}, ${new Date(Number(now) * 1000).toISOString()}).`);
    line('Every step runs in eth_simulateV1 on dRPC. Nothing is signed or sent.');
    line(deployed
      ? `Adag at ${adag} (from deployments/arc-mainnet.json).`
      : `Adag is not deployed yet, so AdagBills' runtime code from out/AdagBills.sol is injected at the placeholder ${adag} inside the simulation.`);
  }

  // (0) Starting state and the stop checks.
  const [loanToken, collateralToken, oracle, irm, lltv] = (await exec.plainRead([
    L.read('p', L.MORPHO, L.morphoAbi, 'idToMarketParams', [L.MARKET_USDC]),
  ])).p;
  const params = { loanToken, collateralToken, oracle, irm, lltv };
  if (loanToken !== L.USDC || collateralToken !== L.CIRBTC) throw new Stop('Morpho reports a different USDC market than expected.');

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
    // Repaying by the live share count, not by assets, is what clears the position to exactly zero (RD-BRIEF 1e).
    const debt = L.toAssetsUp(shares, live.market[2], live.market[3]);
    const approval = debt + (debt + 999n) / 1000n;
    if (live.usdc < approval) throw new Stop(`Closing needs ${L.usdc(approval)} of USDC to repay; the payer holds ${L.usdc(live.usdc)}.`);
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
  return allOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`\nSTOPPED: ${e instanceof Stop ? e.message : (e?.shortMessage ?? e?.message ?? String(e))}`);
    process.exit(1);
  },
);
