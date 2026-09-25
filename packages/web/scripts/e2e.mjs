// Drives the real bill page against an Arc mainnet fork where the transactions really execute. It starts arc-anvil
// in WSL, has the demo payee write bills, builds and serves a second copy of the app on :3400 pointed at the fork,
// and clicks through the money actions in Chromium with an injected wallet that forwards everything to the fork.
//
//   node scripts/e2e.mjs            (from packages/web)
//
// Exits 0 only if every scenario passes. Nothing is signed for or sent to Arc mainnet.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createPublicClient, http, parseAbi, parseAbiItem, stringToHex } from 'viem';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(WEB, '../..');
const SHOTS = resolve(REPO, 'reference/design/lab-shots');
const FORK = 'http://127.0.0.1:8545';
const APP = 'http://localhost:3400';
const DIST = '.next-e2e';

const PAYER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const PAYEE = '0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B';
const ADAG = '0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E';
const LTV_SENTENCE = "This would take your loan past 40% of your bitcoin's value.";
const STALE_SENTENCE = 'New loans are paused until the bitcoin price updates. Paying from your balance still works.';

// Playwright is installed globally on this machine, not in the app's dependencies.
const globalRequire = createRequire(`${spawnSync('npm root -g', { encoding: 'utf8', shell: true }).stdout.trim()}/`);
const { chromium } = globalRequire('playwright');

const MORPHO = '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD';
const USDC = '0x3600000000000000000000000000000000000000';
const CIRBTC = '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0';
const MARKET_USDC = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const MARKET_EURC = '0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4';
const EURC = '0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1';
const tokenAbi = parseAbi(['function balanceOf(address) view returns (uint256)', 'function allowance(address, address) view returns (uint256)']);
const morphoAbi = parseAbi(['function position(bytes32 id, address user) view returns (uint256 supplyShares, uint128 borrowShares, uint128 collateral)']);
const adagAbi = parseAbi([
  'function bill(uint256 id) view returns ((address payee, uint8 status, uint64 due, address currency, uint64 createdAt, uint256 amount, address payer, uint64 paidAt, bytes ref))',
]);
const billPaidEvent = parseAbiItem('event BillPaid(uint256 indexed id, address indexed payer, address indexed payee, address currency, uint256 amount, bool loanChecked)');
const fork = createPublicClient({ transport: http(FORK, { timeout: 60_000 }) });
const positionOf = (who) => fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_USDC, who] });
const cirBtcOf = (who) => fork.readContract({ address: CIRBTC, abi: tokenAbi, functionName: 'balanceOf', args: [who] });

const results = [];
const consoleErrors = [];
const record = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

function forkScript(...args) {
  const r = spawnSync('bash', [resolve(WEB, 'scripts/e2e-fork.sh'), ...args], { encoding: 'utf8', shell: false });
  if (r.status !== 0) throw new Error(`e2e-fork.sh ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return r.stdout.trim();
}
const newBill = (currency, amount, ref) => BigInt(forkScript('bill', currency, String(amount), ref).split('\n').at(-1));
const rpc = (method, params = []) => fork.request({ method, params });
const statusOf = async (id) => (await fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [id] })).status;

async function billPaidLog(id) {
  const logs = await fork.getLogs({ address: ADAG, event: billPaidEvent, args: { id }, fromBlock: (await fork.getBlockNumber()) - 50n });
  return logs.at(-1) ?? null;
}

const nextBin = resolve(WEB, 'node_modules/next/dist/bin/next');
const appEnv = {
  ...process.env,
  NEXT_DIST_DIR: DIST,
  NEXT_PUBLIC_ARC_RPC_URL: FORK,
  NEXT_PUBLIC_ADAG_E2E: '1',
  ARC_RPC_URL: FORK,
  ARC_RPC_FALLBACK_URL: FORK,
};

function buildApp() {
  if (existsSync(resolve(WEB, DIST))) rmSync(resolve(WEB, DIST), { recursive: true, force: true });
  const r = spawnSync(process.execPath, [nextBin, 'build'], { cwd: WEB, env: appEnv, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`the fork build failed:\n${(r.stdout + r.stderr).slice(-2000)}`);
}

async function startApp() {
  const child = spawn(process.execPath, [nextBin, 'start', '--port', '3400'], { cwd: WEB, env: appEnv, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${APP}/pay`, { signal: AbortSignal.timeout(20_000) })).ok) return child;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the :3400 app did not start');
}

function stopApp(child) {
  if (!child?.pid) return;
  spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
}

// The wallet: every request goes to the fork as the impersonated account. The fork signs for it, so
// eth_sendTransaction really executes. chainOverride makes it claim another chain, to test the Arc gate.
function walletScript({ account, fork, chainOverride }) {
  window.__walletLog = [];
  let id = 0;
  const forward = async (method, params) => {
    const res = await fetch(fork, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
    const json = await res.json();
    if (json.error) throw Object.assign(new Error(json.error.message), json.error);
    return json.result;
  };
  const listeners = {};
  window.ethereum = {
    isMetaMask: true,
    async request({ method, params }) {
      window.__walletLog.push(method);
      if (method === 'eth_chainId' && chainOverride) return chainOverride;
      if (method === 'net_version' && chainOverride) return String(parseInt(chainOverride, 16));
      if (method === 'eth_accounts' || method === 'eth_requestAccounts') return [account];
      if (method === 'wallet_requestPermissions' || method === 'wallet_getPermissions') return [{ parentCapability: 'eth_accounts' }];
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (method === 'eth_sendTransaction') return forward(method, [{ ...params[0], from: account }]);
      return forward(method, params);
    },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); },
  };
}

let browser;
async function openPage({ account, chainOverride = null, width = 1440, theme = 'dark' }) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, colorScheme: theme });
  await context.addCookies([{ name: 'adag-theme', value: theme, url: APP }]);
  await context.addInitScript(walletScript, { account, fork: FORK, chainOverride });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(`${page.url()}: ${m.text()}`));
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: pageerror ${e.message}`));
  return { context, page };
}

async function connect(page, path) {
  await page.goto(APP + path, { waitUntil: 'networkidle', timeout: 120_000 });
  await page.getByRole('button', { name: 'Connect wallet' }).first().click();
  await page.locator('#wallet-title').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('.live-shimmer'), null, { timeout: 60_000 }).catch(() => {});
}

// Reveals only fire in view, so walk the page before a full-page capture; then shoot 1440 dark and 375 light.
// Only the newest work order's states (f7b-) are shot by default. --all-shots re-shoots the approved F5b and F7 images too.
async function shoot(page, name) {
  const all = process.argv.includes('--all-shots');
  const file = name.startsWith('f7b-') ? name : !all ? null : name.startsWith('f7-') ? name : `e2e-${name}`;
  if (!file) return;
  const walk = async () => {
    await page.evaluate(async () => {
      for (let y = 0; y < document.body.scrollHeight; y += 300) {
        window.scrollTo(0, y);
        await new Promise((r) => setTimeout(r, 90));
      }
      window.scrollTo(0, 0);
    });
    await page.waitForTimeout(900);
  };
  await walk();
  await page.screenshot({ path: `${SHOTS}/${file}-1440-dark.png`, fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await walk();
  await page.screenshot({ path: `${SHOTS}/${file}-375-light.png`, fullPage: true });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  await page.setViewportSize({ width: 1440, height: 900 });
}

const sends = (page) => page.evaluate(() => window.__walletLog.filter((m) => m === 'eth_sendTransaction').length);

async function main() {
  console.log('e2e: starting the Arc fork in WSL');
  console.log(`  ${forkScript('start')}`);
  const chain = await rpc('eth_chainId');
  if (chain !== '0x13b2') throw new Error(`the fork reports chain ${chain}, not 5042`);

  const A = newBill('USDC', 400_000, 'E2E-A');
  const B = newBill('USDC', 300_000, 'E2E-B');
  const C = newBill('EURC', 200_000, 'E2E-C');
  console.log(`  payee wrote bills #${A} (0.40 USDC), #${B} (0.30 USDC), #${C} (0.20 EURC) on the fork`);
  console.log('  the EURC bill is only voided, so the payer needs no EURC');

  console.log('e2e: building the app against the fork (.next-e2e) and serving it on :3400');
  buildApp();
  const app = await startApp();
  browser = await chromium.launch();

  try {
    // (a) Pay bill A from balance.
    {
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${A}`);
      await shoot(page, 'a-open');
      await page.locator('[data-action="pay-balance"]').click();
      await page.locator('[data-tx-result="paid"]').waitFor({ timeout: 120_000 });
      await page.getByRole('img', { name: 'Status: Paid' }).first().waitFor({ timeout: 60_000 });
      // The page refresh after payment must not swap the receipt card for "Already paid".
      await page.waitForTimeout(1500);
      const cardStays = await page.locator('[data-tx-result="paid"]').isVisible();
      await shoot(page, 'a-paid');
      const onFork = await statusOf(A);
      const log = await billPaidLog(A);
      record(`(a) bill #${A} paid from balance: PAID in the UI and on the fork`, cardStays && onFork === 2 && !!log && log.args.loanChecked === false,
        `fork status ${onFork}, BillPaid loanChecked ${log?.args.loanChecked}, tx ${log?.transactionHash}`);
      await context.close();
    }

    // (b) Pay bill B from bitcoin, through the Morpho disclaimer.
    {
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${B}`);
      await page.locator('[data-action="pay-bitcoin"]:not([disabled])').waitFor({ timeout: 60_000 });
      await page.locator('[data-action="pay-bitcoin"]').click();
      const dialog = page.getByRole('dialog');
      await dialog.waitFor({ timeout: 10_000 });
      const disclaimer = await dialog.innerText();
      await shoot(page, 'b-disclaimer');
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      await page.locator('[data-tx-result="paid"]').waitFor({ timeout: 120_000 });
      await page.getByRole('img', { name: 'Status: Paid' }).first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      const card = await page.locator('[data-tx-result="paid"]').innerText();
      await shoot(page, 'b-paid');
      const log = await billPaidLog(B);
      const remembered = await page.evaluate((a) => localStorage.getItem(`adag-morpho-disclaimer:${a.toLowerCase()}`), PAYER);
      record(`(b) bill #${B} paid from bitcoin: disclaimer, PAID, loan-to-value shown, loanChecked true on the fork`,
        disclaimer.includes("Accessing the Morpho Protocol through this app is governed by Adag's Terms of Use and Morpho's Disclaimer")
          && remembered === 'accepted' && (await statusOf(B)) === 2 && log?.args.loanChecked === true
          // innerText follows the CSS, and the labels are uppercased there.
          && /Loan-to-value after\s*\n?\s*\d+\.\d\d%/i.test(card) && /Bitcoin sold\s*\n?\s*0 cirBTC/i.test(card),
        `BillPaid loanChecked ${log?.args.loanChecked}; card: ${card.replace(/\s*\n\s*/g, ' | ')}`);
      await context.close();
    }

    // (c) The payee voids bill C.
    {
      const { context, page } = await openPage({ account: PAYEE });
      await connect(page, `/bill/${C}`);
      await page.locator('[data-action="void"]').click();
      await shoot(page, 'c-confirm');
      await page.locator('[data-action="void-confirm"]').click();
      await page.locator('[data-tx-result="void"]').waitFor({ timeout: 120_000 });
      await page.getByRole('img', { name: 'Status: Void' }).first().waitFor({ timeout: 60_000 });
      await shoot(page, 'c-void');
      record(`(c) the payee voids bill #${C}: VOID in the UI and on the fork`, (await statusOf(C)) === 3, `fork status ${await statusOf(C)}`);
      await context.close();
    }

    const snapshot = await rpc('evm_snapshot');

    // (d) 27 hours pass: the bitcoin path goes, paying from balance stays.
    {
      await rpc('evm_increaseTime', [27 * 3600]);
      await rpc('evm_mine');
      const D = newBill('USDC', 100_000, 'E2E-D');
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${D}`);
      await page.locator('[data-price="stale"]').first().waitFor({ timeout: 60_000 });
      const noBitcoin = (await page.locator('[data-action="pay-bitcoin"]').count()) === 0;
      const message = await page.locator('[data-price="stale"]').first().innerText();
      await shoot(page, 'd-stale');
      await page.locator('[data-action="pay-balance"]').click();
      await page.locator('[data-tx-result="paid"]').waitFor({ timeout: 120_000 });
      await shoot(page, 'd-paid-from-balance');
      record(`(d) after 27 hours, bill #${D}: no bitcoin button, the stale-price message, paid from balance`,
        noBitcoin && message.includes(STALE_SENTENCE) && (await statusOf(D)) === 2, `message: ${message}`);
      await context.close();
    }

    await rpc('evm_revert', [snapshot]);
    await rpc('evm_mine');

    // (e) The wallet says it is on Ethereum: Switch to Arc, and no transaction is requested.
    const E = newBill('USDC', 100_000, 'E2E-E');
    {
      const { context, page } = await openPage({ account: PAYER, chainOverride: '0x1' });
      await page.goto(`${APP}/bill/${E}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await page.getByRole('button', { name: 'Connect wallet' }).first().click();
      await page.getByRole('button', { name: 'Switch to Arc' }).first().waitFor({ timeout: 60_000 });
      await page.locator('[data-blocked="true"]').waitFor({ timeout: 30_000 });
      const buttons = await page.locator('[data-action^="pay-"]').count();
      await shoot(page, 'e-wrong-chain');
      const sent = await sends(page);
      record(`(e) a wallet on chain 1: Switch to Arc shows, no pay buttons, no transaction requested`, buttons === 0 && sent === 0 && (await statusOf(E)) === 1,
        `pay buttons ${buttons}, eth_sendTransaction requests ${sent}`);
      await context.close();
    }

    // (f) A forced under-pledge: the dry run refuses it in plain words and nothing is sent.
    {
      const { context, page } = await openPage({ account: PAYER });
      await context.addInitScript(() => { window.__adagE2EPledgePercent = 70; });
      await page.evaluate((a) => localStorage.setItem(`adag-morpho-disclaimer:${a.toLowerCase()}`, 'accepted'), PAYER).catch(() => {});
      await connect(page, `/bill/${E}`);
      await page.evaluate(() => { window.__adagE2EPledgePercent = 70; });
      await page.locator('[data-action="pay-bitcoin"]:not([disabled])').waitFor({ timeout: 60_000 });
      await page.locator('[data-action="pay-bitcoin"]').click();
      if (await page.getByRole('dialog').isVisible().catch(() => false)) {
        await page.getByRole('dialog').getByRole('checkbox').check();
        await page.getByRole('dialog').getByRole('button', { name: 'Continue to payment' }).click();
      }
      await page.locator('[data-tx-state="refused"]').waitFor({ timeout: 60_000 });
      const text = await page.locator('[data-tx-state="refused"]').innerText();
      await shoot(page, 'f-refused');
      const sent = await sends(page);
      record(`(f) a 30% under-pledge on bill #${E}: the dry run shows the LtvAboveLimit sentence and nothing is sent`,
        text.includes(LTV_SENTENCE) && sent === 0 && (await statusOf(E)) === 1, `shown: ${text.replace(/\s*\n\s*/g, ' ')}; eth_sendTransaction requests ${sent}`);
      await context.close();
    }

    // (g) The payee writes a bill through /bill/new with a non-ASCII reference.
    const G_REF = 'E2E-G · café';
    let G = null;
    {
      const { context, page } = await openPage({ account: PAYEE });
      await connect(page, '/bill/new').catch(() => {});
      await page.locator('[data-action="write-bill"]').waitFor({ timeout: 60_000 });
      await page.locator('[data-field="amount"]').fill('0.25');
      await page.locator('[data-field="ref"]').fill(G_REF);
      const dueInput = await page.locator('input[type="date"]').inputValue();
      await page.waitForTimeout(1200);
      await shoot(page, 'f7-g-form');
      await page.locator('[data-action="write-bill"]').click();
      const card = page.locator('[data-tx-result="created"]');
      await card.waitFor({ timeout: 120_000 });
      await page.locator('[data-drawn-number]').waitFor({ timeout: 10_000 });
      G = BigInt(await card.getAttribute('data-bill-id'));
      const link = await page.locator('[data-share-link]').innerText();
      await page.waitForTimeout(1600);
      await shoot(page, 'f7-g-written');
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dueInput);
      const wantDue = m ? BigInt(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12) / 1000) : -1n;
      const onFork = await fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [G] });
      await page.goto(`${APP}/bill/${G}`, { waitUntil: 'networkidle', timeout: 120_000 });
      const openStamp = await page.getByRole('img', { name: 'Status: Open' }).first().isVisible();
      await shoot(page, 'f7-g-bill-page');
      record(`(g) the payee writes bill #${G} (0.25 USDC, "${G_REF}") through /bill/new; it reads OPEN`,
        link.endsWith(`/bill/${G}`) && onFork.amount === 250_000n && onFork.due === wantDue && onFork.ref === stringToHex(G_REF)
          && onFork.payee.toLowerCase() === PAYEE.toLowerCase() && onFork.status === 1 && openStamp,
        `link ${link}; fork amount ${onFork.amount}, due ${onFork.due} (want ${wantDue}), ref ${onFork.ref} (want ${stringToHex(G_REF)})`);
      await context.close();
    }

    // (h) The payer adds 0.00001 cirBTC to the USDC loan from /app, then (i) closes it.
    {
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, '/app').catch(() => {});
      const ticket = page.locator('[data-loan="USDC"]');
      await ticket.waitFor({ timeout: 60_000 });
      await page.waitForFunction(() => document.querySelector('[data-loan="USDC"]')?.getAttribute('data-ltv') !== '', null, { timeout: 60_000 });
      const ltvBefore = Number(await ticket.getAttribute('data-ltv'));
      const before = await positionOf(PAYER);
      await shoot(page, 'f7-h-app');
      await ticket.locator('[data-field="add-collateral"]').fill('0.00001');
      await ticket.locator('[data-action="add-collateral"]').click();
      const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
      if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      }
      await ticket.locator('[data-tx-result="added"]').waitFor({ timeout: 120_000 });
      await page.waitForFunction((b) => Number(document.querySelector('[data-loan="USDC"]')?.getAttribute('data-ltv')) < b, ltvBefore, { timeout: 60_000 }).catch(() => {});
      const ltvAfter = Number(await ticket.getAttribute('data-ltv'));
      const after = await positionOf(PAYER);
      await shoot(page, 'f7-h-added');
      record('(h) the payer adds 0.00001 cirBTC from /app: Morpho collateral +1000 sat, the gauge moves down',
        after[2] - before[2] === 1_000n && ltvAfter < ltvBefore,
        `pledged ${before[2]} -> ${after[2]} sat; gauge ${ltvBefore}% -> ${ltvAfter}%`);

      const pledge = after[2];
      const btcBefore = await cirBtcOf(PAYER);
      await ticket.getByRole('tab', { name: 'Close loan' }).click();
      await ticket.locator('[data-action="close-loan"]').waitFor({ timeout: 30_000 });
      await shoot(page, 'f7-i-close');
      await ticket.locator('[data-action="close-loan"]').click();
      await ticket.locator('[data-tx-result="closed"]').waitFor({ timeout: 120_000 });
      const text = await ticket.locator('[data-tx-result="closed"]').innerText();
      await shoot(page, 'f7-i-closed');
      const end = await positionOf(PAYER);
      const back = (await cirBtcOf(PAYER)) - btcBefore;
      const allowance = await fork.readContract({ address: USDC, abi: tokenAbi, functionName: 'allowance', args: [PAYER, MORPHO] });
      record('(i) the payer closes the USDC loan from /app: 0 shares, 0 pledged, all cirBTC back, allowance 0',
        end[1] === 0n && end[2] === 0n && back === pledge && allowance === 0n && text.includes('Loan closed. 0 owed, 0 pledged.'),
        `after: ${end[1]} shares, ${end[2]} pledged; cirBTC back ${back} of ${pledge} sat; USDC allowance to Morpho ${allowance}; shown: ${text.split('\n')[0]}`);
      await context.close();
    }

    // (j) The lists: the payee's written bills with their stamps, the payer's paid bills.
    {
      const want = [[A, 'paid'], [B, 'paid'], [C, 'void'], [E, 'open'], [G, 'open']];
      const { context, page } = await openPage({ account: PAYEE });
      await connect(page, '/app').catch(() => {});
      await page.locator('[data-list="wrote"] [data-bill-row]').first().waitFor({ timeout: 60_000 });
      const rows = await page.locator('[data-list="wrote"] [data-bill-row]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-bill-row'), e.getAttribute('data-status')]));
      await shoot(page, 'f7-j-payee-lists');
      await context.close();
      const wroteOk = want.every(([id, status]) => rows.some(([r, s]) => r === String(id) && s === status));
      const newestFirst = rows.map(([r]) => Number(r)).every((v, i, arr) => i === 0 || arr[i - 1] > v);

      const p2 = await openPage({ account: PAYER });
      await connect(p2.page, '/app').catch(() => {});
      await p2.page.locator('[data-list="paid"] [data-bill-row]').first().waitFor({ timeout: 60_000 });
      const paid = await p2.page.locator('[data-list="paid"] [data-bill-row]').evaluateAll((els) => els.map((e) => e.getAttribute('data-bill-row')));
      await shoot(p2.page, 'f7-j-payer-lists');
      await p2.context.close();
      record("(j) /app lists the payee's written bills with the right stamps, newest first, and the payer's paid bills",
        wroteOk && newestFirst && paid.includes(String(A)) && paid.includes(String(B)),
        `wrote: ${rows.map(([r, s]) => `#${r} ${s}`).join(', ')}; paid: ${paid.map((r) => `#${r}`).join(', ')}`);
    }

    // (k) The form refuses a zero amount and a 141-byte reference before any wallet request.
    {
      const { context, page } = await openPage({ account: PAYEE });
      await connect(page, '/bill/new').catch(() => {});
      const button = page.locator('[data-action="write-bill"]');
      await button.waitFor({ timeout: 60_000 });
      await page.locator('[data-field="amount"]').fill('0');
      const zeroMsg = await page.locator('[data-error="amount"]').innerText();
      const zeroBlocked = await button.isDisabled();
      await button.click({ force: true }).catch(() => {});
      await page.locator('[data-field="amount"]').fill('1');
      await page.locator('[data-field="ref"]').fill('x'.repeat(141));
      const refMsg = await page.locator('[data-error="ref"]').innerText();
      const refBlocked = await button.isDisabled();
      await button.click({ force: true }).catch(() => {});
      await page.waitForTimeout(800);
      await shoot(page, 'f7-k-refused');
      const sent = await sends(page);
      record('(k) /bill/new refuses amount 0 and a 141-byte reference, with no wallet request',
        zeroBlocked && refBlocked && sent === 0 && zeroMsg.includes('more than zero') && refMsg.includes('141 bytes'),
        `amount 0: "${zeroMsg}"; 141 bytes: "${refMsg}"; eth_sendTransaction requests ${sent}`);
      await context.close();
    }

    const acceptDisclaimer = async (page) => {
      const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
      if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      }
    };
    const eurcPositionOf = (who) => fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_EURC, who] });

    // (l) A EURC loan, round trip: pay a EURC bill from bitcoin, then close that loan from /app.
    {
      const L = newBill('EURC', 200_000, 'E2E-L');
      const { context, page } = await openPage({ account: PAYER });
      // With the USDC loan closed in (i), both markets are empty: two quiet tickets.
      await connect(page, '/app').catch(() => {});
      await page.locator('[data-loan-ghost="EURC"]').waitFor({ timeout: 60_000 });
      const ghostsWhenEmpty = await page.locator('[data-loan-ghost]').count();
      await shoot(page, 'f7b-ghost-empty');

      await page.goto(`${APP}/bill/${L}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await page.locator('[data-action="pay-bitcoin"]:not([disabled])').waitFor({ timeout: 60_000 });
      await page.locator('[data-action="pay-bitcoin"]').click();
      await acceptDisclaimer(page);
      await page.locator('[data-tx-result="paid"]').waitFor({ timeout: 120_000 });
      const paidLog = await billPaidLog(L);
      const opened = await eurcPositionOf(PAYER);
      const pledge = opened[2];
      console.log(`  (l) bill #${L} paid from bitcoin: EURC loan ${opened[1]} shares against ${pledge} sat; funding the payer with 1 EURC to repay: ${forkScript('fund-eurc', PAYER, '1000000')}`);

      await page.goto(`${APP}/app`, { waitUntil: 'networkidle', timeout: 120_000 });
      const ticket = page.locator('[data-loan="EURC"]');
      await ticket.waitFor({ timeout: 60_000 });
      const usdcGhost = await page.locator('[data-loan-ghost="USDC"]').count();
      await ticket.getByRole('tab', { name: 'Close loan' }).click();
      await ticket.locator('[data-action="close-loan"]').waitFor({ timeout: 30_000 });
      await shoot(page, 'f7b-l-eurc-ticket');
      const btcBefore = await cirBtcOf(PAYER);
      const nativeBefore = await fork.getBalance({ address: PAYER });
      await ticket.locator('[data-action="close-loan"]').click();
      await acceptDisclaimer(page);
      await ticket.locator('[data-tx-result="closed"]').waitFor({ timeout: 120_000 });
      const text = await ticket.locator('[data-tx-result="closed"]').innerText();
      const href = await ticket.locator('[data-tx-result="closed"] a').getAttribute('href');
      await shoot(page, 'f7b-l-closed');
      const hash = href.split('/tx/')[1];
      const receipt = await fork.getTransactionReceipt({ hash });
      const fee = receipt.gasUsed * receipt.effectiveGasPrice;
      const nativeDrop = nativeBefore - (await fork.getBalance({ address: PAYER }));
      const end = await eurcPositionOf(PAYER);
      const back = (await cirBtcOf(PAYER)) - btcBefore;
      const allowance = await fork.readContract({ address: EURC, abi: tokenAbi, functionName: 'allowance', args: [PAYER, MORPHO] });
      record('(l) a EURC loan round trip: paid from bitcoin, closed from /app, fee paid in USDC',
        ghostsWhenEmpty === 2 && paidLog?.args.loanChecked === true && opened[1] > 0n && usdcGhost === 1
          && end[1] === 0n && end[2] === 0n && back === pledge && allowance === 0n && fee > 0n && nativeDrop === fee && text.includes('Loan closed. 0 owed, 0 pledged.'),
        `bill #${L} loanChecked ${paidLog?.args.loanChecked}; after close: ${end[1]} shares, ${end[2]} pledged; cirBTC back ${back} of ${pledge} sat; EURC allowance ${allowance}; fee ${fee} wei of USDC, USDC balance fell ${nativeDrop}`);
      await context.close();
    }

    // (m) Withdraw only: bitcoin pledged with no debt comes back, and a standing approval is left alone.
    {
      const params = `(${USDC},${CIRBTC},0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab,0xF02615d094Fc02fC031C35fe705e175aA4653f20,860000000000000000)`;
      const steps = [
        forkScript('send', PAYER, USDC, 'approve(address,uint256)', MORPHO, '5000000'),
        forkScript('send', PAYER, CIRBTC, 'approve(address,uint256)', MORPHO, '1000'),
        forkScript('send', PAYER, MORPHO, 'supplyCollateral((address,address,address,address,uint256),uint256,address,bytes)', params, '1000', PAYER, '0x'),
      ];
      const start = await positionOf(PAYER);
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, '/app').catch(() => {});
      const ticket = page.locator('[data-loan="USDC"]');
      await ticket.waitFor({ timeout: 60_000 });
      await ticket.getByRole('tab', { name: 'Take your bitcoin back' }).click();
      const button = ticket.locator('[data-action="close-loan"]');
      await button.waitFor({ timeout: 30_000 });
      const label = await button.innerText();
      await shoot(page, 'f7b-m-take-back');
      const btcBefore = await cirBtcOf(PAYER);
      await button.click();
      await acceptDisclaimer(page);
      await ticket.locator('[data-tx-result="closed"]').waitFor({ timeout: 120_000 });
      const text = await ticket.locator('[data-tx-result="closed"]').innerText();
      await shoot(page, 'f7b-m-taken-back');
      const end = await positionOf(PAYER);
      const back = (await cirBtcOf(PAYER)) - btcBefore;
      const standing = await fork.readContract({ address: USDC, abi: tokenAbi, functionName: 'allowance', args: [PAYER, MORPHO] });
      record('(m) withdraw only: "Take your bitcoin back" returns all 1000 sat, and the standing 5 USDC approval is untouched',
        steps.every((x) => x.includes('"status":"0x1"')) && start[1] === 0n && start[2] === 1_000n && label === 'Take your bitcoin back'
          && end[1] === 0n && end[2] === 0n && back === 1_000n && standing === 5_000_000n && text.includes('0 pledged'),
        `set-up ${steps.join(' ')}; before: ${start[1]} shares, ${start[2]} pledged; after: ${end[1]} and ${end[2]}; back ${back} sat; USDC approval to Morpho ${standing}; shown: ${text.split('\n')[0]}`);
      await context.close();
    }

    // (n) The comma rule on /bill/new: a lone comma is the decimal mark; thousands separators are refused.
    {
      const { context, page } = await openPage({ account: PAYEE });
      await connect(page, '/bill/new').catch(() => {});
      await page.locator('[data-action="write-bill"]').waitFor({ timeout: 60_000 });
      await page.locator('[data-field="amount"]').fill('12,50');
      await page.locator('[data-field="ref"]').fill('E2E-N');
      await page.waitForTimeout(800);
      const preview = await page.locator('[data-preview]').innerText();
      await shoot(page, 'f7b-n-comma-preview');
      await page.locator('[data-action="write-bill"]').click();
      const card = page.locator('[data-tx-result="created"]');
      await card.waitFor({ timeout: 120_000 });
      const N = BigInt(await card.getAttribute('data-bill-id'));
      const onFork = await fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [N] });
      await context.close();

      const p2 = await openPage({ account: PAYEE });
      await connect(p2.page, '/bill/new').catch(() => {});
      const button = p2.page.locator('[data-action="write-bill"]');
      await button.waitFor({ timeout: 60_000 });
      await p2.page.locator('[data-field="amount"]').fill('1,250.50');
      const message = await p2.page.locator('[data-error="amount"]').innerText();
      const blocked = await button.isDisabled();
      await button.click({ force: true }).catch(() => {});
      await p2.page.waitForTimeout(800);
      await shoot(p2.page, 'f7b-n-refused');
      const sent = await sends(p2.page);
      await p2.context.close();
      record('(n) "12,50" previews 12.50 and writes 12500000; "1,250.50" is refused with no wallet request',
        /12\.50/.test(preview) && onFork.amount === 12_500_000n && message.includes('one decimal mark') && blocked && sent === 0,
        `bill #${N} amount ${onFork.amount}; "1,250.50": "${message}"; eth_sendTransaction requests ${sent}`);
    }

    // The mobile menu open, and the wallet page before connecting.
    {
      const { context, page } = await openPage({ account: PAYER, width: 375, theme: 'light' });
      await page.goto(`${APP}/app`, { waitUntil: 'networkidle', timeout: 120_000 });
      await page.waitForTimeout(1200);
      if (process.argv.includes('--all-shots')) await page.screenshot({ path: `${SHOTS}/f7-app-connect-375-light.png`, fullPage: true });
      await page.locator('[data-action="menu"]').click();
      await page.getByRole('dialog', { name: 'Menu' }).waitFor({ timeout: 10_000 });
      await page.waitForTimeout(900);
      if (process.argv.includes('--all-shots')) await page.screenshot({ path: `${SHOTS}/f7-menu-open-375-light.png` });
      await page.keyboard.press('Escape');
      // The sheet animates out over 0.3 seconds, so wait for it rather than checking the same instant.
      const closedOnEscape = await page.getByRole('dialog', { name: 'Menu' }).waitFor({ state: 'hidden', timeout: 3_000 }).then(() => true, () => false);
      if (!closedOnEscape) consoleErrors.push('the mobile menu did not close on Escape');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
      await page.waitForTimeout(900);
      if (process.argv.includes('--all-shots')) await page.screenshot({ path: `${SHOTS}/f7-app-connect-1440-dark.png`, fullPage: true });
      await context.close();
    }
  } finally {
    await browser?.close();
    stopApp(app);
  }
}

let code = 1;
try {
  await main();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nconsole errors: ${consoleErrors.length}${consoleErrors.length ? `\n  ${consoleErrors.join('\n  ')}` : ''}`);
  const allOk = passed === results.length && results.length === 14 && consoleErrors.length === 0;
  console.log(allOk ? `ALL ${passed} SCENARIOS PASSED` : `${results.length - passed} of ${results.length} scenarios failed`);
  code = allOk ? 0 : 1;
} catch (error) {
  console.error(`\nSTOPPED: ${error?.stack ?? error}`);
} finally {
  // .next-e2e is not in .gitignore, so the fork build never outlives the run.
  rmSync(resolve(WEB, DIST), { recursive: true, force: true });
  try {
    console.log(forkScript('stop'));
  } catch (error) {
    console.error(`could not stop the fork: ${error.message}`);
  }
}
process.exit(code);
