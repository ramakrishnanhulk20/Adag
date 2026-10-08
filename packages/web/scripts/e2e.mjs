// Drives the real bill page against an Arc mainnet fork where the transactions really execute. It starts arc-anvil
// in WSL, has the demo payee write bills, builds and serves a second copy of the app on :3400 pointed at the fork,
// and clicks through the money actions in Chromium with an injected wallet that forwards everything to the fork.
//
//   node scripts/e2e.mjs            (from packages/web)
//
// Exits 0 only if every scenario passes. Nothing is signed for or sent to Arc mainnet.
import { spawn, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createServer } from 'node:http';
import { createPublicClient, decodeFunctionData, encodeFunctionData, formatUnits, getAddress, http, keccak256, parseAbi, parseAbiItem, parseEventLogs, parseUnits, recoverTypedDataAddress, stringToHex, toFunctionSelector } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Screenshots are proof for review, not part of the product, so they land in an ignored folder unless told otherwise:
//   node scripts/e2e.mjs --shots-dir=<folder>
const shotsArg = process.argv.find((a) => a.startsWith('--shots-dir='));
const SHOTS = shotsArg ? resolve(shotsArg.slice('--shots-dir='.length)) : resolve(WEB, '.e2e-shots');
mkdirSync(SHOTS, { recursive: true });
const FORK = 'http://127.0.0.1:8545';
const APP = 'http://localhost:3400';
const DIST = '.next-e2e';
const DUMMY_PROJECT_ID = 'e2e0000000000000000000000000000e';

const PAYER = '0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE';
const PAYEE = '0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B';
// The current AdagBills, where the app writes and pays new bills, and the first deployment, which stays payable.
const ADAG = '0xaf6C47ae3e2ccD2Cd829Dd8a1DcCb7a7665c08cB';
const ADAG_FIRST = '0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E';
const GUARD = '0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806';
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
  'function loanToValue(address user, bytes32 marketId) view returns (uint256)',
  'function billsOfPayee(address payee, uint256 offset, uint256 limit) view returns (uint256[] ids, uint256 total)',
  'function paymentsOfPayer(address payer, uint256 offset, uint256 limit) view returns (uint256[] ids, uint256 total)',
]);
const billPaidEvent = parseAbiItem('event BillPaid(uint256 indexed id, address indexed payer, address indexed payee, address currency, uint256 amount, bool loanChecked)');
const fork = createPublicClient({ transport: http(FORK, { timeout: 60_000 }) });
const positionOf = (who) => fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_USDC, who] });
const cirBtcOf = (who) => fork.readContract({ address: CIRBTC, abi: tokenAbi, functionName: 'balanceOf', args: [who] });

const results = [];
const consoleErrors = [];
const cspMessages = [];
// Errors the browser logs for a failing answer from Circle that is expected: the one this run stubbed on purpose (scenario fx-c), and
// the real "no route" or rate-limit answers that the pay and close pages repeat by design. They are counted and shown, not hidden: only
// a failing answer from api.circle.com on a page opened to expect one is set aside.
const stubbedCircleErrors = [];
// --fx-only runs just the cross-currency scenarios against a fresh fork: for working on those screens without the rest.
const FX_ONLY = process.argv.includes('--fx-only');
const FX_SCENARIOS = 8;
const record = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

// The fork fetches Arc's state from the public RPC the first time anything touches it, and WSL's name lookup drops for a few
// seconds now and then. A command that failed only for that reason is tried again; any other failure stops the run.
const FORK_NETWORK_HICCUP = /dns error|failed to lookup address|error sending request for url \(https:\/\/rpc\.mainnet\.arc\.io/;
function forkScript(...args) {
  for (let attempt = 1; ; attempt++) {
    const r = spawnSync('bash', [resolve(WEB, 'scripts/e2e-fork.sh'), ...args], { encoding: 'utf8', shell: false });
    if (r.status === 0) return r.stdout.trim();
    const said = r.stderr || r.stdout;
    if (attempt >= 4 || args[0] === 'start' || !FORK_NETWORK_HICCUP.test(said)) throw new Error(`e2e-fork.sh ${args.join(' ')} failed: ${said}`);
    console.log(`  the fork lost its network for a moment (${args[0]}, attempt ${attempt}); trying again`);
    spawnSync('bash', ['-c', 'sleep 6']);
  }
}
const newBill = (currency, amount, ref, contract = 'current') => BigInt(forkScript('bill', currency, String(amount), ref, contract).split('\n').at(-1));
const rpc = (method, params = []) => fork.request({ method, params });
// A transaction mined on Arc itself, long before this run, is fetched by the fork from Arc's own public RPC on demand, and that
// RPC no longer returns receipts this old (checked on 7 October 2026: it answers null where dRPC returns the receipt). So the fork
// is asked first and, when it has nothing, dRPC is, which is read-only and returns the same chain's receipt.
const archive = createPublicClient({ transport: http('https://rpc.drpc.mainnet.arc.io', { timeout: 60_000 }) });
async function oldReceipt(hash) {
  try {
    return await fork.getTransactionReceipt({ hash });
  } catch {
    return archive.getTransactionReceipt({ hash });
  }
}

const USDC_PARAMS = `(${USDC},${CIRBTC},0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab,0xF02615d094Fc02fC031C35fe705e175aA4653f20,860000000000000000)`;
const EURC_PARAMS = `(${EURC},${CIRBTC},0x6945246777DfdF4744D957323857F797Ec19Ca1e,0xF02615d094Fc02fC031C35fe705e175aA4653f20,860000000000000000)`;
const MP = '(address,address,address,address,uint256)';
const guardAbi = parseAbi(['function ruleOf(address borrower, bytes32 marketId) view returns ((uint64 triggerWad, uint64 targetWad, uint64 expiry))']);
const START_USDC = 10n * 10n ** 18n;

// The demo payer is a real wallet, and its live loan and AdagGuard rule change whenever the live proofs run. So every
// run first puts it in one known state, on the fork only, by impersonation: no loan and no pledge in either market,
// no guard rule, no approval to the guard, and 10 USDC.
async function resetPayer() {
  const done = [];
  for (const [symbol, market, token, params] of [['USDC', MARKET_USDC, USDC, USDC_PARAMS], ['EURC', MARKET_EURC, EURC, EURC_PARAMS]]) {
    const [, shares, collateral] = await fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [market, PAYER] });
    if (shares > 0n) {
      if (token === EURC) forkScript('fund-eurc', PAYER, '5000000');
      else await rpc('anvil_setBalance', [PAYER, `0x${START_USDC.toString(16)}`]);
      forkScript('send', PAYER, token, 'approve(address,uint256)', MORPHO, '50000000');
      forkScript('send', PAYER, MORPHO, `repay(${MP},uint256,uint256,address,bytes)`, params, '0', String(shares), PAYER, '0x');
      forkScript('send', PAYER, token, 'approve(address,uint256)', MORPHO, '0');
      done.push(`${symbol} loan of ${shares} shares repaid`);
    }
    if (collateral > 0n) {
      forkScript('send', PAYER, MORPHO, `withdrawCollateral(${MP},uint256,address,address)`, params, String(collateral), PAYER, PAYER);
      done.push(`${collateral} sat of ${symbol} pledge withdrawn`);
    }
    const rule = await fork.readContract({ address: GUARD, abi: guardAbi, functionName: 'ruleOf', args: [PAYER, market] });
    if (rule.triggerWad !== 0n || rule.targetWad !== 0n) {
      forkScript('send', PAYER, GUARD, 'clearRule(bytes32)', market);
      done.push(`${symbol} guard rule cleared`);
    }
  }
  for (const [symbol, token] of [['USDC', USDC], ['EURC', EURC]]) {
    if ((await fork.readContract({ address: token, abi: tokenAbi, functionName: 'allowance', args: [PAYER, GUARD] })) > 0n) {
      forkScript('send', PAYER, token, 'approve(address,uint256)', GUARD, '0');
      done.push(`${symbol} approval to the guard zeroed`);
    }
  }
  await rpc('anvil_setBalance', [PAYER, `0x${START_USDC.toString(16)}`]);
  const check = await Promise.all([
    ...[MARKET_USDC, MARKET_EURC].map((m) => fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [m, PAYER] })),
    ...[MARKET_USDC, MARKET_EURC].map((m) => fork.readContract({ address: GUARD, abi: guardAbi, functionName: 'ruleOf', args: [PAYER, m] })),
    ...[USDC, EURC].map((t) => fork.readContract({ address: t, abi: tokenAbi, functionName: 'allowance', args: [PAYER, GUARD] })),
  ]);
  const clean = check[0][1] === 0n && check[0][2] === 0n && check[1][1] === 0n && check[1][2] === 0n
    && check[2].triggerWad === 0n && check[3].triggerWad === 0n && check[4] === 0n && check[5] === 0n;
  if (!clean) throw new Error('the demo payer could not be reset on the fork');
  return done.length ? done.join('; ') : 'already clean';
}
const statusOf = async (id) => (await fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [id] })).status;

async function billPaidLog(id) {
  const logs = await fork.getLogs({ address: ADAG, event: billPaidEvent, args: { id }, fromBlock: (await fork.getBlockNumber()) - 50n });
  return logs.at(-1) ?? null;
}

const nextBin = resolve(WEB, 'node_modules/next/dist/bin/next');
const MOCK_PORT = 8599;
const appEnv = {
  ...process.env,
  NEXT_DIST_DIR: DIST,
  NEXT_PUBLIC_ARC_RPC_URL: FORK,
  NEXT_PUBLIC_ADAG_E2E: '1',
  ARC_RPC_URL: FORK,
  ARC_RPC_FALLBACK_URL: FORK,
  // The Safe routes talk to the harness's stand-in Transaction Service, never Safe's real one, and with a dummy key.
  SAFE_API_KEY: 'e2e-mock-key',
  SAFE_TX_SERVICE_URL: `http://127.0.0.1:${MOCK_PORT}/api`,
  // A fixed dummy id, so the Reown wallet modal loads. Every request it makes to Reown is answered by a stub (see
  // stubReown), so nothing leaves the machine and phone wallets over WalletConnect are not covered here.
  NEXT_PUBLIC_WC_PROJECT_ID: DUMMY_PROJECT_ID,
  // The Safe routes need a store for their rate limits; main() points these at a local stand-in before the build.
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  KV_REST_API_URL: '',
  KV_REST_API_TOKEN: '',
  ADAG_STORE_NAMESPACE: '',
};
const { startMockUpstash } = await import(new URL('../src/lib/store/test/mock-upstash.mjs', import.meta.url).href);

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
// eth_sendTransaction really executes. window.__e2eMoveTo(chain) has the wallet leave Arc after it connected, to test
// the Arc gate. Like a real wallet it shows no accounts to a site until approved, and it also announces itself over
// EIP-6963 as "E2E Wallet", which is how the Reown modal lists it.
function walletScript({ account, fork, addArcFlow }) {
  window.__walletLog = [];
  window.__addChainParams = [];
  let id = 0;
  let chain = null;
  let arcAdded = false;
  const approvedKey = '__e2eApproved';
  const approved = () => {
    try {
      return Boolean(localStorage.getItem(approvedKey));
    } catch {
      return false;
    }
  };
  const approve = () => {
    try {
      localStorage.setItem(approvedKey, '1');
    } catch {}
  };
  const forward = async (method, params) => {
    const res = await fetch(fork, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, params: params ?? [] }) });
    const json = await res.json();
    if (json.error) throw Object.assign(new Error(json.error.message), json.error);
    return json.result;
  };
  const listeners = {};
  const provider = {
    isMetaMask: true,
    async request({ method, params }) {
      window.__walletLog.push(method);
      if (method === 'eth_chainId' && chain) return chain;
      if (method === 'net_version' && chain) return String(parseInt(chain, 16));
      if (method === 'eth_accounts') return approved() ? [account] : [];
      if (method === 'eth_requestAccounts') {
        approve();
        return [account];
      }
      if (method === 'wallet_requestPermissions') {
        approve();
        return [{ parentCapability: 'eth_accounts' }];
      }
      if (method === 'wallet_getPermissions') return approved() ? [{ parentCapability: 'eth_accounts' }] : [];
      // A wallet that has never seen Arc: switching fails with 4902 until Arc is added, as MetaMask does.
      if (addArcFlow && method === 'wallet_switchEthereumChain') {
        if (!arcAdded) throw Object.assign(new Error('Unrecognized chain ID "0x13b2".'), { code: 4902 });
        chain = null;
        (listeners.chainChanged || []).forEach((fn) => fn('0x13b2'));
        return null;
      }
      if (addArcFlow && method === 'wallet_addEthereumChain') {
        window.__addChainParams.push(params[0]);
        arcAdded = true;
        chain = null;
        (listeners.chainChanged || []).forEach((fn) => fn('0x13b2'));
        return null;
      }
      if (method === 'wallet_switchEthereumChain' || method === 'wallet_addEthereumChain') throw Object.assign(new Error('User rejected the request.'), { code: 4001 });
      if (method === 'eth_sendTransaction') return forward(method, [{ ...params[0], from: account }]);
      // A Safe owner's EIP-712 signature comes from the harness, which holds that owner's test key.
      if (method === 'eth_signTypedData_v4' && typeof window.__e2eSign === 'function') return window.__e2eSign(params[1]);
      return forward(method, params);
    },
    on(event, fn) { (listeners[event] ||= []).push(fn); },
    removeListener(event, fn) { listeners[event] = (listeners[event] || []).filter((f) => f !== fn); },
  };
  window.ethereum = provider;
  window.__e2eMoveTo = (next) => {
    chain = next;
    arcAdded = false;
    (listeners.chainChanged || []).forEach((fn) => fn(next));
  };
  const icon = `data:image/svg+xml;base64,${btoa('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#D9A94A"/></svg>')}`;
  const info = { uuid: 'e2e00000-0000-4000-8000-000000000001', name: 'E2E Wallet', icon, rdns: 'dev.adag.e2e' };
  const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }));
  window.addEventListener('eip6963:requestProvider', announce);
  announce();
}

// Reown's modal calls its own servers for its settings, wallet list, logos, wallet names and usage numbers. Every one
// of those requests is answered here, so a run never reaches Reown or WalletConnect and the console stays clean.
// Answers are plain JSON with a 200, because a 404 would itself be logged by the browser as a console error.
const REOWN_HOSTS = /^(https?|wss?):\/\/([a-z0-9-]+\.)*(web3modal\.(org|com)|walletconnect\.(org|com)|reown\.com)(:\d+)?\//i;
const reownRequests = [];
async function stubReown(context) {
  await context.route(REOWN_HOSTS, (route) => {
    const url = new URL(route.request().url());
    reownRequests.push(`${route.request().method()} ${url.host}${url.pathname}`);
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
    const json = (body) => route.fulfill({ status: 200, contentType: 'application/json', headers: cors, body: JSON.stringify(body) });
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (url.pathname.endsWith('/appkit/v1/config')) return json({ features: null });
    if (url.pathname.endsWith('/project-limits')) return json({ planLimits: { tier: 'starter', isAboveMauLimit: false, isAboveRpcLimit: false } });
    if (url.pathname.endsWith('/getWallets')) return json({ count: 0, data: [] });
    if (url.host.startsWith('pulse.')) return route.fulfill({ status: 204, headers: cors });
    return json({});
  });
  await context.routeWebSocket(REOWN_HOSTS, (socket) => socket.close());
}

// Playwright's CSS locators pierce the modal's open shadow roots. The sheet slides in, so the row is clicked as an
// element and not at a screen position that is still moving.
async function pickWallet(page) {
  const row = page.locator('wui-list-wallet[name="E2E Wallet"]');
  await row.waitFor({ timeout: 30_000 });
  await row.evaluate((el) => el.click());
}

// Pressing Connect wallet opens the Reown modal, where the fake wallet is the only browser wallet listed.
async function clickConnect(page, which = 'first') {
  await page.getByRole('button', { name: 'Connect wallet' })[which]().click();
  await pickWallet(page);
}

// After a reload the approved wallet reconnects by itself, so the button may never appear. The button can also flash
// before that reconnect lands, so it is looked at once more after a moment.
async function connectIfShown(page) {
  const button = page.getByRole('button', { name: 'Connect wallet' }).first();
  const pill = page.locator('[data-wallet-pill]').first();
  await Promise.race([button.waitFor({ timeout: 15_000 }), pill.waitFor({ timeout: 15_000 })]).catch(() => {});
  await page.waitForTimeout(500);
  if (await button.isVisible()) {
    await button.click();
    await pickWallet(page).catch(() => {});
  }
}

// With no wallet in the browser, Connect wallet still opens the modal. Reports whether it is open and where its card sits.
async function openWalletModal(page, which = 'first') {
  await page.getByRole('button', { name: 'Connect wallet' })[which]().click();
  await page.locator('w3m-modal wui-card').first().waitFor({ state: 'visible', timeout: 20_000 });
  // The sheet slides in, so measure after it has settled.
  await page.waitForTimeout(700);
  return page.evaluate(() => {
    const modal = document.querySelector('w3m-modal');
    const card = modal?.shadowRoot?.querySelector('wui-card')?.getBoundingClientRect();
    return {
      open: Boolean(modal?.classList.contains('open')),
      card: card ? { left: card.left, right: card.right, top: card.top, bottom: card.bottom } : null,
      width: window.innerWidth,
      height: window.innerHeight,
      scrollWidth: document.documentElement.scrollWidth,
    };
  });
}
const modalFits = (m) => m.open && m.card !== null && m.card.left >= 0 && m.card.right <= m.width && m.card.top >= 0 && m.card.bottom <= m.height && m.scrollWidth <= m.width;

// Once connected, the wallet leaves Arc, as a user switching networks inside the wallet would.
async function moveWalletTo(page, chainHex) {
  await page.locator('[data-wallet-pill]').first().waitFor({ timeout: 60_000 });
  await page.evaluate((c) => window.__e2eMoveTo(c), chainHex);
}

let browser;
async function openPage({ account, width = 1440, theme = 'dark', noWallet = false, addArcFlow = false, signer = null, expectCircleErrors = false }) {
  const context = await browser.newContext({ viewport: { width, height: width < 600 ? 812 : 900 }, colorScheme: theme, hasTouch: width < 600 });
  await context.addCookies([{ name: 'adag-theme', value: theme, url: APP }]);
  await stubReown(context);
  if (!noWallet) await context.addInitScript(walletScript, { account, fork: FORK, addArcFlow });
  if (signer) await context.exposeFunction('__e2eSign', (json) => signTypedJson(signer, json));
  const page = await context.newPage();
  // Every POST this page makes to Circle, so a scenario can count them: none on load, one per press (C73).
  const circle = [];
  page.on('request', (r) => {
    if (new URL(r.url()).host === 'api.circle.com' && r.method() === 'POST') circle.push({ url: r.url(), body: r.postData() });
  });
  page.on('console', (m) => {
    if (m.type() === 'error' && expectCircleErrors && (m.location().url ?? '').startsWith('https://api.circle.com/')) {
      stubbedCircleErrors.push(m.text());
      return;
    }
    if (m.type() === 'error') consoleErrors.push(`${page.url()}: ${m.text()}`);
    if (/content security policy/i.test(m.text())) cspMessages.push(`${page.url()}: ${m.text().slice(0, 200)}`);
  });
  page.on('pageerror', (e) => consoleErrors.push(`${page.url()}: pageerror ${e.message}`));
  return { context, page, circle };
}

async function connect(page, path) {
  await page.goto(APP + path, { waitUntil: 'networkidle', timeout: 120_000 });
  await clickConnect(page);
  await page.locator('#wallet-title').waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('.live-shimmer, [data-reading]'), null, { timeout: 60_000 }).catch(() => {});
}

// Reveals only fire in view, so walk the page before a full-page capture; then shoot 1440 dark and 375 light.
// By default only the screens named with NEWEST_SHOTS are captured, which keeps a run short.
// --all-shots captures every screen the run passes through, the older ones included.
const NEWEST_SHOTS = 'a2';
async function shoot(page, name) {
  const all = process.argv.includes('--all-shots');
  const file = name.startsWith(NEWEST_SHOTS) ? name : !all ? null : /^f\d/.test(name) ? name : `e2e-${name}`;
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
const signRequests = (page) => page.evaluate(() => window.__walletLog.filter((m) => m === 'eth_signTypedData_v4').length);

// Signs an eth_signTypedData_v4 request as a Safe owner with that owner's test key. The JSON carries numbers as
// strings, so the SafeTx integers become bigints before viem hashes them.
async function signTypedJson(account, json) {
  const t = JSON.parse(json);
  const { EIP712Domain: _domain, ...types } = t.types;
  const m = t.message;
  const message = { ...m, value: BigInt(m.value), safeTxGas: BigInt(m.safeTxGas), baseGas: BigInt(m.baseGas), gasPrice: BigInt(m.gasPrice), nonce: BigInt(m.nonce), operation: Number(m.operation) };
  return account.signTypedData({ domain: { ...t.domain, chainId: Number(t.domain.chainId) }, types, primaryType: t.primaryType, message });
}

// A stand-in for Safe's Transaction Service, only the endpoints api-kit calls. It keeps proposals in memory; the
// harness adds the second owner's confirmation and marks execution itself.
const mockSafe = { proposals: new Map(), owners: new Map(), thresholds: new Map() };
function startMockSafeService() {
  const server = createServer((req, res) => {
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(body === undefined ? '' : JSON.stringify(body));
    };
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const url = new URL(req.url, 'http://mock');
      let m;
      if (req.method === 'POST' && (m = /^\/api\/v2\/safes\/(0x[0-9a-fA-F]{40})\/multisig-transactions\/$/.exec(url.pathname))) {
        const b = JSON.parse(raw);
        const safe = m[1].toLowerCase();
        mockSafe.proposals.set(b.contractTransactionHash.toLowerCase(), {
          safe: m[1], to: b.to, value: b.value, data: b.data, operation: b.operation, safeTxGas: b.safeTxGas, baseGas: b.baseGas, gasPrice: b.gasPrice,
          gasToken: b.gasToken, refundReceiver: b.refundReceiver, nonce: Number(b.nonce), safeTxHash: b.contractTransactionHash,
          confirmationsRequired: mockSafe.thresholds.get(safe) ?? 1, confirmations: [{ owner: b.sender, signature: b.signature }],
          isExecuted: false, isSuccessful: null, transactionHash: null, origin: b.origin,
        });
        return reply(201);
      }
      if (req.method === 'GET' && (m = /^\/api\/v2\/multisig-transactions\/(0x[0-9a-fA-F]{64})\/$/.exec(url.pathname))) {
        const tx = mockSafe.proposals.get(m[1].toLowerCase());
        return tx ? reply(200, tx) : reply(404, { detail: 'Not found.' });
      }
      if (req.method === 'GET' && (m = /^\/api\/v1\/owners\/(0x[0-9a-fA-F]{40})\/safes\/$/.exec(url.pathname))) {
        return reply(200, { safes: mockSafe.owners.get(m[1].toLowerCase()) ?? [] });
      }
      return reply(404, { detail: 'Not found.' });
    });
  });
  return new Promise((resolve) => server.listen(MOCK_PORT, '127.0.0.1', () => resolve(server)));
}

// ---- Paying from, and closing, a loan in the other currency (FX-3, C65 to C75) ----------------------------------------
// The browser reaches api.circle.com for real here (the plan is Circle's own); Reown stays stubbed and the RPC is the fork.
// Each scenario saves a 375px light screenshot of the state that matters, and checks that nothing of ours spills past 375.
const CIRCLE_ADAPTER = '0x7FB8c7260b63934d8da38aF902f87ae6e284a845';
const CIRCLE_NO_ROUTE = 'Circle found no swap that returns enough for this payment right now. Try again in a moment, or pay another way.';
const SAFE_CONVERT_SENTENCE = "Converting is not available for Safe payments: Circle's quotes last 10 minutes and a Safe's owners sign later.";

// `hide` names something to leave out of the fit check (the screenshot still shows it). Nothing needs it now: the Safe screen's wide
// button wraps at 375.
async function shot375(page, name, ours = '[data-convert-section], [data-group], [data-close-convert], [data-safe-pay]', hide = null) {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'light'));
  await page.evaluate(async () => {
    for (let y = 0; y < document.body.scrollHeight; y += 300) {
      window.scrollTo(0, y);
      await new Promise((r) => setTimeout(r, 90));
    }
    window.scrollTo(0, 0);
  });
  await page.waitForTimeout(900);
  await page.screenshot({ path: `${SHOTS}/fx3-${name}-375-light.png`, fullPage: true });
  if (hide) await page.addStyleTag({ content: `${hide} { display: none !important; }` });
  const fit = await page.evaluate((sel) => {
    const boxes = [...document.querySelectorAll(sel)].map((e) => e.getBoundingClientRect());
    return { pageWidth: document.documentElement.scrollWidth, width: window.innerWidth, spill: boxes.filter((b) => b.right > window.innerWidth + 0.5 || b.left < -0.5).length, checked: boxes.length };
  }, ours);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'dark'));
  return fit.checked > 0 && fit.spill === 0 && fit.pageWidth <= fit.width;
}

class Slow extends Error {}
// Circle's own answers, in the app's fixed sentences. The market moves under a live quote, so a press can meet "no route"
// or "busy" even after the app has repeated the request twice. Each press gets a fresh plan, so a payer presses again. The
// "too large for one payment" sentence is not in this list: with the 4 million gas ceiling no route Circle has returned is
// refused for gas, so seeing it is a failure.
const CIRCLE_TOO_LARGE = 'This conversion is too large for one payment. Pay part from your balance or split the bill.';
const CIRCLE_RETRYABLE = [CIRCLE_NO_ROUTE, "Circle's swap service is busy. Wait a minute and try again."];
// One press asks Circle once, and repeats the identical request up to twice when Circle says no route or busy (C73).
const requestsPerPress = (requests, presses) => requests >= presses && requests <= 3 * presses;

const fmt6 = (v) => {
  const [whole, fraction = ''] = formatUnits(v, 6).split('.');
  const trimmed = fraction.replace(/0+$/, '');
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${trimmed.padEnd(2, '0')}`;
};

// `only` names the scenarios to run (all of them when left out). The ones that run a real Circle plan go first, while the fork is
// young: Circle quotes today's pools, and a fork's pools stay as they were when it started, so the longer the fork has been up
// the further its swap route and its price drift from Circle's (twice, an hour in, Circle's plan found no route or used more
// gas than the fixed ceiling). The Safe scenario needs the Safe the later scenarios create, so it runs there.
async function fxScenarios({ safe, advanceStore, only }) {
  const run = (id) => !only || only.includes(id);
  const tokenBalance = (token, who) => fork.readContract({ address: token, abi: tokenAbi, functionName: 'balanceOf', args: [who] });
  const adapterAccess = async () => [
    ...(await Promise.all([USDC, EURC, CIRBTC].map((token) => fork.readContract({ address: token, abi: tokenAbi, functionName: 'allowance', args: [PAYER, CIRCLE_ADAPTER] })))),
    await fork.readContract({ address: MORPHO, abi: parseAbi(['function isAuthorized(address, address) view returns (bool)']), functionName: 'isAuthorized', args: [PAYER, CIRCLE_ADAPTER] }),
  ];
  const accessClear = (a) => a[0] === 0n && a[1] === 0n && a[2] === 0n && a[3] === false;
  const eurcPosition = (who) => fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_EURC, who] });
  const eurcLtv = () => fork.readContract({ address: ADAG, abi: parseAbi(['function loanToValue(address user, bytes32 marketId) view returns (uint256)']), functionName: 'loanToValue', args: [PAYER, MARKET_EURC] });
  const acceptMorpho = async (page) => {
    const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
    if (await dialog.waitFor({ timeout: 6_000 }).then(() => true, () => false)) {
      await dialog.getByRole('checkbox').check();
      await dialog.getByRole('button', { name: 'Continue to payment' }).click();
    }
  };
  const openBasketFor = async (page, ids) => {
    await page.goto(`${APP}/pay/basket?bills=${ids.join(',')}`, { waitUntil: 'networkidle', timeout: 120_000 });
    await clickConnect(page);
    await page.locator('[data-group]').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => !document.querySelector('.live-shimmer, [data-reading]'), null, { timeout: 60_000 }).catch(() => {});
  };
  // What the signed batch actually carried, read from the transaction on the fork: the amount approved to the adapter,
  // every borrow, and every pledge. Compared with what the screen showed, this is C70's "shown equals signed".
  const callsOf = async (hash) => {
    const tx = await fork.getTransaction({ hash });
    const batch = decodeFunctionData({ abi: parseAbi(['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) returns ((bool success, bytes returnData)[])']), data: tx.input });
    const morpho = parseAbi([
      'function borrow((address,address,address,address,uint256) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)',
      'function supplyCollateral((address,address,address,address,uint256) marketParams, uint256 assets, address onBehalf, bytes data)',
    ]);
    const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
    const out = { toAdapter: [], borrows: [], pledges: [], target: tx.to, calls: batch.args[0].length };
    for (const c of batch.args[0]) {
      for (const [abi, handle] of [
        [erc20, (d) => { if (d.functionName === 'approve' && getAddress(d.args[0]) === getAddress(CIRCLE_ADAPTER)) out.toAdapter.push(d.args[1]); }],
        [morpho, (d) => { if (d.functionName === 'borrow') out.borrows.push(d.args[1]); if (d.functionName === 'supplyCollateral') out.pledges.push(d.args[1]); }],
      ]) {
        try { handle(decodeFunctionData({ abi, data: c.callData })); } catch {}
      }
    }
    return out;
  };
  // Presses a payment button. When Circle itself says no (its fixed sentence, shown by the page), a payer presses again, so
  // this does too, up to eight presses (measured on 7 October 2026: Circle's keyless swap answered the same request with a plan
  // about half the time and "No route available" otherwise); every press is a new request and the scenario checks that count. Anything else the
  // page says is a failure.
  const pressUntilDone = async (page, buttonSelector, resultSelector, name) => {
    for (let press = 1; ; press++) {
      await page.locator(buttonSelector).click();
      // The last press's sentence fades out as the new press starts; it must be gone before the page is asked what happened.
      if (press > 1) await page.locator('[data-tx-state="failed"], [data-tx-state="refused"]').first().waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
      await acceptMorpho(page);
      try {
        await resultOrReason(page, resultSelector, name);
        return press;
      } catch (error) {
        if (press >= 8 || !CIRCLE_RETRYABLE.some((t) => String(error.message).includes(t))) throw error;
        console.log(`  ${name}: press ${press} met Circle's fixed sentence ("${String(error.message).slice(-120)}"); pressing again`);
        await page.waitForTimeout(8_000);
      }
    }
  };
  const hashFrom = async (locator) => (await locator.first().getAttribute('href')).split('/tx/')[1];
  // Waits for the result card, or for the page to say why there is none, so a payment that stalls reports the page's own
  // words and leaves a screenshot instead of a bare timeout.
  const resultOrReason = async (page, resultSelector, name, timeout = 180_000) => {
    const reasonSelector = '[data-tx-state="failed"], [data-tx-state="refused"]';
    const first = await Promise.race([
      page.locator(resultSelector).first().waitFor({ timeout }).then(() => 'result', () => 'timeout'),
      page.locator(reasonSelector).first().waitFor({ timeout }).then(() => 'reason', () => 'timeout'),
    ]);
    if (first === 'result') return;
    await page.screenshot({ path: `${SHOTS}/fx3-stalled-${name}.png`, fullPage: true }).catch(() => {});
    const said = first === 'reason' ? await page.locator(reasonSelector).first().innerText().catch(() => '') : (await page.locator('[data-tx-state]').first().innerText().catch(() => 'no status line'));
    throw new Slow(`${name}: ${first === 'reason' ? 'the page refused or failed' : 'no result in ' + timeout / 1000 + ' s'}: ${said.replace(/\s+/g, ' ')}; fork block time ${(await fork.getBlock()).timestamp}, this machine ${Math.floor(Date.now() / 1000)}`);
  };

  console.log(`  fx: the demo payer reset on the fork: ${await resetPayer()}`);
  const head = await fork.getBlock();
  console.log(`  fx: fork clock ${head.timestamp} against this machine's ${Math.floor(Date.now() / 1000)} (Circle's plans last 600 s and are checked against the fork's clock)`);
  // The demo payer holds about $10 of cirBTC, enough for a bill of a few dollars. Circle routes small amounts through longer paths that
  // cost far more gas (1.9 to 2.4 million, against about 1.1 million from 5 USDC up, measured on this fork on 7 October 2026), so the bills
  // here are 5 USDC and more, and the payer is given the cirBTC their pledges need. Morpho holds every pledged satoshi, so it is the
  // one holder sure to exist (as with fund-eurc), and the same amount goes back at the end.
  const FX_BTC = 100_000n;
  // resetPayer repays any EURC loan with 5 EURC it funds itself; these scenarios borrow more than that, so the payer gets more first.
  const resetWithEurc = async () => {
    forkScript('fund-eurc', PAYER, '20000000');
    return resetPayer();
  };
  if (run('a') || run('b') || run('g') || run('h')) console.log(`  fx: payer given ${FX_BTC} sat of cirBTC from Morpho: ${forkScript('send', MORPHO, CIRBTC, 'transfer(address,uint256)', PAYER, String(FX_BTC))}`);

  // (fx-a) One USDC bill paid from a EURC loan on the single bill page, with a real Circle plan. Circle's adapter first
  // holds a stray USDC approval, so the page offers to reset it; then the payment, with every figure checked against
  // what was signed.
  if (run('a')) {
    const BILL_A = 5_000_000n;
    const A = newBill('USDC', BILL_A, 'E2E-FX-A');
    forkScript('send', PAYER, USDC, 'approve(address,uint256)', CIRCLE_ADAPTER, '1000000');
    const payeeBefore = await tokenBalance(USDC, PAYEE);
    const { context, page, circle } = await openPage({ account: PAYER, expectCircleErrors: true });
    await connect(page, `/bill/${A}`);
    const blocked = page.locator('[data-convert-off]');
    await blocked.waitFor({ timeout: 60_000 });
    const blockedText = await blocked.innerText();
    const resetShown = await page.locator('[data-action="convert-reset"]').count();
    await shot375(page, 'a-blocked');
    await page.locator('[data-action="convert-reset"]').click();
    const resetEnded = await Promise.race([
      page.locator('[data-convert-reset-done]').waitFor({ timeout: 120_000 }).then(() => 'done', () => 'timeout'),
      page.locator('[data-convert-reset-failed]').waitFor({ timeout: 120_000 }).then(() => 'failed', () => 'timeout'),
    ]);
    if (resetEnded !== 'done') {
      await page.screenshot({ path: `${SHOTS}/fx3-stalled-fx-a-reset.png`, fullPage: true }).catch(() => {});
      const said = (await page.locator('[data-convert-reset-box]').first().innerText().catch(() => 'no reset box')).replace(/\s+/g, ' ');
      throw new Slow(`fx-a reset: ${resetEnded}: "${said}"; wallet requests ${await page.evaluate(() => window.__walletLog.join(' '))}; console errors so far: ${consoleErrors.join(' | ').slice(0, 600)}`);
    }
    const accessAfterReset = await adapterAccess();
    await page.locator('[data-convert-estimate]').waitFor({ timeout: 60_000 });
    await page.locator('[data-action="pay-convert"]:not([disabled])').waitFor({ timeout: 60_000 });
    // A refresh must not ask Circle anything either.
    await page.reload({ waitUntil: 'networkidle', timeout: 120_000 });
    await connectIfShown(page);
    await page.locator('[data-action="pay-convert"]:not([disabled])').waitFor({ timeout: 60_000 });
    const askedBeforePress = circle.length;
    const section = await page.locator('[data-convert-section]').innerText();
    const shownX = await page.locator('[data-convert-x]').first().getAttribute('data-convert-x');
    const shownPledge = await page.locator('[data-convert-pledge]').first().getAttribute('data-convert-pledge');
    const fits = await shot375(page, 'a-estimate');
    const sendsBefore = await sends(page);
    // The page polls bill(id) every 6 seconds and refreshes the server props once it reads Paid. Holding this page's receipt
    // reads back 15 seconds makes that refresh land before the payment has read its receipt, every run: the order that once
    // left the pay options on a paid bill. Without it, which came first was luck.
    await page.route((url) => url.origin === new URL(FORK).origin, async (route) => {
      if ((route.request().postData() ?? '').includes('"eth_getTransactionReceipt"')) await new Promise((r) => setTimeout(r, 15_000));
      await route.continue();
    });
    // Watched in the page from here on: whether the payment's progress card showed while the bill already read Paid (so the
    // refresh did land mid-payment), and whether any pay button was ever on screen next to a Paid stamp.
    await page.evaluate(() => {
      window.__sawProgress = false;
      window.__optionsOnPaid = false;
      const look = () => {
        if (document.querySelector('[data-pay-closed="progress"]')) window.__sawProgress = true;
        if (document.querySelector('[role="img"][aria-label="Status: Paid"]') && document.querySelector('[data-action^="pay-"]')) window.__optionsOnPaid = true;
      };
      new MutationObserver(look).observe(document.body, { childList: true, subtree: true, attributes: true });
    });
    const presses = await pressUntilDone(page, '[data-action="pay-convert"]', '[data-tx-result="paid"]', 'fx-a');
    await page.getByRole('img', { name: 'Status: Paid' }).first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(1500);
    const card = await page.locator('[data-tx-result="paid"]').innerText();
    const hash = await hashFrom(page.locator('[data-tx-result="paid"] a'));
    const watched = await page.evaluate(() => ({ progress: window.__sawProgress, optionsOnPaid: window.__optionsOnPaid }));
    await shot375(page, 'a-paid', '[data-tx-result="paid"]');
    const receipt = await fork.getTransactionReceipt({ hash });
    const signed = await callsOf(hash);
    const sentNow = (await sends(page)) - sendsBefore;
    const bodies = circle.map((r) => JSON.parse(r.body ?? '{}'));
    const body = bodies.at(-1) ?? {};
    const paidLog = await billPaidLog(A);
    const converted = parseEventLogs({ abi: parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)']), logs: receipt.logs })
      .filter((l) => l.address.toLowerCase() === USDC.toLowerCase() && l.args.to.toLowerCase() === PAYER.toLowerCase() && l.args.from.toLowerCase() !== PAYER.toLowerCase())
      .reduce((sum, l) => sum + l.args.value, 0n);
    const payeeRise = (await tokenBalance(USDC, PAYEE)) - payeeBefore;
    const access = await adapterAccess();
    const debt = await eurcPosition(PAYER);
    await context.close();
    record(`(fx-a) USDC bill #${A} paid from a EURC loan on the bill page: real Circle plan, one to three identical requests per press, payee credited exactly, Paid shown, adapter access 0 after`,
      /Circle's swap adapter can already spend your USDC/.test(blockedText) && resetShown === 1 && accessClear(accessAfterReset)
        && askedBeforePress === 0 && requestsPerPress(circle.length, presses) && bodies.every((b) => b.tokenInAddress === EURC && b.tokenOutAddress === USDC && b.amount === shownX && b.stopLimit === String(BILL_A) && b.fromAddress === PAYER && b.toAddress === PAYER)
        && /Your debt will be in EURC\. Its dollar cost moves with the euro\./.test(section) && /Adag checks the 40% limit only now, when you pay\./.test(section)
        && /The loan guard can only repay this loan from EURC in your wallet\./.test(section) && /Circle's fee is 0\.02%/.test(section) && /Worst case, 1 EURC returns at least/.test(section)
        && receipt.status === 'success' && signed.target.toLowerCase() === '0x522fAf9A91c41c443c66765030741e4AaCe147D0'.toLowerCase()
        && signed.toAdapter[0]?.toString() === shownX && signed.toAdapter.at(-1) === 0n && signed.borrows.length === 1 && signed.borrows[0].toString() === shownX
        && signed.pledges.reduce((x, y) => x + y, 0n).toString() === shownPledge
        && payeeRise === BILL_A && (await statusOf(A)) === 2 && paidLog?.args.payer.toLowerCase() === PAYER.toLowerCase()
        && accessClear(access) && debt[1] > 0n && sentNow === 1
        && card.includes(`${fmt6(BigInt(shownX))} EURC became ${fmt6(converted)} USDC`) && card.includes(fmt6(converted - BILL_A)) && fits
        && watched.progress && !watched.optionsOnPaid,
      `stray approval: "${blockedText.slice(0, 90)}..."; reset button ${resetShown}, access after ${accessAfterReset.join('/')}; Circle requests before the press ${askedBeforePress}, after ${circle.length} for ${presses} press(es); asked ${body.amount} EURC for at least ${body.stopLimit} USDC (screen showed ${shownX}); gas used ${receipt.gasUsed}; signed approve ${signed.toAdapter.join('/')}, borrow ${signed.borrows.join('/')}, pledge ${signed.pledges.join('/')} (screen ${shownPledge}); payee +${payeeRise}; swap returned ${converted}; access after ${access.join('/')}; wallet sends for the payment ${sentNow}; fits at 375: ${fits}; the page's refresh to Paid landed before the receipt was read and the progress card showed: ${watched.progress}; a pay button next to a Paid stamp: ${watched.optionsOnPaid}; card: ${card.replace(/\s*\n\s*/g, ' | ').slice(0, 330)}`);
  }

  // (fx-b) The same in a basket: the USDC bill converts, and the other group, a EURC bill, is paid from bitcoin in the same
  // market, so one pledge covers both (C69).
  if (run('b')) {
    await resetWithEurc();
    const U_AMT = 5_000_000n;
    const E_AMT = 2_000_000n;
    const U = newBill('USDC', U_AMT, 'E2E-FX-B-USDC');
    const E = newBill('EURC', E_AMT, 'E2E-FX-B-EURC');
    const usdcBefore = await tokenBalance(USDC, PAYEE);
    const eurcBefore = await tokenBalance(EURC, PAYEE);
    const posBefore = await eurcPosition(PAYER);
    const { context, page, circle } = await openPage({ account: PAYER, expectCircleErrors: true });
    await openBasketFor(page, [U, E]);
    await page.locator('[data-choice="USDC-convert"]:not([disabled])').waitFor({ timeout: 60_000 });
    await page.locator('[data-choice="USDC-convert"]').click();
    await page.locator('[data-choice="USDC-convert"][aria-checked="true"]').waitFor({ timeout: 10_000 });
    await page.locator('[data-choice="EURC-bitcoin"]:not([disabled])').waitFor({ timeout: 30_000 });
    await page.locator('[data-choice="EURC-bitcoin"]').click();
    await page.locator('[data-convert-shared]').waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    const sharedNote = await page.locator('[data-convert-shared]').innerText();
    const bitcoinCard = await page.locator('[data-choice="EURC-bitcoin"]').innerText();
    const shownX = await page.locator('[data-convert-x]').first().getAttribute('data-convert-x');
    const shownPledge = await page.locator('[data-convert-pledge]').first().getAttribute('data-convert-pledge');
    const feeText = await page.locator('[data-fee]').first().innerText();
    const fits = await shot375(page, 'b-estimate');
    const askedBeforePress = circle.length;
    await page.locator('[data-action="pay-basket"]:not([disabled])').waitFor({ timeout: 60_000 });
    const presses = await pressUntilDone(page, '[data-action="pay-basket"]', '[data-tx-result="basket-paid"]', 'fx-b');
    await page.waitForFunction(() => [...document.querySelectorAll('[data-basket-bill]')].every((e) => e.getAttribute('data-landed') === 'paid'), null, { timeout: 15_000 });
    await page.waitForTimeout(900);
    const card = await page.locator('[data-tx-result="basket-paid"]').innerText();
    const hash = await hashFrom(page.locator('[data-tx-result="basket-paid"] a'));
    await shot375(page, 'b-paid', '[data-tx-result="basket-paid"]');
    const receipt = await fork.getTransactionReceipt({ hash });
    const signed = await callsOf(hash);
    const paidLogs = parseEventLogs({ abi: [billPaidEvent], logs: receipt.logs }).filter((l) => l.address.toLowerCase() === ADAG.toLowerCase());
    const bodies = circle.map((r) => JSON.parse(r.body ?? '{}'));
    const body = bodies.at(-1) ?? {};
    const access = await adapterAccess();
    const posAfter = await eurcPosition(PAYER);
    const ltv = await eurcLtv();
    const sent = await sends(page);
    await context.close();
    record(`(fx-b) basket of USDC bill #${U} (converted from a EURC loan) and EURC bill #${E} (from bitcoin, same market): both paid in one signature, one pledge, payees credited exactly, adapter access 0`,
      askedBeforePress === 0 && requestsPerPress(circle.length, presses) && bodies.every((b) => b.amount === shownX && b.stopLimit === String(U_AMT))
        && /same Morpho market/.test(bitcoinCard) && sharedNote.includes(`${fmt6(E_AMT)} EURC`) && /With a conversion the network fee is checked when you press pay/.test(feeText)
        && receipt.status === 'success' && paidLogs.length === 2 && paidLogs.every((l) => l.args.payer.toLowerCase() === PAYER.toLowerCase())
        && signed.toAdapter[0]?.toString() === shownX && signed.pledges.reduce((x, y) => x + y, 0n).toString() === shownPledge
        && signed.borrows.length === 2 && signed.borrows.map(String).includes(shownX) && signed.borrows.map(String).includes(String(E_AMT))
        && (await tokenBalance(USDC, PAYEE)) - usdcBefore === U_AMT && (await tokenBalance(EURC, PAYEE)) - eurcBefore === E_AMT
        && (await statusOf(U)) === 2 && (await statusOf(E)) === 2 && accessClear(access) && posAfter[1] > posBefore[1] && ltv > 0n && ltv <= 400000000000000000n && sent === 1
        && /became/.test(card) && /left in your wallet/i.test(card) && fits,
      `Circle requests before the press ${askedBeforePress}, after ${circle.length} for ${presses} press(es); asked ${body.amount} for at least ${body.stopLimit} (screen ${shownX}); gas used ${receipt.gasUsed}; signed borrows ${signed.borrows.join('/')}, pledge ${signed.pledges.join('/')} (screen ${shownPledge}); BillPaid ${paidLogs.length}; EURC loan-to-value ${(Number(ltv) / 1e16).toFixed(2)}%; access ${access.join('/')}; wallet sends ${sent}; fits at 375: ${fits}; shared note "${sharedNote.slice(0, 120)}"; card: ${card.replace(/\s*\n\s*/g, ' | ').slice(0, 300)}`);
  }

  // (fx-c) Circle answers "no route", stubbed: the app repeats the identical request twice (three in all), then the page shows the
  // fixed sentence, never Circle's words, sends nothing and does not raise anything by itself.
  if (run('c')) {
    const C = newBill('USDC', 1_000_000, 'E2E-FX-C');
    const { context, page, circle } = await openPage({ account: PAYER, expectCircleErrors: true });
    const stubbed = [];
    await context.route('https://api.circle.com/**', (route) => {
      const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': '*' };
      if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
      stubbed.push(route.request().postData());
      return route.fulfill({ status: 400, contentType: 'application/json', headers: cors, body: JSON.stringify({ code: 331001, message: 'secret-circle-words: no route for your wallet' }) });
    });
    await connect(page, `/bill/${C}`);
    await page.locator('[data-action="pay-convert"]:not([disabled])').waitFor({ timeout: 60_000 });
    await page.locator('[data-action="pay-convert"]').click();
    await acceptMorpho(page);
    const failed = page.locator('[data-tx-state="failed"]');
    await failed.waitFor({ timeout: 90_000 });
    const text = await failed.innerText();
    await page.waitForTimeout(3_000);
    const fits = await shot375(page, 'c-circle-error', '[data-convert-section], [data-tx-state]');
    const sent = await sends(page);
    const stillOpen = (await statusOf(C)) === 1;
    const buttonBack = await page.locator('[data-action="pay-convert"]:not([disabled])').count();
    await context.close();
    const identical = stubbed.length > 0 && stubbed.every((body) => body === stubbed[0]) && circle.every((r) => r.body === circle[0]?.body);
    record(`(fx-c) Circle answering "no route" for bill #${C}: the same request three times, then Circle's fixed sentence, none of its words, nothing sent, the button back for a new press`,
      text.includes(CIRCLE_NO_ROUTE) && !text.includes('secret-circle-words') && circle.length === 3 && stubbed.length === 3 && identical && sent === 0 && stillOpen && buttonBack === 1 && fits,
      `shown: "${text}"; Circle POSTs seen by the page ${circle.length}, by the stub ${stubbed.length}, bodies identical ${identical}; wallet sends ${sent}; bill still open ${stillOpen}; pay button usable again ${buttonBack}; fits at 375: ${fits}`);
  }

  // (fx-d) The loan market's free cash is short: the option is shown, off, with its reason, on the bill page and in a basket.
  if (run('d')) {
    const euroMarket = await fork.readContract({ address: MORPHO, abi: parseAbi(['function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)']), functionName: 'market', args: [MARKET_EURC] });
    const free = euroMarket[0] > euroMarket[2] ? euroMarket[0] - euroMarket[2] : 0n;
    const bigAmount = ((free + 1_000_000n) * 13n) / 10n;
    const D = newBill('USDC', bigAmount, 'E2E-FX-D');
    const one = await openPage({ account: PAYER });
    await connect(one.page, `/bill/${D}`);
    const note = one.page.locator('[data-convert-off]');
    await note.waitFor({ timeout: 60_000 });
    const noteText = await note.innerText();
    const buttons = await one.page.locator('[data-action="pay-convert"]').count();
    const fitsOne = await shot375(one.page, 'd-bill-page');
    const sentOne = await sends(one.page);
    await one.context.close();

    const two = await openPage({ account: PAYER });
    await openBasketFor(two.page, [D]);
    const choice = two.page.locator('[data-choice="USDC-convert"]');
    await choice.filter({ hasText: 'ready to lend right now' }).waitFor({ timeout: 60_000 });
    const choiceText = (await choice.innerText()).replace(/\s+/g, ' ');
    const choiceDisabled = await choice.isDisabled();
    const checked = await choice.getAttribute('aria-checked');
    const fitsTwo = await shot375(two.page, 'd-basket');
    const sentTwo = await sends(two.page);
    await two.context.close();
    const freeText = fmt6(free);
    const pattern = new RegExp(`^Morpho has ${freeText.replace(/[.,]/g, '\\$&')} EURC ready to lend right now, less than the [\\d,]+\\.\\d{2,6} EURC this conversion borrows\\. Pay another way, or check back later\\.$`);
    record(`(fx-d) bill #${D} needing more EURC than Morpho's ${freeText} free: the conversion is shown, off, with its reason, on the bill page and in a basket, and nothing is sent`,
      pattern.test(noteText) && buttons === 0 && choiceDisabled && checked !== 'true' && choiceText.includes(`Morpho has ${freeText} EURC ready to lend right now`) && sentOne === 0 && sentTwo === 0 && (await statusOf(D)) === 1 && fitsOne && fitsTwo,
      `fork free cash ${free} (${freeText} EURC); bill ${bigAmount}; page: "${noteText}", pay-convert buttons ${buttons}; basket option disabled ${choiceDisabled}, checked ${checked}; sends ${sentOne + sentTwo}; fits at 375: ${fitsOne}/${fitsTwo}`);
  }

  // (fx-e) Opposite conversions in one basket: once the USDC bills convert, the EURC bills cannot, and the other way round.
  if (run('e')) {
    const U = newBill('USDC', 1_000_000, 'E2E-FX-E-USDC');
    const E = newBill('EURC', 1_000_000, 'E2E-FX-E-EURC');
    const { context, page, circle } = await openPage({ account: PAYER });
    await openBasketFor(page, [U, E]);
    await page.locator('[data-choice="USDC-convert"]:not([disabled])').waitFor({ timeout: 60_000 });
    await page.locator('[data-choice="EURC-convert"]:not([disabled])').waitFor({ timeout: 60_000 });
    await page.locator('[data-choice="USDC-convert"]').click();
    await page.locator('[data-choice="EURC-convert"][disabled]').waitFor({ timeout: 30_000 });
    const euroOff = (await page.locator('[data-choice="EURC-convert"]').innerText()).replace(/\s+/g, ' ');
    const euroChecked = await page.locator('[data-choice="EURC-convert"]').getAttribute('aria-checked');
    const fitsFirst = await shot375(page, 'e-usdc-converts');
    await page.locator('[data-choice="USDC-balance"]:not([disabled])').click();
    await page.locator('[data-choice="EURC-convert"]:not([disabled])').waitFor({ timeout: 30_000 });
    await page.locator('[data-choice="EURC-convert"]').click();
    await page.locator('[data-choice="USDC-convert"][disabled]').waitFor({ timeout: 30_000 });
    const dollarOff = (await page.locator('[data-choice="USDC-convert"]').innerText()).replace(/\s+/g, ' ');
    const dollarChecked = await page.locator('[data-choice="USDC-convert"]').getAttribute('aria-checked');
    const fitsSecond = await shot375(page, 'e-eurc-converts');
    const sent = await sends(page);
    await context.close();
    const reasonFor = (bills) => `The ${bills} bills in this basket are already paid by converting. One signature runs one conversion, and never one in each direction.`;
    record(`(fx-e) basket of USDC bill #${U} and EURC bill #${E}: when one group converts, the other group's conversion is off with its reason, both ways round`,
      euroOff.includes(reasonFor('USDC')) && euroChecked !== 'true' && dollarOff.includes(reasonFor('EURC')) && dollarChecked !== 'true' && circle.length === 0 && sent === 0 && fitsFirst && fitsSecond,
      `with USDC converting, the EURC option says "${euroOff.slice(0, 150)}"; with EURC converting, the USDC option says "${dollarOff.slice(0, 150)}"; Circle requests ${circle.length}; wallet sends ${sent}; fits at 375: ${fitsFirst}/${fitsSecond}`);
  }

  // (fx-f) A Safe payer: the conversion is shown, off, with the Safe line, and nothing can be proposed through Circle.
  if (safe && run('f')) {
    advanceStore();
    const F = newBill('USDC', 1_000_000, 'E2E-FX-F');
    const { context, page, circle } = await openPage({ account: safe.OWNER1.address, signer: safe.OWNER1 });
    await connect(page, `/bill/${F}`).catch(() => {});
    await page.locator('[data-safe-pay]').waitFor({ timeout: 60_000 });
    await page.locator('[data-field="safe-address"]').fill(safe.SAFE);
    await page.locator('[data-action="safe-check"]').click();
    await page.locator('[data-safe-verified]').waitFor({ timeout: 60_000 });
    const line = page.locator('[data-safe-convert="USDC"]');
    await line.waitFor({ timeout: 30_000 });
    const lineText = (await line.innerText()).replace(/\s+/g, ' ');
    const radioOff = await line.locator('input').isDisabled();
    const buttons = await page.locator('[data-action="pay-convert"]').count();
    const enrolButtons = await page.locator('[data-action="safe-enrol"]').count();
    const fits = await shot375(page, 'f-safe', '[data-safe-pay], [data-safe-convert], [data-action="safe-enrol"]');
    const signed = await signRequests(page);
    const sent = await sends(page);
    await context.close();
    record(`(fx-f) a Safe owner paying bill #${F} as the Safe sees the Safe line on the conversion, off, and no way to propose one`,
      lineText.includes('From the Safe\'s bitcoin, borrowing EURC.') && lineText.includes(SAFE_CONVERT_SENTENCE) && radioOff && buttons === 0 && circle.length === 0 && signed === 0 && sent === 0 && fits,
      `shown: "${lineText}"; option disabled ${radioOff}; pay-convert buttons ${buttons}; Circle requests ${circle.length}; signature requests ${signed}, sends ${sent}; fits at 375, with the ${enrolButtons} record-the-loan button(s) wrapping inside it: ${fits}`);
  }

  // (fx-g) Closing a EURC loan with USDC from the wallet page: debt 0, all the bitcoin back, adapter access 0.
  if (run('g')) {
    console.log(`  fx-g: demo payer reset again: ${await resetWithEurc()}`);
    const pledge = 3_000n;
    const euroPrice = await fork.readContract({ address: '0x6945246777DfdF4744D957323857F797Ec19Ca1e', abi: parseAbi(['function price() view returns (uint256)']), functionName: 'price' });
    const borrow = (((pledge * euroPrice) / 10n ** 36n) * 35n) / 100n;
    const setup = [
      forkScript('send', PAYER, CIRBTC, 'approve(address,uint256)', MORPHO, String(pledge)),
      forkScript('send', PAYER, MORPHO, `supplyCollateral(${MP},uint256,address,bytes)`, EURC_PARAMS, String(pledge), PAYER, '0x'),
      forkScript('send', PAYER, MORPHO, `borrow(${MP},uint256,uint256,address,address)`, EURC_PARAMS, String(borrow), '0', PAYER, PAYER),
    ];
    // The borrowed EURC goes straight to the supplier, so the payer cannot close the loan with EURC and has to convert.
    const held = await tokenBalance(EURC, PAYER);
    const moved = forkScript('send', PAYER, EURC, 'transfer(address,uint256)', PAYEE, String(held));
    const btcBefore = await cirBtcOf(PAYER);
    const { context, page, circle } = await openPage({ account: PAYER, expectCircleErrors: true });
    await connect(page, '/app').catch(() => {});
    const ticket = page.locator('[data-loan="EURC"]');
    await ticket.waitFor({ timeout: 60_000 });
    await ticket.getByRole('tab', { name: 'Close loan' }).click();
    await ticket.locator('[data-action="close-other"]:not([disabled])').waitFor({ timeout: 90_000 });
    const estimate = await ticket.locator('[data-close-estimate]').innerText();
    const shownY = await ticket.locator('[data-close-x]').first().getAttribute('data-close-x');
    const buttonLabel = await ticket.locator('[data-action="close-other"]').innerText();
    const closeShort = await ticket.locator('[data-close-short]').count();
    const fits = await shot375(page, 'g-close-estimate', '[data-loan], [data-close-convert]');
    const askedBeforePress = circle.length;
    const presses = await pressUntilDone(page, '[data-loan="EURC"] [data-action="close-other"]', '[data-tx-result="closed"]', 'fx-g');
    const text = await ticket.locator('[data-tx-result="closed"]').innerText();
    const hash = await hashFrom(ticket.locator('[data-tx-result="closed"] a'));
    await shot375(page, 'g-closed', '[data-loan]');
    const receipt = await fork.getTransactionReceipt({ hash });
    const end = await eurcPosition(PAYER);
    const back = (await cirBtcOf(PAYER)) - btcBefore;
    const bodies = circle.map((r) => JSON.parse(r.body ?? '{}'));
    const body = bodies.at(-1) ?? {};
    const access = await adapterAccess();
    const morphoAllowance = await fork.readContract({ address: EURC, abi: tokenAbi, functionName: 'allowance', args: [PAYER, MORPHO] });
    const sent = await sends(page);
    await context.close();
    record('(fx-g) a EURC loan closed with USDC from the wallet page: debt 0, all the bitcoin back, no approval left to Morpho or Circle, one Circle request',
      setup.every((x) => x.includes('"status":"0x1"')) && moved.includes('"status":"0x1"') && buttonLabel === 'Close with USDC' && /Circle's fee is 0\.02%/.test(estimate)
        && askedBeforePress === 0 && requestsPerPress(circle.length, presses) && bodies.every((b) => b.tokenInAddress === USDC && b.tokenOutAddress === EURC && b.amount === shownY && BigInt(b.stopLimit) > 0n)
        && receipt.status === 'success' && end[1] === 0n && end[2] === 0n && back === pledge && morphoAllowance === 0n && accessClear(access) && sent === 1
        && text.includes('Loan closed. 0 owed, 0 pledged.') && /Circle turned/.test(text) && fits,
      `set-up ${setup.join(' ')}; EURC moved off the wallet ${moved}; button "${buttonLabel}"; close-short notices ${closeShort}; Circle requests before the press ${askedBeforePress}, after ${circle.length} for ${presses} press(es); asked ${body.amount} USDC for at least ${body.stopLimit} EURC (screen ${shownY}); gas used ${receipt.gasUsed}; after: ${end[1]} shares, ${end[2]} pledged; cirBTC back ${back} of ${pledge}; Morpho EURC allowance ${morphoAllowance}; adapter access ${access.join('/')}; fits at 375: ${fits}; shown: ${text.replace(/\s*\n\s*/g, ' | ').slice(0, 330)}`);
  }

  // (fx-h) A 1 USDC bill paid from a EURC loan. Circle routes a bill this small through a longer path that measured 1.9 to 2.4 million
  // gas, which the old ceiling of 2.5 million (25% headroom, so 2 million simulated) refused as "too large for one payment". The sentence
  // must not appear now. The scenario passes when the bill is paid, or when every press that failed met Circle's own no-route or busy
  // sentence after the app's repeats (Circle's keyless API is flaky); the detail line says which, and how many presses and requests it took.
  if (run('h')) {
    await resetWithEurc();
    const BILL_H = 1_000_000n;
    const H = newBill('USDC', BILL_H, 'E2E-FX-H');
    const payeeBefore = await tokenBalance(USDC, PAYEE);
    const { context, page, circle } = await openPage({ account: PAYER, expectCircleErrors: true });
    await connect(page, `/bill/${H}`);
    await page.locator('[data-action="pay-convert"]:not([disabled])').waitFor({ timeout: 60_000 });
    const sendsBefore = await sends(page);
    let presses = 0;
    let stopped = '';
    try {
      presses = await pressUntilDone(page, '[data-action="pay-convert"]', '[data-tx-result="paid"]', 'fx-h');
    } catch (error) {
      stopped = String(error.message);
    }
    const tooLarge = stopped.includes(CIRCLE_TOO_LARGE) || (await page.getByText(CIRCLE_TOO_LARGE).count()) > 0;
    const paid = presses > 0;
    let gasUsed = 0n;
    if (paid) {
      const hash = await hashFrom(page.locator('[data-tx-result="paid"] a'));
      gasUsed = (await fork.getTransactionReceipt({ hash })).gasUsed;
    }
    const payeeRise = (await tokenBalance(USDC, PAYEE)) - payeeBefore;
    const sentNow = (await sends(page)) - sendsBefore;
    const status = await statusOf(H);
    const bodies = circle.map((r) => r.body);
    await context.close();
    // Unpaid is allowed only when Circle itself said no on every press: the bill is still open and nothing was sent.
    const circleSaidNo = !paid && CIRCLE_RETRYABLE.some((t) => stopped.includes(t));
    record(`(fx-h) a 1 USDC bill #${H} paid from a EURC loan is not refused as too large`,
      !tooLarge && ((paid && payeeRise === BILL_H && status === 2 && sentNow === 1 && gasUsed > 0n && gasUsed * 125n / 100n <= 4_000_000n) || (circleSaidNo && payeeRise === 0n && status === 1 && sentNow === 0)) && bodies.length > 0,
      paid
        ? `paid after ${presses} press(es) and ${circle.length} Circle request(s), so ${presses - 1} press(es) met Circle's no-route or busy sentence first; gas used ${gasUsed} (the sender allows ${4_000_000n} with 25% headroom); the "too large" sentence never showed`
        : `NOT paid: Circle answered no route or busy on every press (${circle.length} requests over up to 8 presses); the "too large" sentence did not show (${tooLarge ? 'IT SHOWED' : 'it never showed'}); stopped with: "${stopped.slice(-160)}"`);
  }

  // Whatever ran above, leave the payer as the other scenarios expect to find it: no loan, no pledge, no stray EURC, 10 USDC.
  if (only && !safe) {
    await resetWithEurc();
    const left = await tokenBalance(EURC, PAYER);
    if (left > 0n) forkScript('send', PAYER, EURC, 'transfer(address,uint256)', PAYEE, String(left));
    forkScript('send', PAYER, CIRBTC, 'transfer(address,uint256)', MORPHO, String(FX_BTC));
    // Every connected pay page asks the Safe routes for a list, and they allow 20 calls per client per ten minutes; this block loaded
    // enough pages to use some of that, so the stand-in store's clock moves past the window before the other scenarios begin.
    advanceStore();
  }
}

async function main() {
  console.log('e2e: starting the Arc fork in WSL');
  // WSL's name lookup fails now and then at the moment the fork first asks Arc's RPC for its head block, so a failed start is tried again.
  for (let attempt = 1; ; attempt++) {
    try {
      console.log(`  ${forkScript('start')}`);
      break;
    } catch (error) {
      if (attempt >= 4) throw error;
      console.log(`  the fork did not start (attempt ${attempt}): ${String(error.message).split('\n')[0].slice(0, 120)}; trying again`);
      await new Promise((r) => setTimeout(r, 5_000));
    }
  }
  const chain = await rpc('eth_chainId');
  if (chain !== '0x13b2') throw new Error(`the fork reports chain ${chain}, not 5042`);
  console.log(`  demo payer reset on the fork: ${await resetPayer()}; 10 USDC`);

  const A = newBill('USDC', 400_000, 'E2E-A');
  const B = newBill('USDC', 300_000, 'E2E-B');
  const C = newBill('EURC', 200_000, 'E2E-C');
  console.log(`  payee wrote bills #${A} (0.40 USDC), #${B} (0.30 USDC), #${C} (0.20 EURC) on the fork`);
  console.log('  the EURC bill is only voided, so the payer needs no EURC');

  const store = await startMockUpstash({ token: keccak256(stringToHex(`adag e2e store ${Date.now()}`)).slice(2, 34) });
  appEnv.UPSTASH_REDIS_REST_URL = store.url;
  appEnv.UPSTASH_REDIS_REST_TOKEN = store.token;

  console.log('e2e: building the app against the fork (.next-e2e) and serving it on :3400');
  buildApp();
  const mockService = await startMockSafeService();
  const app = await startApp();
  browser = await chromium.launch();

  try {
    if (FX_ONLY) {
      await fxScenarios({ safe: null, advanceStore: () => store.advance(601_000) });
      return;
    }
    // The scenarios that run a real Circle plan go first, while the fork is young (see fxScenarios).
    await fxScenarios({ safe: null, advanceStore: () => store.advance(601_000), only: ['a', 'b', 'c', 'd', 'e', 'g', 'h'] });
    // (a) Pay bill A from balance.
    {
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${A}`);
      await shoot(page, 'a-open');
      await shoot(page, 'p1-pay-panel');
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
      const { context, page } = await openPage({ account: PAYER });
      await page.goto(`${APP}/bill/${E}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await clickConnect(page);
      await moveWalletTo(page, '0x1');
      await page.getByRole('button', { name: 'Switch to Arc' }).first().waitFor({ timeout: 60_000 });
      await page.locator('[data-blocked="true"]').waitFor({ timeout: 30_000 });
      const buttons = await page.locator('[data-action^="pay-"]').count();
      await shoot(page, 'e-wrong-chain');
      await shoot(page, 'p1-wrong-network');
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
      // The disclaimer can open a beat after the click, so give it a moment before deciding it is not there.
      if (await page.getByRole('dialog').waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
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
      await shoot(page, 'p1-write-share');
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
      await shoot(page, 'p1-loan-ticket');
      await ticket.locator('[data-field="add-collateral"]').fill('0.00001');
      await ticket.locator('[data-action="add-collateral"]').click();
      const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
      if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      }
      await ticket.locator('[data-tx-result="added"]').waitFor({ timeout: 120_000 }).catch(async (e) => {
        // A one-off stall here once had nothing to show for it; this keeps what the ticket said.
        await page.screenshot({ path: `${SHOTS}/h-stalled.png`, fullPage: true });
        console.log(`  (h) stalled, the ticket reads: ${(await ticket.innerText()).replace(/\s+/g, ' ').slice(0, 1500)}`);
        throw e;
      });
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
      const rowsOf = (list) => page.locator(`[data-list="${list}"] [data-bill-row]`).evaluateAll((els) => els.map((e) => ({
        id: e.getAttribute('data-bill-row'), contract: e.getAttribute('data-contract'), status: e.getAttribute('data-status'),
        href: e.querySelector('a')?.getAttribute('href'), marked: !!e.querySelector('[data-first-deployment]'),
      })));
      const rows = await rowsOf('wrote');
      await shoot(page, 'f7-j-payee-lists');
      await shoot(page, 'p1-lists-copy');
      await context.close();
      // Both contracts are listed, each row naming its own; within a contract, newest first. The test's bills are
      // on the current contract, the payee's 25 September bill on the first deployment.
      const wroteOk = want.every(([id, status]) => rows.some((r) => r.id === String(id) && r.contract === 'current' && r.status === status));
      const byContract = (list, c) => list.filter((r) => r.contract === c).map((r) => Number(r.id));
      const descending = (ids) => ids.every((v, i, arr) => i === 0 || arr[i - 1] > v);
      const newestFirst = descending(byContract(rows, 'current')) && descending(byContract(rows, 'first'));
      const linksOk = (list) => list.every((r) => r.href === (r.contract === 'first' ? `/bill/first/${r.id}` : `/bill/${r.id}`) && r.marked === (r.contract === 'first'));
      const firstWrote = rows.filter((r) => r.contract === 'first');

      const p2 = await openPage({ account: PAYER });
      await connect(p2.page, '/app').catch(() => {});
      await p2.page.locator('[data-list="paid"] [data-bill-row]').first().waitFor({ timeout: 150_000 });
      const paid = await p2.page.locator('[data-list="paid"] [data-bill-row]').evaluateAll((els) => els.map((e) => ({
        id: e.getAttribute('data-bill-row'), contract: e.getAttribute('data-contract'),
        href: e.querySelector('a')?.getAttribute('href'), marked: !!e.querySelector('[data-first-deployment]'),
      })));
      await shoot(p2.page, 'f7-j-payer-lists');
      await shoot(p2.page, 'a2-j-lists');
      await p2.context.close();
      const paidHas = (id) => paid.some((r) => r.id === String(id) && r.contract === 'current');
      record("(j) /app lists both contracts' bills: the right stamps, newest first per contract, each row linked to its own contract and old ones marked",
        wroteOk && newestFirst && firstWrote.length > 0 && linksOk(rows) && linksOk(paid) && paidHas(A) && paidHas(B) && paid.some((r) => r.contract === 'first'),
        `wrote: ${rows.map((r) => `#${r.id}${r.contract === 'first' ? ' (first)' : ''} ${r.status}`).join(', ')}; paid: ${paid.map((r) => `#${r.id}${r.contract === 'first' ? ' (first)' : ''}`).join(', ')}; links and marks ${linksOk(rows) && linksOk(paid) ? 'right' : 'WRONG'}`);
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

    // Baskets: several bills, one signature.
    const ltvOnFork = (m) => fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'loanToValue', args: [PAYER, m] });
    const receiptOf = async (page) => {
      const href = await page.locator('[data-tx-result="basket-paid"] a').first().getAttribute('href');
      const receipt = await fork.getTransactionReceipt({ hash: href.split('/tx/')[1] });
      const paidLogs = parseEventLogs({ abi: [billPaidEvent], logs: receipt.logs }).filter((l) => l.address.toLowerCase() === ADAG.toLowerCase());
      return { receipt, paidLogs };
    };
    const openBasket = async (page, ids) => {
      await page.goto(`${APP}/pay/basket?bills=${ids.join(',')}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await clickConnect(page);
      await page.locator('[data-group]').first().waitFor({ timeout: 60_000 });
      await page.waitForFunction(() => !document.querySelector('.live-shimmer, [data-reading]'), null, { timeout: 60_000 }).catch(() => {});
    };
    const payBasket = async (page) => {
      await page.locator('[data-action="pay-basket"]:not([disabled])').waitFor({ timeout: 60_000 });
      await page.locator('[data-action="pay-basket"]').click();
      await acceptDisclaimer(page);
      await page.locator('[data-tx-result="basket-paid"]').waitFor({ timeout: 120_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('[data-basket-bill]')].every((e) => e.getAttribute('data-landed') === 'paid'), null, { timeout: 10_000 });
    };

    // (o) Three bills, one in euros, all from bitcoin, typed on /pay.
    {
      const ids = [newBill('USDC', 300_000, 'E2E-O-1'), newBill('USDC', 200_000, 'E2E-O-2'), newBill('EURC', 150_000, 'E2E-O-3')];
      const { context, page } = await openPage({ account: PAYER });
      await page.goto(`${APP}/pay`, { waitUntil: 'networkidle', timeout: 120_000 });
      await page.getByLabel('Bill numbers or links').fill(`${ids[0]}, ${ids[1]} ${ids[2]}`);
      await page.getByRole('button', { name: 'Open the bill' }).click();
      await page.waitForURL(`**/pay/basket?bills=${ids.join(',')}`, { timeout: 60_000 });
      await clickConnect(page);
      await page.locator('[data-group="EURC"]').waitFor({ timeout: 60_000 });
      await page.waitForFunction(() => !document.querySelector('.live-shimmer, [data-reading]'), null, { timeout: 60_000 }).catch(() => {});
      const bitcoinChosen = (await page.locator('[data-choice$="-bitcoin"][aria-checked="true"]').count()) === 2;
      await shoot(page, 'f9-o-basket');
      await payBasket(page);
      await page.waitForTimeout(700);
      await shoot(page, 'f9-o-landed');
      const { paidLogs } = await receiptOf(page);
      const statuses = await Promise.all(ids.map(statusOf));
      const [ltvU, ltvE] = await Promise.all([ltvOnFork(MARKET_USDC), ltvOnFork(MARKET_EURC)]);
      const sold = await page.locator('[data-sold]').innerText();
      const sent = await sends(page);
      record(`(o) bills #${ids.join(', #')} (2 USDC, 1 EURC) paid from bitcoin in one signature: 3 BillPaid, all PAID, both loans at or under 40%`,
        bitcoinChosen && sent === 1 && paidLogs.length === 3 && paidLogs[0].args.loanChecked === true && statuses.every((s) => s === 2)
          && ltvU > 0n && ltvU <= 400000000000000000n && ltvE > 0n && ltvE <= 400000000000000000n && sold.startsWith('0 cirBTC'),
        `wallet sends ${sent}; BillPaid ${paidLogs.map((l) => `#${l.args.id} checked ${l.args.loanChecked}`).join(', ')}; LTV USDC ${(Number(ltvU) / 1e16).toFixed(2)}%, EURC ${(Number(ltvE) / 1e16).toFixed(2)}%; Bitcoin sold ${sold}`);
      await context.close();
    }

    // (p) A mixed basket: the USDC bills from balance, the EURC bill from bitcoin.
    {
      const ids = [newBill('USDC', 300_000, 'E2E-P-1'), newBill('USDC', 200_000, 'E2E-P-2'), newBill('EURC', 150_000, 'E2E-P-3')];
      const usdcLoanBefore = await positionOf(PAYER);
      const { context, page } = await openPage({ account: PAYER });
      await openBasket(page, ids);
      await page.locator('[data-choice="USDC-balance"]:not([disabled])').click();
      await page.waitForTimeout(400);
      await shoot(page, 'f9-p-mixed');
      await payBasket(page);
      await page.waitForTimeout(700);
      await shoot(page, 'f9-p-paid');
      const { paidLogs } = await receiptOf(page);
      const usdcLoanAfter = await positionOf(PAYER);
      const ltvE = await ltvOnFork(MARKET_EURC);
      const statuses = await Promise.all(ids.map(statusOf));
      record(`(p) mixed basket #${ids.join(', #')}: USDC from balance (USDC loan unchanged), EURC from bitcoin`,
        paidLogs.length === 3 && statuses.every((s) => s === 2) && usdcLoanAfter[1] === usdcLoanBefore[1] && usdcLoanAfter[2] === usdcLoanBefore[2] && ltvE <= 400000000000000000n,
        `BillPaid ${paidLogs.length}; USDC loan shares ${usdcLoanBefore[1]} -> ${usdcLoanAfter[1]}; EURC LTV ${(Number(ltvE) / 1e16).toFixed(2)}%`);
      await context.close();
    }

    // (q) A paid bill, a void bill and an open one: only the open one is paid.
    {
      const Q = newBill('USDC', 100_000, 'E2E-Q');
      const { context, page } = await openPage({ account: PAYER });
      await openBasket(page, [A, C, Q]);
      const reasons = await page.locator('[data-aside-bill]').evaluateAll((els) => els.map((e) => [e.getAttribute('data-aside-bill'), e.querySelector('[data-reason]')?.textContent ?? '']));
      const inBasket = await page.locator('[data-basket-bill]').evaluateAll((els) => els.map((e) => e.getAttribute('data-basket-bill')));
      await page.waitForFunction(() => /about [0-9.]+ USDC/.test(document.querySelector('[data-fee]')?.textContent ?? ''), null, { timeout: 60_000 }).catch(() => {});
      const fee = await page.locator('[data-fee]').innerText();
      const label = await page.getByText(/Basket · 3 bills · 1 payable/).count();
      await shoot(page, 'f9b-q-aside');
      await payBasket(page);
      await page.waitForTimeout(700);
      await shoot(page, 'f9-q-paid');
      const { paidLogs } = await receiptOf(page);
      const reasonOf = (id) => reasons.find(([r]) => r === String(id))?.[1] ?? '';
      record(`(q) basket of paid #${A}, void #${C} and open #${Q}: the first two set apart with reasons, only #${Q} paid`,
        label === 1 && /about [\d.]+ USDC/.test(fee) && reasonOf(A).includes('Already paid') && reasonOf(C).includes('Cancelled') && inBasket.length === 1 && inBasket[0] === String(Q)
          && paidLogs.length === 1 && paidLogs[0].args.id === Q && (await statusOf(Q)) === 2 && (await statusOf(C)) === 3,
        `label "1 payable" ${label === 1}; ${fee.replace(/\s+/g, ' ')}; set apart: ${reasons.map(([r, t]) => `#${r} "${t}"`).join(', ')}; paid ${paidLogs.map((l) => `#${l.args.id}`).join(', ')}`);
      await context.close();
    }

    // (r) Duplicates collapse to one; eleven numbers are refused before any wallet request.
    {
      const { context, page } = await openPage({ account: PAYER });
      await page.goto(`${APP}/pay`, { waitUntil: 'networkidle', timeout: 120_000 });
      await page.getByLabel('Bill numbers or links').fill(`${A}, ${A} #${A}, ${B}`);
      await page.getByRole('button', { name: 'Open the bill' }).click();
      await page.waitForURL('**/pay/basket?bills=*', { timeout: 60_000 });
      const collapsed = new URL(page.url()).searchParams.get('bills');
      await page.goto(`${APP}/pay`, { waitUntil: 'networkidle', timeout: 120_000 });
      await page.getByLabel('Bill numbers or links').fill(Array.from({ length: 11 }, (_, i) => i + 1).join(' '));
      await page.getByRole('button', { name: 'Open the bill' }).click();
      await page.getByText('One signature pays at most 10').waitFor({ timeout: 10_000 });
      const stayed = new URL(page.url()).pathname === '/pay';
      await shoot(page, 'f9-r-refused');
      await page.goto(`${APP}/pay/basket?bills=${Array.from({ length: 11 }, (_, i) => i + 1).join(',')}`, { waitUntil: 'networkidle', timeout: 120_000 });
      const direct = await page.getByText('Too many').first().isVisible();
      // L3: a link stuffed with words shows at most three short samples and a count, and an all-closed basket offers next steps.
      const junk = 'URGENT:%20Adag%20support%20says%20send%20your%20seed%20phrase%20to%20this%20address%20now';
      await page.goto(`${APP}/pay/basket?bills=${A},${C},${junk},aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`, { waitUntil: 'networkidle', timeout: 120_000 });
      const droppedText = await page.locator('[data-dropped]').innerText();
      const nextSteps = await page.locator('[data-next-steps] a').allInnerTexts();
      await shoot(page, 'p1-basket-empty');
      const sent = await sends(page);
      const samples = droppedText.replace(/^[^:]*:\s*/, '').replace(/ and \d+ more\.?$/, '').replace(/\.$/, '').split(', ');
      const l3 = samples.length <= 3 && samples.every((t) => t.replace(/…$/, '').length <= 24) && /and \d+ more/.test(droppedText) && !droppedText.includes('seed phrase');
      record('(r) duplicates collapse, 11 numbers are refused, a word-stuffed link shows only 3 short samples, and an all-closed basket offers next steps',
        collapsed === `${A},${B}` && stayed && direct && sent === 0 && l3 && nextSteps.includes('Pay a bill') && nextSteps.includes('Write a bill'),
        `"${A}, ${A} #${A}, ${B}" opened bills=${collapsed}; 11 numbers stayed on /pay: ${stayed}; basket link refused: ${direct}; dropped shown: "${droppedText}"; next steps: ${nextSteps.join(', ')}; sends ${sent}`);
      await context.close();
    }

    // (s) A wallet that cannot cover gas is stopped before the wallet is asked. Arc's gas is the native USDC balance.
    {
      const S = newBill('USDC', 100_000, 'E2E-S');
      const original = await fork.getBalance({ address: PAYER });
      await rpc('anvil_setBalance', [PAYER, `0x${(10n ** 15n).toString(16)}`]);
      try {
        const { context, page } = await openPage({ account: PAYER });
        await connect(page, `/bill/${S}`);
        await page.locator('[data-action="pay-bitcoin"]:not([disabled])').waitFor({ timeout: 60_000 });
        await page.locator('[data-action="pay-bitcoin"]').click();
        await acceptDisclaimer(page);
        const failed = page.locator('[data-tx-state="failed"]');
        await failed.waitFor({ timeout: 60_000 });
        const text = await failed.innerText();
        await shoot(page, 'f9b-s-no-gas');
        const sent = await sends(page);
        record(`(s) with 0.001 USDC for gas, paying bill #${S} from bitcoin stops with the fee sentence and no wallet request`,
          /Your wallet needs about [\d.]+ USDC for the network fee and holds 0\.0010\. Nothing was sent\./.test(text) && sent === 0 && (await statusOf(S)) === 1,
          `shown: "${text}"; eth_sendTransaction requests ${sent}`);
        await context.close();
      } finally {
        await rpc('anvil_setBalance', [PAYER, `0x${original.toString(16)}`]);
      }
    }

    // (t) A payer's funding choice is never swapped. "Balance" that stops being covered is cleared, with the reason.
    {
      const ids = [newBill('USDC', 300_000, 'E2E-T-1'), newBill('USDC', 200_000, 'E2E-T-2')];
      const original = await fork.getBalance({ address: PAYER });
      const { context, page } = await openPage({ account: PAYER });
      try {
        await openBasket(page, ids);
        await page.locator('[data-choice="USDC-balance"]:not([disabled])').click();
        await page.locator('[data-choice="USDC-balance"][aria-checked="true"]').waitFor({ timeout: 10_000 });
        // 0.05 USDC: under the 0.50 group total. The basket re-reads every 30 seconds.
        await rpc('anvil_setBalance', [PAYER, `0x${(5n * 10n ** 16n).toString(16)}`]);
        const notice = page.locator('[data-cleared="USDC"]');
        await notice.waitFor({ timeout: 60_000 });
        const reason = await notice.innerText();
        const checked = await page.locator('[data-choice^="USDC-"][aria-checked="true"]').count();
        const payDisabled = await page.locator('[data-action="pay-basket"]').isDisabled();
        await shoot(page, 'f10-t-cleared');
        record('(t) a "balance" choice that stops being covered is cleared with the reason, not switched to bitcoin, and Pay is disabled',
          reason.includes('no longer covers') && checked === 0 && payDisabled,
          `shown: "${reason}"; choices checked ${checked}; Pay disabled ${payDisabled}`);
      } finally {
        await rpc('anvil_setBalance', [PAYER, `0x${original.toString(16)}`]);
        await context.close();
      }
    }

    // (u) A wallet holding exactly a USDC bill's amount, nothing for the fee, is not offered pay from balance.
    {
      const U = newBill('USDC', 100_000, 'E2E-U');
      const original = await fork.getBalance({ address: PAYER });
      await rpc('anvil_setBalance', [PAYER, `0x${(10n ** 17n).toString(16)}`]);
      try {
        const { context, page } = await openPage({ account: PAYER });
        await connect(page, `/bill/${U}`);
        await page.getByText('a little USDC for the network fee').waitFor({ timeout: 60_000 });
        const offered = await page.locator('[data-action="pay-balance"]').count();
        await shoot(page, 'f10-u-no-fee-room');
        // The same bill in a basket: the balance option is there but cannot be chosen. The wallet is already connected here.
        await page.goto(`${APP}/pay/basket?bills=${U}`, { waitUntil: 'networkidle', timeout: 120_000 });
        await page.locator('[data-group="USDC"]').waitFor({ timeout: 60_000 });
        await page.waitForFunction(() => !document.querySelector('.live-shimmer, [data-reading]'), null, { timeout: 60_000 }).catch(() => {});
        const basketBalance = await page.locator('[data-choice="USDC-balance"]').isDisabled();
        const sent = await sends(page);
        record(`(u) holding exactly 0.10 USDC for 0.10 USDC bill #${U}: pay from balance is not offered, on the bill page or in a basket, and nothing is sent`,
          offered === 0 && basketBalance && sent === 0 && (await statusOf(U)) === 1,
          `bill page pay-from-balance buttons ${offered}; basket balance option disabled ${basketBalance}; sends ${sent}; a forced attempt is not reachable from the UI`);
        await context.close();
      } finally {
        await rpc('anvil_setBalance', [PAYER, `0x${original.toString(16)}`]);
      }
    }

    // (v) Getting set up: the helper for a wallet with no cirBTC, the Reown wallet modal opening on a phone and on a
    // desktop with no wallet in the browser, and Switch to Arc adding Arc to a wallet that has never seen it.
    {
      const V = newBill('USDC', 100_000, 'E2E-V');
      const FRESH = '0x00000000000000000000000000000000000a11ce';
      await rpc('anvil_setBalance', [FRESH, `0x${(5n * 10n ** 18n).toString(16)}`]);
      const one = await openPage({ account: FRESH });
      await connect(one.page, `/bill/${V}`);
      const need = one.page.locator('[data-setup-need="cirbtc"]');
      await need.waitFor({ timeout: 60_000 });
      const cirbtcLinks = await need.locator('a').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      const blockedReason = await one.page.locator('[data-blocked-reason]').first().innerText().catch(() => '');
      await shoot(one.page, 'p1-v-setup');
      await one.context.close();

      const two = await openPage({ account: PAYER, noWallet: true, width: 375, theme: 'light' });
      await two.page.goto(`${APP}/bill/${V}`, { waitUntil: 'networkidle', timeout: 120_000 });
      const phoneModal = await openWalletModal(two.page);
      await two.page.screenshot({ path: `${SHOTS}/p1-v-no-wallet-375-light.png`, fullPage: false });
      await two.context.close();

      const desk = await openPage({ account: PAYER, noWallet: true });
      await desk.page.goto(`${APP}/bill/${V}`, { waitUntil: 'networkidle', timeout: 120_000 });
      const deskModal = await openWalletModal(desk.page);
      await desk.page.screenshot({ path: `${SHOTS}/p1-v-no-wallet-1440-dark.png`, fullPage: false });
      await desk.context.close();

      const three = await openPage({ account: PAYER, addArcFlow: true });
      await three.page.goto(`${APP}/bill/${V}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await clickConnect(three.page);
      await moveWalletTo(three.page, '0x1');
      await three.page.locator('[data-blocked="true"]').waitFor({ timeout: 60_000 });
      await three.page.getByRole('button', { name: 'Switch to Arc' }).first().click();
      await three.page.locator('[data-action="pay-bitcoin"], [data-action="pay-balance"]').first().waitFor({ timeout: 60_000 });
      const added = await three.page.evaluate(() => window.__addChainParams);
      const log = await three.page.evaluate(() => window.__walletLog);
      await three.context.close();

      record('(v) setup: the cirBTC helper for a wallet with none, the Reown wallet modal on a phone and on a desktop with no wallet, and Switch to Arc adds Arc',
        cirbtcLinks.includes('https://portal.arc.io/swap') && blockedReason.includes('less cirBTC') && modalFits(phoneModal) && deskModal.open && deskModal.card !== null
          && added.length === 1 && added[0].chainId === '0x13b2' && log.indexOf('wallet_addEthereumChain') > log.indexOf('wallet_switchEthereumChain'),
        `cirBTC links ${cirbtcLinks.join(' ')}; button says "${blockedReason}"; phone modal open ${phoneModal.open}, card ${JSON.stringify(phoneModal.card)}; desktop modal open ${deskModal.open}; add-chain ${JSON.stringify(added[0] ?? null).slice(0, 160)}`);
    }

    // (w) Live status: the supplier's open bill page stamps PAID on its own when the payer pays elsewhere.
    {
      const W = newBill('USDC', 100_000, 'E2E-W');
      const payee = await openPage({ account: PAYEE });
      await connect(payee.page, `/bill/${W}`);
      await payee.page.getByRole('img', { name: 'Status: Open' }).first().waitFor({ timeout: 30_000 });
      const payer = await openPage({ account: PAYER });
      await connect(payer.page, `/bill/${W}`);
      await payer.page.locator('[data-action="pay-balance"]').click();
      await payer.page.locator('[data-tx-result="paid"]').waitFor({ timeout: 120_000 });
      const paidAt = Date.now();
      await payee.page.getByRole('img', { name: 'Status: Paid' }).first().waitFor({ timeout: 10_000 });
      const seconds = ((Date.now() - paidAt) / 1000).toFixed(1);
      await payee.page.locator('[data-paid-just-now]').waitFor({ timeout: 10_000 });
      const justNow = await payee.page.locator('[data-paid-just-now]').innerText();
      await payee.page.waitForTimeout(700);
      await shoot(payee.page, 'p1-w-paid-live');
      await payer.context.close();
      await payee.context.close();
      record(`(w) the supplier's open page for bill #${W} turns PAID on its own within 10 seconds of the payment, with "Paid just now"`,
        // innerText follows the CSS, which uppercases the label.
        /paid just now/i.test(justNow) && (await statusOf(W)) === 2, `stamp turned in ${seconds} s with no reload; card: ${justNow.replace(/\s*\n\s*/g, ' | ')}`);
    }

    // (x) Repay some, then (y) Max and Close loan, on the payer's USDC loan from /app.
    {
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, '/app').catch(() => {});
      const ticket = page.locator('[data-loan="USDC"]');
      await ticket.waitFor({ timeout: 60_000 });
      await page.waitForFunction(() => document.querySelector('[data-loan="USDC"]')?.getAttribute('data-ltv') !== '', null, { timeout: 60_000 });
      const ltvBefore = Number(await ticket.getAttribute('data-ltv'));
      const before = await positionOf(PAYER);
      await ticket.getByRole('tab', { name: 'Repay some' }).click();
      await ticket.locator('[data-field="repay-some"]').fill('0.10');
      await page.waitForTimeout(1200);
      await shoot(page, 'p4-x-repay');
      await ticket.locator('[data-action="repay-some"]').click();
      const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
      if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      }
      const result = ticket.locator('[data-tx-result="repaid"]');
      await result.waitFor({ timeout: 120_000 });
      const firstText = await result.innerText();
      await page.waitForFunction((b) => Number(document.querySelector('[data-loan="USDC"]')?.getAttribute('data-ltv')) < b, ltvBefore, { timeout: 60_000 }).catch(() => {});
      const ltvAfter = Number(await ticket.getAttribute('data-ltv'));
      const after = await positionOf(PAYER);
      const allowanceAfter = await fork.readContract({ address: USDC, abi: tokenAbi, functionName: 'allowance', args: [PAYER, MORPHO] });
      await shoot(page, 'p4-x-repaid');
      record('(x) Repay some 0.10 USDC from /app: the loan-to-value falls, the fork shows fewer shares and the same pledge, no approval left',
        ltvAfter < ltvBefore && after[1] < before[1] && after[2] === before[2] && allowanceAfter === 0n && firstText.startsWith('Repaid 0.10 USDC'),
        `gauge ${ltvBefore}% -> ${ltvAfter}%; shares ${before[1]} -> ${after[1]}; pledge ${after[2]} sat unchanged; allowance ${allowanceAfter}; shown: "${firstText.split('\n')[0]}"`);

      // (y) Max repays the whole rounded-down debt without a revert; the dust left behind is what Close loan clears.
      await page.waitForTimeout(1500);
      await ticket.locator('[data-action="repay-max"]').click();
      const maxValue = await ticket.locator('[data-field="repay-some"]').inputValue();
      await ticket.locator('[data-action="repay-some"]').click();
      await page.waitForFunction((t) => {
        const el = document.querySelector('[data-loan="USDC"] [data-tx-result="repaid"]');
        return el && el.textContent && !el.textContent.startsWith(t.slice(0, 20));
      }, firstText, { timeout: 120_000 });
      const maxText = await result.innerText();
      const dust = await positionOf(PAYER);
      await ticket.getByRole('tab', { name: /Close loan|Take your bitcoin back/ }).click();
      await ticket.locator('[data-action="close-loan"]').waitFor({ timeout: 30_000 });
      await page.waitForFunction(() => !document.querySelector('[data-loan="USDC"] [data-action="close-loan"][disabled]'), null, { timeout: 60_000 }).catch(() => {});
      await ticket.locator('[data-action="close-loan"]').click();
      await ticket.locator('[data-tx-result="closed"]').waitFor({ timeout: 120_000 });
      const end = await positionOf(PAYER);
      await shoot(page, 'p4-y-closed');
      record('(y) Max repays the rounded-down debt without reverting, leaves dust, and Close loan then clears the position',
        maxText.startsWith(`Repaid ${maxValue}`) && dust[1] < after[1] / 1000n && end[1] === 0n && end[2] === 0n,
        `Max filled ${maxValue} USDC; shown "${maxText.split('\n')[0]}"; shares after Max ${dust[1]} (dust); after Close ${end[1]} shares, ${end[2]} pledged`);
      await context.close();
    }

    // (z) Export for your accountant: both CSV files, one row per bill, formulas neutralised.
    {
      const parseCsv = (text) => {
        const rows = [];
        let row = [];
        let cell = '';
        let quoted = false;
        for (let i = 0; i < text.length; i++) {
          const ch = text[i];
          if (quoted) {
            if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
            else if (ch === '"') quoted = false;
            else cell += ch;
          } else if (ch === '"') quoted = true;
          else if (ch === ',') { row.push(cell); cell = ''; }
          else if (ch === '\r' && text[i + 1] === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; i++; }
          else cell += ch;
        }
        return rows;
      };
      const readDownload = async (page, action) => {
        const [dl] = await Promise.all([page.waitForEvent('download', { timeout: 120_000 }), page.locator(`[data-action="${action}"]`).click()]);
        const { readFileSync } = await import('node:fs');
        return { name: dl.suggestedFilename(), rows: parseCsv(readFileSync(await dl.path(), 'utf8')) };
      };
      const header = ['contract address', 'bill number', 'status', 'written at', 'paid at', 'supplier', 'payer', 'amount', 'currency', 'reference', 'transaction link', '40% check ran'];
      const Z = newBill('USDC', 50_000, `hex:${stringToHex('=HYPERLINK("x")')}`);

      const one = await openPage({ account: PAYEE });
      await connect(one.page, '/app').catch(() => {});
      await one.page.locator('[data-action="export-written"]:not([disabled])').waitFor({ timeout: 60_000 });
      const written = await readDownload(one.page, 'export-written');
      await shoot(one.page, 'p4-z-export');
      await one.context.close();
      const totalOf = async (fn, who) => {
        const each = await Promise.all([ADAG, ADAG_FIRST].map((address) => fork.readContract({ address, abi: adagAbi, functionName: fn, args: [who, 0n, 1n] })));
        return each.reduce((s, [, total]) => s + total, 0n);
      };
      const wroteTotal = await totalOf('billsOfPayee', PAYEE);
      const zRow = written.rows.find((r) => r[1] === String(Z) && r[0].toLowerCase() === ADAG.toLowerCase());
      // The contract column is per row: each row names the deployment its bill lives on.
      const contractsOk = (rows) => rows.slice(1).every((r) => [ADAG, ADAG_FIRST].some((a) => a.toLowerCase() === r[0].toLowerCase()));
      const firstRows = written.rows.slice(1).filter((r) => r[0].toLowerCase() === ADAG_FIRST.toLowerCase()).length;

      const two = await openPage({ account: PAYER });
      await connect(two.page, '/app').catch(() => {});
      await two.page.locator('[data-action="export-paid"]:not([disabled])').waitFor({ timeout: 60_000 });
      const paid = await readDownload(two.page, 'export-paid');
      await two.context.close();
      const paidTotal = await totalOf('paymentsOfPayer', PAYER);
      const linked = paid.rows.slice(1).filter((r) => r[10].startsWith('https://explorer.arc.io/tx/0x') && (r[11] === 'yes' || r[11] === 'no'));

      record('(z) both CSV exports: the header, one row per bill, the formula reference neutralised, and transaction links for paid bills',
        JSON.stringify(written.rows[0]) === JSON.stringify(header) && JSON.stringify(paid.rows[0]) === JSON.stringify(header)
          && written.rows.length - 1 === Number(wroteTotal) && paid.rows.length - 1 === Number(paidTotal)
          && zRow?.[9] === "'=HYPERLINK(\"x\")" && zRow?.[2] === 'open' && linked.length === paid.rows.length - 1
          && contractsOk(written.rows) && contractsOk(paid.rows) && firstRows > 0
          && /^adag-bills-written-0x.{4}\.\.\..{4}-\d{4}-\d{2}-\d{2}\.csv$/.test(written.name),
        `${written.name}: ${written.rows.length - 1} rows for ${wroteTotal} bills written on both contracts, ${firstRows} on the first deployment; bill #${Z} reference cell ${JSON.stringify(zRow?.[9])}; ${paid.name}: ${paid.rows.length - 1} rows for ${paidTotal} paid, ${linked.length} with a transaction link`);
    }

    store.advance(601_000);
    // (aa) to (cc): paying from a Safe. A 2-of-2 Safe v1.4.1 is created on the fork through Arc's SafeProxyFactory,
    // owned by two fresh test keys. Proposals go to the harness's stand-in Transaction Service, never Safe's real one.
    const safeE2EAbi = parseAbi([
      'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
      'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
      'function nonce() view returns (uint256)',
      'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures) payable returns (bool)',
    ]);
    const SAFE_FACTORY = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
    const SAFE_L2 = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
    const SAFE_HANDLER = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';
    const ZERO = '0x0000000000000000000000000000000000000000';
    const OWNER1 = privateKeyToAccount(keccak256(stringToHex('adag e2e safe owner one')));
    const OWNER2 = privateKeyToAccount(keccak256(stringToHex('adag e2e safe owner two')));
    const sendFork = async (to, data) => {
      const hash = await rpc('eth_sendTransaction', [{ from: PAYER, to, data, gas: '0x2dc6c0' }]);
      return fork.waitForTransactionReceipt({ hash });
    };
    const setup = encodeFunctionData({ abi: safeE2EAbi, functionName: 'setup', args: [[OWNER1.address, OWNER2.address], 2n, ZERO, '0x', SAFE_HANDLER, ZERO, 0n, ZERO] });
    const create = encodeFunctionData({ abi: safeE2EAbi, functionName: 'createProxyWithNonce', args: [SAFE_L2, setup, 5042n] });
    const SAFE = getAddress(`0x${(await rpc('eth_call', [{ from: PAYER, to: SAFE_FACTORY, data: create }, 'latest'])).slice(26)}`);
    const created = await sendFork(SAFE_FACTORY, create);
    await rpc('anvil_setBalance', [SAFE, `0x${(5n * 10n ** 18n).toString(16)}`]);
    const funded = forkScript('send', PAYER, CIRBTC, 'transfer(address,uint256)', SAFE, '3000');
    mockSafe.owners.set(OWNER1.address.toLowerCase(), [SAFE]);
    mockSafe.owners.set(OWNER2.address.toLowerCase(), [SAFE]);
    mockSafe.thresholds.set(SAFE.toLowerCase(), 2);
    console.log(`  Safe ${SAFE} on the fork (2 of 2: ${OWNER1.address}, ${OWNER2.address}); created ${created.status}; cirBTC funding ${funded}`);
    const safeNonce = () => fork.readContract({ address: SAFE, abi: safeE2EAbi, functionName: 'nonce' });
    // The second owner confirms, then anyone executes with both signatures, sorted by owner address.
    const typedOf = (proposal) => ({
        domain: { chainId: 5042, verifyingContract: SAFE },
        types: { SafeTx: [
          { name: 'to', type: 'address' }, { name: 'value', type: 'uint256' }, { name: 'data', type: 'bytes' }, { name: 'operation', type: 'uint8' },
          { name: 'safeTxGas', type: 'uint256' }, { name: 'baseGas', type: 'uint256' }, { name: 'gasPrice', type: 'uint256' }, { name: 'gasToken', type: 'address' },
          { name: 'refundReceiver', type: 'address' }, { name: 'nonce', type: 'uint256' },
        ] },
        primaryType: 'SafeTx',
        message: {
          to: proposal.to, value: BigInt(proposal.value), data: proposal.data, operation: Number(proposal.operation), safeTxGas: BigInt(proposal.safeTxGas),
          baseGas: BigInt(proposal.baseGas), gasPrice: BigInt(proposal.gasPrice), gasToken: proposal.gasToken, refundReceiver: proposal.refundReceiver, nonce: BigInt(proposal.nonce),
        },
    });
    const confirmAndExecute = async (proposal) => {
      const typed = typedOf(proposal);
      const second = await OWNER2.signTypedData(typed);
      proposal.confirmations.push({ owner: OWNER2.address, signature: second });
      const signatures = `0x${[...proposal.confirmations].sort((x, y) => (x.owner.toLowerCase() < y.owner.toLowerCase() ? -1 : 1)).map((c) => c.signature.slice(2)).join('')}`;
      const m = typed.message;
      const exec = encodeFunctionData({ abi: safeE2EAbi, functionName: 'execTransaction', args: [m.to, m.value, m.data, m.operation, m.safeTxGas, m.baseGas, m.gasPrice, m.gasToken, m.refundReceiver, signatures] });
      const receipt = await sendFork(SAFE, exec);
      proposal.isExecuted = receipt.status === 'success';
      proposal.isSuccessful = receipt.status === 'success';
      proposal.transactionHash = receipt.transactionHash;
      return receipt;
    };
    // The harness runs a plain call from the Safe itself, signed by both owners, outside Adag.
    const execSafe = async (to, data) => {
      const p = { to, value: '0', data, operation: 0, safeTxGas: '0', baseGas: '0', gasPrice: '0', gasToken: ZERO, refundReceiver: ZERO, nonce: String(await safeNonce()), confirmations: [] };
      p.confirmations.push({ owner: OWNER1.address, signature: await OWNER1.signTypedData(typedOf(p)) });
      return confirmAndExecute(p);
    };
    const lastProposal = () => [...mockSafe.proposals.values()].at(-1);
    const proposeFromUi = async (page, choice) => {
      // Nothing may sit on top of the entry: the bill page once let the price line cover it.
      const covered = await page.evaluate(() => {
        const b = document.querySelector('[data-action="safe-open"]');
        b.scrollIntoView({ block: 'center' });
        const r = b.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return hit && b.contains(hit) ? null : String(hit?.textContent).slice(0, 60);
      });
      if (covered) throw new Error(`"Pay from a Safe" is covered by: ${covered}`);
      await page.locator('[data-action="safe-open"]').first().click();
      await page.locator('[data-field="safe-address"]').fill(SAFE);
      await page.locator('[data-action="safe-check"]').click();
      await page.locator('[data-safe-verified]').waitFor({ timeout: 60_000 });
      await page.waitForFunction(() => document.querySelectorAll('[data-safe-choice]:not([disabled])').length > 0, null, { timeout: 60_000 });
      if (choice) await page.locator(`[data-safe-choice="USDC-${choice}"]`).check();
    };

    // (aa) A basket from the Safe's bitcoin: one owner proposes in the UI, the other confirms, the harness executes.
    {
      const bills2 = [newBill('USDC', 100_000, 'E2E-AA-1'), newBill('USDC', 100_000, 'E2E-AA-2')];
      const { context, page } = await openPage({ account: OWNER1.address, signer: OWNER1 });
      await page.goto(`${APP}/pay/basket?bills=${bills2.join(',')}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await clickConnect(page);
      await page.locator('[data-action="safe-open"]').waitFor({ timeout: 60_000 });
      await page.locator('[data-action="safe-open"]').click();
      const listedButton = page.getByRole('button', { name: `${SAFE.slice(0, 6)}…${SAFE.slice(-4)}` });
      await listedButton.waitFor({ timeout: 30_000 }).catch(() => {});
      const listed = await listedButton.count();
      await page.locator('[data-action="safe-open"]').click();
      await proposeFromUi(page, null);
      await page.locator('[data-safe-choice="USDC-bitcoin"]:checked').waitFor({ timeout: 30_000 });
      await shoot(page, 'a1-aa-safe');
      await page.locator('[data-action="safe-propose"]').click();
      const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
      if (await dialog.isVisible({ timeout: 5_000 }).catch(() => false)) {
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      }
      await page.locator('[data-safe-status]').waitFor({ timeout: 120_000 });
      await page.getByText('1 of 2 signatures').waitFor({ timeout: 30_000 });
      await shoot(page, 'a1-aa-proposed');
      const proposal = lastProposal();
      const nonceBefore = await safeNonce();
      const receipt = await confirmAndExecute(proposal);
      if (receipt.status !== 'success') {
        const trace = await rpc('debug_traceTransaction', [receipt.transactionHash, { tracer: 'callTracer' }]).catch((e) => ({ error: e.message }));
        console.log(`  (aa) execution ${receipt.status}: ${JSON.stringify(trace).slice(0, 1500)}`);
      }
      await page.locator('[data-safe-paid]').waitFor({ timeout: 45_000 }).catch(async (e) => {
        console.log(`  (aa) still waiting: ${await page.locator('[data-safe-status]').innerText().catch(() => 'no status panel')}`);
        throw e;
      });
      await page.waitForTimeout(800);
      await shoot(page, 'a1-aa-paid');
      const records = await Promise.all(bills2.map((id) => fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [id] })));
      const safeLoan = await fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_USDC, SAFE] });
      const allowUsdc = await fork.readContract({ address: USDC, abi: tokenAbi, functionName: 'allowance', args: [SAFE, ADAG] });
      const allowBtc = await fork.readContract({ address: CIRBTC, abi: tokenAbi, functionName: 'allowance', args: [SAFE, MORPHO] });
      const signed = await signRequests(page);
      const sent = await sends(page);
      // F12: the same basket, reloaded in this browser, leads with the Safe's success and lists the bills as paid.
      await page.reload({ waitUntil: 'networkidle', timeout: 120_000 });
      await page.locator('[data-paid-by-safe]').waitFor({ timeout: 60_000 }).catch(() => {});
      const heading = await page.locator('h1').first().innerText();
      const asideCount = await page.locator('[data-aside]').count();
      const paidCards = await page.locator('[data-basket-cards="paid-by-safe"] [data-basket-bill]').count();
      await shoot(page, 'a2e-ss-paid-by-safe');
      await context.close();
      record(`(ss) reloaded after the Safe executed, the basket of bills #${bills2.join(', #')} leads with "Paid by your Safe" and lists both as paid, none under "Not in this payment"`,
        /Paid by your\s*Safe/.test(heading) && asideCount === 0 && paidCards === bills2.length,
        `heading "${heading.replace(/\s+/g, ' ')}"; paid cards ${paidCards}; aside lists ${asideCount}`);
      record(`(aa) a Safe pays bills #${bills2.join(', #')} from its bitcoin: proposed in the UI, confirmed and executed, the Safe the payer with the loan, no allowance left`,
        listed === 1 && proposal?.origin === 'Adag' && receipt.status === 'success' && (await safeNonce()) === nonceBefore + 1n
          && records.every((r) => r.status === 2 && r.payer.toLowerCase() === SAFE.toLowerCase()) && safeLoan[1] > 0n && allowUsdc === 0n && allowBtc === 0n && signed === 1 && sent === 0,
        `picker listed the Safe: ${listed === 1}; proposal nonce ${proposal?.nonce}, origin ${proposal?.origin}; execution ${receipt.status}; bills paid by ${records.map((r) => r.payer).join(', ')}; Safe's borrow shares ${safeLoan[1]}; allowances ${allowUsdc} and ${allowBtc}; wallet signature requests ${signed}, sends ${sent}`);
    }

    // (bb) A bill someone else pays between proposal and execution: the whole execution reverts and the nonce survives.
    {
      const BB = newBill('USDC', 100_000, 'E2E-BB');
      const { context, page } = await openPage({ account: OWNER1.address, signer: OWNER1 });
      await connect(page, `/bill/${BB}`).catch(() => {});
      await proposeFromUi(page, 'balance');
      await page.locator('[data-action="safe-propose"]').click();
      await page.locator('[data-safe-status]').waitFor({ timeout: 120_000 });
      const proposal = lastProposal();
      const paidBySomeoneElse = [
        forkScript('send', PAYER, USDC, 'approve(address,uint256)', ADAG, '100000'),
        forkScript('send', PAYER, ADAG, 'pay(uint256)', String(BB)),
      ];
      const nonceBefore = await safeNonce();
      const receipt = await confirmAndExecute(proposal);
      const nonceAfter = await safeNonce();
      const record_ = await fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [BB] });
      // Paid by someone else is not paid by the Safe (C53): the card keeps waiting.
      await page.waitForTimeout(7_000);
      const safePaidShown = await page.locator('[data-safe-paid]').count();
      await shoot(page, 'a1-bb-reverted');
      await context.close();
      record(`(bb) bill #${BB} paid by someone else after the Safe's proposal: the Safe's execution reverts as a whole and its nonce is not used`,
        paidBySomeoneElse.every((x) => x.includes('"status":"0x1"')) && receipt.status === 'reverted' && nonceAfter === nonceBefore && record_.payer.toLowerCase() === PAYER.toLowerCase() && safePaidShown === 0,
        `the other payment: ${paidBySomeoneElse.join(' ')}; Safe execution ${receipt.status}; Safe nonce ${nonceBefore} -> ${nonceAfter}; bill payer ${record_.payer}; Safe card shows paid: ${safePaidShown > 0}`);
    }

    // (cc) A Safe the connected wallet does not own is refused before any signature is asked for.
    {
      const CC = newBill('USDC', 100_000, 'E2E-CC');
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${CC}`).catch(() => {});
      await page.locator('[data-action="safe-open"]').first().click();
      await page.locator('[data-field="safe-address"]').fill(SAFE);
      await page.locator('[data-action="safe-check"]').click();
      const problem = page.locator('[data-safe-problem]');
      await problem.waitFor({ timeout: 60_000 });
      const text = await problem.innerText();
      const proposeShown = await page.locator('[data-action="safe-propose"]').count();
      await shoot(page, 'a1-cc-refused');
      const signed = await signRequests(page);
      await context.close();
      record('(cc) a Safe the connected wallet does not own is refused before any signature, with no way to propose',
        text.includes('not an owner') && proposeShown === 0 && signed === 0, `shown: "${text}"; propose button ${proposeShown}; signature requests ${signed}`);
    }

    // The Safe routes allow 20 calls per client per ten minutes, and every connected pay page asks for the Safe list.
    // One harness talks for many users, so the stand-in store's clock moves on past the window between groups.
    store.advance(601_000);

    // (oo) F3: an owner whose Safe is listed by Safe's service lands on "Pay as: a Safe", with none of the personal
    // wallet's errors or its "Need cirBTC" box on screen.
    {
      const OO = newBill('USDC', 100_000, 'E2E-OO');
      const { context, page } = await openPage({ account: OWNER1.address, signer: OWNER1 });
      await connect(page, `/bill/${OO}`).catch(() => {});
      await page.locator('[data-pay-as-switch="safe"]').waitFor({ timeout: 60_000 });
      await page.locator('[data-safe-pay]').waitFor({ timeout: 30_000 });
      const personal = await page.locator('[data-action="pay-balance"], [data-action="pay-bitcoin"], [data-setup], [data-blocked-reason]').count();
      await shoot(page, 'a2e-oo-pay-as-safe');
      await page.locator('[data-pay-as="wallet"]').click();
      await page.locator('[data-action="pay-bitcoin"]').waitFor({ timeout: 30_000 });
      const walletBack = await page.locator('[data-safe-pay]').count();
      await context.close();
      record(`(oo) bill #${OO} opens on "Pay as: a Safe" for a listed Safe owner, hides the personal wallet's panel, and switches back on request`,
        personal === 0 && walletBack === 0, `personal-wallet elements shown in Safe mode ${personal}; Safe panel after switching back ${walletBack}`);
    }

    store.advance(601_000);

    // (pp) F5 and (qq) F4: a proposal comes back after a reload; at the threshold the card says to execute; a bill
    // paid by someone else meanwhile is named before anyone executes.
    {
      const PQ = newBill('USDC', 100_000, 'E2E-PQ');
      const { context, page } = await openPage({ account: OWNER1.address, signer: OWNER1 });
      await connect(page, `/bill/${PQ}`).catch(() => {});
      await proposeFromUi(page, 'balance');
      await page.locator('[data-action="safe-propose"]').click();
      await page.locator('[data-safe-status]').waitFor({ timeout: 120_000 });
      const proposal = lastProposal();
      await page.reload({ waitUntil: 'networkidle', timeout: 120_000 });
      await connectIfShown(page);
      const restored = page.locator('[data-safe-status]');
      await restored.waitFor({ timeout: 60_000 });
      const restoredText = await restored.innerText();
      const proposeAgain = await page.locator('[data-action="safe-propose"]').count();
      await shoot(page, 'a2e-pp-remembered');
      record(`(pp) after a reload, bill #${PQ} shows the proposal this browser made instead of offering to propose again`,
        /from this browser/i.test(restoredText) && proposeAgain === 0 && mockSafe.proposals.size > 0,
        `card: "${restoredText.split('\n').slice(0, 2).join(' | ')}"; propose buttons ${proposeAgain}`);

      proposal.confirmations.push({ owner: OWNER2.address, signature: await OWNER2.signTypedData(typedOf(proposal)) });
      const readyNote = page.locator('[data-safe-ready]');
      await readyNote.waitFor({ timeout: 30_000 });
      const readyText = await readyNote.innerText();
      const stillWaiting = await page.getByText('Waiting for your other owners').count();
      const other = [
        forkScript('send', PAYER, USDC, 'approve(address,uint256)', ADAG, '100000'),
        forkScript('send', PAYER, ADAG, 'pay(uint256)', String(PQ)),
      ];
      const warn = page.locator('[data-safe-paid-by-other]');
      await warn.waitFor({ timeout: 30_000 });
      const warnText = await warn.innerText();
      await shoot(page, 'a2e-qq-ready-and-paid-by-other');
      await context.close();
      record(`(qq) at 2 of 2 the card says to press Execute, and bill #${PQ} paid by someone else is named with what executing would cost`,
        readyText === "All signatures are in. One owner presses Execute in Safe's app (it costs a small fee)." && stillWaiting === 0
          && other.every((s) => s.includes('"status":"0x1"')) && warnText.startsWith(`Bill #${PQ} was paid by someone else.`) && /reject it in Safe's app/.test(warnText),
        `ready: "${readyText}"; "waiting" lines ${stillWaiting}; warning: "${warnText}"`);
    }

    store.advance(601_000);
    // (nn) C58 for a Safe (C55): the Safe's own rule triggers below where its bitcoin payment would land, so the
    // sentence shows before anything is proposed. The rule and approval are set by the Safe itself, outside Adag.
    {
      const erc20 = parseAbi(['function approve(address spender, uint256 amount) returns (bool)']);
      const guardWrite = parseAbi(['function setRule(bytes32 marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry)', 'function clearRule(bytes32 marketId)']);
      const approved = await execSafe(USDC, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [GUARD, 1_000_000n] }));
      const ruled = await execSafe(GUARD, encodeFunctionData({ abi: guardWrite, functionName: 'setRule', args: [MARKET_USDC, 3n * 10n ** 17n, 2n * 10n ** 17n, 0n] }));
      const NN = newBill('USDC', 100_000, 'E2E-NN');
      const { context, page } = await openPage({ account: OWNER1.address, signer: OWNER1 });
      await connect(page, `/bill/${NN}`).catch(() => {});
      await proposeFromUi(page, 'bitcoin');
      const note = page.locator('[data-safe-pay] [data-guard-trigger]');
      await note.waitFor({ timeout: 60_000 });
      const text = await note.innerText();
      const before = mockSafe.proposals.size;
      await shoot(page, 'a2d-nn-safe-trigger');
      const signed = await signRequests(page);
      await context.close();
      const cleared = await execSafe(GUARD, encodeFunctionData({ abi: guardWrite, functionName: 'clearRule', args: [MARKET_USDC] }));
      const unapproved = await execSafe(USDC, encodeFunctionData({ abi: erc20, functionName: 'approve', args: [GUARD, 0n] }));
      record(`(nn) the Safe's own 30% guard rule is shown against its bitcoin payment of bill #${NN} before anything is proposed`,
        [approved, ruled, cleared, unapproved].every((r) => r.status === 'success') && /at or past your guard's 30\.00% trigger/.test(text) && /from the Safe within minutes/.test(text)
          && mockSafe.proposals.size === before && signed === 0,
        `shown: "${text}"; proposals ${mockSafe.proposals.size - before}, signature requests ${signed}`);
    }

    // (dd) Two contracts, one number. A bill written on the first deployment opens at /bill/first/N and pays there,
    // while /bill/N shows the current contract's bill of the same number, untouched (C33).
    {
      const F = newBill('USDC', 100_000, 'E2E-DD-FIRST', 'first');
      const currentBefore = await fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [F] });
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/first/${F}`).catch(() => {});
      const sheetContract = await page.locator('[data-bill-contract]').getAttribute('data-bill-contract');
      const sheetText = await page.locator('#bill-title').evaluate((el) => el.closest('section')?.innerText ?? '');
      await page.locator('[data-safe-unavailable]').waitFor({ timeout: 30_000 }).catch(() => {});
      const safeSentence = await page.locator('[data-safe-unavailable]').count();
      const safeButton = await page.locator('[data-action="safe-open"]').count();
      await shoot(page, 'a2-dd-first-open');
      await page.locator('[data-action="pay-balance"]').click();
      await page.locator('[data-tx-result="paid"]').waitFor({ timeout: 120_000 });
      await page.getByRole('img', { name: 'Status: Paid' }).first().waitFor({ timeout: 60_000 });
      await page.waitForTimeout(1500);
      await shoot(page, 'a2-dd-first-paid');
      const firstAfter = await fork.readContract({ address: ADAG_FIRST, abi: adagAbi, functionName: 'bill', args: [F] });
      const currentAfter = await fork.readContract({ address: ADAG, abi: adagAbi, functionName: 'bill', args: [F] });
      const firstLogs = await fork.getLogs({ address: ADAG_FIRST, event: billPaidEvent, args: { id: F }, fromBlock: (await fork.getBlockNumber()) - 20n });
      const currentLogs = await fork.getLogs({ address: ADAG, event: billPaidEvent, args: { id: F }, fromBlock: (await fork.getBlockNumber()) - 20n });

      await page.goto(`${APP}/bill/${F}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await page.locator('[data-bill-contract]').waitFor({ timeout: 60_000 });
      const otherContract = await page.locator('[data-bill-contract]').getAttribute('data-bill-contract');
      const otherText = await page.locator('#bill-title').evaluate((el) => el.closest('section')?.innerText ?? '');
      await shoot(page, 'a2-dd-current-same-number');
      await context.close();
      const unchanged = currentAfter.status === currentBefore.status && currentAfter.payer === currentBefore.payer && currentAfter.ref === currentBefore.ref;
      record(`(dd) bill #${F} on the first deployment opens at /bill/first/${F} and pays there; /bill/${F} still shows the current contract's own bill #${F}`,
        sheetContract === 'first' && sheetText.includes('E2E-DD-FIRST') && /First deployment/i.test(sheetText) && safeSentence === 1 && safeButton === 0
          && firstAfter.status === 2 && firstAfter.payer.toLowerCase() === PAYER.toLowerCase() && firstLogs.length === 1 && currentLogs.length === 0
          && unchanged && otherContract === 'current' && !otherText.includes('E2E-DD-FIRST') && currentBefore.status !== 0,
        `first page: contract ${sheetContract}, reference shown ${sheetText.includes('E2E-DD-FIRST')}, Safe sentence ${safeSentence}, Safe button ${safeButton}; after paying: first deployment status ${firstAfter.status} payer ${firstAfter.payer}, BillPaid on first ${firstLogs.length}, on current ${currentLogs.length}; current bill #${F} status ${currentBefore.status} -> ${currentAfter.status}, page contract ${otherContract}, shows the first bill's reference ${otherText.includes('E2E-DD-FIRST')}`);
    }

    // (ee) to (jj): the pay screens and the existing loan (enrol), the loan guard (C45, C58, C60), the Safe's own
    // enrol proposal (C55), and the phone sheet.
    const oracleAbi = parseAbi(['function price() view returns (uint256)']);
    const marketAbi = parseAbi(['function market(bytes32 id) view returns (uint128 totalSupplyAssets, uint128 totalSupplyShares, uint128 totalBorrowAssets, uint128 totalBorrowShares, uint128 lastUpdate, uint128 fee)']);
    const quoteAbi = parseAbi([
      'function quote(address borrower, bytes32 marketId) view returns (bool wouldAct, uint256 amount, uint256 ltvWad)',
      'event RuleCleared(address indexed borrower, bytes32 indexed marketId)',
    ]);
    const enrolledEvent = parseAbiItem('event Enrolled(address indexed payer, uint256 usdcShares, uint256 usdcCollateral, uint256 eurcShares, uint256 eurcCollateral)');
    const ltvAbi = parseAbi(['function loanToValue(address user, bytes32 marketId) view returns (uint256)']);
    const USDC_ORACLE = '0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab';
    const IRM = '0xF02615d094Fc02fC031C35fe705e175aA4653f20';
    const usdcParamsObj = { loanToken: USDC, collateralToken: CIRBTC, oracle: USDC_ORACLE, irm: IRM, lltv: 860000000000000000n };
    const borrowAbi = parseAbi(['function borrow((address loanToken, address collateralToken, address oracle, address irm, uint256 lltv) marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)']);
    const usdcUnits = (n) => `0x${(n * 10n ** 18n / 1_000_000n).toString(16)}`;
    const setUsdc = (who, sixDecimals) => rpc('anvil_setBalance', [who, usdcUnits(sixDecimals)]);

    // (ee) A borrower far over 40% who never paid through Adag: the page asks for the one "record my existing loan"
    // signature first, then the payment from cash goes through with no 40% check.
    {
      const BORROWER = getAddress('0x87367570B77D92AAC699475d2894539C6092ef24');
      await rpc('anvil_impersonateAccount', [BORROWER]);
      await setUsdc(BORROWER, 10_000_000n);
      const EE = newBill('USDC', 100_000, 'E2E-EE');
      const ltv = await fork.readContract({ address: ADAG, abi: ltvAbi, functionName: 'loanToValue', args: [BORROWER, MARKET_USDC] });
      const { context, page } = await openPage({ account: BORROWER });
      await connect(page, `/bill/${EE}`).catch(() => {});
      const card = page.locator('[data-enrol="current"]');
      await card.waitFor({ timeout: 60_000 });
      const cardText = await card.innerText();
      const disabledBefore = await page.locator('[data-action="pay-balance"]').isDisabled();
      await shoot(page, 'a2b-ee-enrol');
      const fromBlock = await fork.getBlockNumber();
      await page.locator('[data-action="enrol"]').click();
      await page.locator('[data-enrol-state="waiting-block"]').waitFor({ timeout: 120_000 }).catch(async (e) => {
        console.log(`  (ee) stalled, the card reads:${(await card.innerText().catch(() => 'gone')).replace(/\s+/g, ' ')} | log ${JSON.stringify(await page.evaluate(() => window.__walletLog))}`);
        throw e;
      });
      await rpc('evm_mine');
      await page.locator('[data-action="pay-balance"]:not([disabled])').waitFor({ timeout: 90_000 });
      await page.locator('[data-action="pay-balance"]').click();
      await page.locator('[data-tx-result="paid"]').waitFor({ timeout: 120_000 });
      await page.waitForTimeout(1200);
      await shoot(page, 'a2b-ee-paid');
      const sent = await sends(page);
      await context.close();
      const enrolled = await fork.getLogs({ address: ADAG, event: enrolledEvent, args: { payer: BORROWER }, fromBlock });
      const paidLog = await billPaidLog(EE);
      record(`(ee) a ${(Number(ltv) / 1e16).toFixed(2)}% borrower sees the enrol card, records the loan in one signature, then pays bill #${EE} from cash with no 40% check`,
        ltv > 4n * 10n ** 17n && /Record it once, no money moves/.test(cardText) && /does not change your loan/.test(cardText) && disabledBefore
          && enrolled.length === 1 && paidLog?.args.payer.toLowerCase() === BORROWER.toLowerCase() && paidLog?.args.loanChecked === false && sent === 2,
        `card: "${cardText.split('\n').slice(1, 2).join('')}"; pay button disabled before: ${disabledBefore}; Enrolled logs ${enrolled.length}; BillPaid loanChecked ${paidLog?.args.loanChecked}; wallet sends ${sent}`);
    }

    // (ff) A guard rule that would act now: the pay page keeps its repayment aside and says so, and a balance that
    // covers the bill only without it is not offered pay from balance.
    const price = await fork.readContract({ address: USDC_ORACLE, abi: oracleAbi, functionName: 'price' });
    {
      await setUsdc(PAYER, 10_000_000n);
      const pledge = 3_000n;
      const held = await cirBtcOf(PAYER);
      if (held < pledge) throw new Error(`the payer holds ${held} sat of cirBTC, less than the ${pledge} this scenario pledges`);
      const borrow = (((pledge * price) / 10n ** 36n) * 35n) / 100n;
      const setup = [
        forkScript('send', PAYER, CIRBTC, 'approve(address,uint256)', MORPHO, String(pledge)),
        forkScript('send', PAYER, MORPHO, `supplyCollateral(${MP},uint256,address,bytes)`, USDC_PARAMS, String(pledge), PAYER, '0x'),
        forkScript('send', PAYER, MORPHO, `borrow(${MP},uint256,uint256,address,address)`, USDC_PARAMS, String(borrow), '0', PAYER, PAYER),
        forkScript('send', PAYER, USDC, 'approve(address,uint256)', GUARD, '1000000'),
        forkScript('send', PAYER, GUARD, 'setRule(bytes32,uint64,uint64,uint64)', MARKET_USDC, '300000000000000000', '200000000000000000', '0'),
      ];
      const [, fullAmount] = await fork.readContract({ address: GUARD, abi: quoteAbi, functionName: 'quote', args: [PAYER, MARKET_USDC] });
      const FF = newBill('USDC', 100_000, 'E2E-FF');
      // Enough for the bill and its fee, not for the bill, the fee and what the guard is about to pull. The guard's
      // quote is capped by the wallet's balance, so it is read again once the balance is set.
      await setUsdc(PAYER, 100_000n + fullAmount / 2n);
      const [wouldAct, pendingAmount] = await fork.readContract({ address: GUARD, abi: quoteAbi, functionName: 'quote', args: [PAYER, MARKET_USDC] });
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${FF}`).catch(() => {});
      const note = page.locator('[data-guard-pending]');
      await note.waitFor({ timeout: 60_000 });
      const noteText = await note.innerText();
      await page.waitForTimeout(1500);
      const offered = await page.locator('[data-action="pay-balance"]').count();
      await shoot(page, 'a2b-ff-kept-aside');
      const sent = await sends(page);
      await context.close();
      await setUsdc(PAYER, 10_000_000n);
      // The page reads the same quote; its first digits must appear in the sentence.
      const shown = formatUnits(pendingAmount, 6).slice(0, 4);
      record(`(ff) with the guard about to repay ${(Number(pendingAmount) / 1e6).toFixed(6)} USDC, bill #${FF} keeps it aside, says so, and pay from balance is not offered`,
        setup.every((s) => s.includes('"status":"0x1"')) && wouldAct && pendingAmount > 0n && noteText.includes('Your loan guard will repay about') && noteText.includes(shown) && offered === 0 && sent === 0,
        `set-up ${setup.join(' ')}; quote wouldAct ${wouldAct}, amount ${pendingAmount}; shown: "${noteText}"; pay-from-balance buttons ${offered}; wallet sends ${sent}`);
    }

    // (gg) Paying from bitcoin into that loan lands past the rule's 30% trigger: the page says so, with an amount.
    {
      const GG = newBill('USDC', 200_000, 'E2E-GG');
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${GG}`).catch(() => {});
      const note = page.locator('[data-guard-trigger]');
      await note.waitFor({ timeout: 60_000 });
      const text = await note.innerText();
      await shoot(page, 'a2b-gg-trigger');
      const sent = await sends(page);
      await context.close();
      const amount = /repay about ([0-9.,]+) USDC/.exec(text)?.[1];
      record(`(gg) paying bill #${GG} from bitcoin shows the guard-trigger sentence with the amount it will repay`,
        /at or past your guard's 30\.00% trigger/.test(text) && /back to 20\.00%/.test(text) && amount !== undefined && Number(amount.replace(/,/g, '')) > 0 && sent === 0,
        `shown: "${text}"`);
    }

    // (hh) Closing a loan that has a guard rule also stops the guard, in the same transaction (C60).
    {
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, '/app').catch(() => {});
      const ticket = page.locator('[data-loan="USDC"]');
      await ticket.waitFor({ timeout: 60_000 });
      await ticket.getByRole('tab', { name: 'Close loan' }).click();
      const warn = ticket.locator('[data-close-stops-guard]');
      await warn.waitFor({ timeout: 60_000 });
      const warnText = await warn.innerText();
      await shoot(page, 'a2b-hh-close');
      const fromBlock = await fork.getBlockNumber();
      await ticket.locator('[data-action="close-loan"]').click();
      const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
      if (await dialog.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      }
      await ticket.locator('[data-tx-result="closed"]').waitFor({ timeout: 120_000 });
      const done = await ticket.locator('[data-tx-result="closed"]').innerText();
      await shoot(page, 'a2b-hh-closed');
      await context.close();
      const rule = await fork.readContract({ address: GUARD, abi: guardAbi, functionName: 'ruleOf', args: [PAYER, MARKET_USDC] });
      const allowance = await fork.readContract({ address: USDC, abi: tokenAbi, functionName: 'allowance', args: [PAYER, GUARD] });
      const cleared = await fork.getLogs({ address: GUARD, event: quoteAbi[1], args: { borrower: PAYER }, fromBlock });
      const end = await positionOf(PAYER);
      record('(hh) closing the USDC loan also clears its guard rule and sets the guard approval to 0, in the same transaction',
        /Closing also stops the loan guard/.test(warnText) && end[1] === 0n && end[2] === 0n && rule.triggerWad === 0n && allowance === 0n && cleared.length === 1 && /loan guard for this loan is off/.test(done),
        `warned: "${warnText}"; after: ${end[1]} shares, ${end[2]} pledged; rule trigger ${rule.triggerWad}; guard approval ${allowance}; RuleCleared logs ${cleared.length}`);
    }

    store.advance(601_000);
    // (ii) A Safe with an existing loan over 40% that Adag never saw proposes the recording as its own Safe transaction:
    // one inner call, enrol() on the current AdagBills, by delegatecall to MultiSendCallOnly, every gas field 0.
    {
      const [, sShares, sColl] = await fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'position', args: [MARKET_USDC, SAFE] });
      const mk = await fork.readContract({ address: MORPHO, abi: marketAbi, functionName: 'market', args: [MARKET_USDC] });
      const debt = (sShares * (mk[2] + 1n) + mk[3] + 1_000_000n - 1n) / (mk[3] + 1_000_000n);
      const extra = (((sColl * price) / 10n ** 36n) * 60n) / 100n - debt;
      const borrowed = await execSafe(MORPHO, encodeFunctionData({ abi: borrowAbi, functionName: 'borrow', args: [usdcParamsObj, extra, 0n, SAFE, SAFE] }));
      const safeLtv = await fork.readContract({ address: ADAG, abi: ltvAbi, functionName: 'loanToValue', args: [SAFE, MARKET_USDC] });
      const II = newBill('USDC', 100_000, 'E2E-II');
      const { context, page } = await openPage({ account: OWNER1.address, signer: OWNER1 });
      await connect(page, `/bill/${II}`).catch(() => {});
      await page.locator('[data-action="safe-open"]').first().click();
      await page.locator('[data-field="safe-address"]').fill(SAFE);
      await page.locator('[data-action="safe-check"]').click();
      // Paying from the Safe's bitcoin would bring the whole loan back under 40%, so that path needs no recording;
      // paying from the Safe's balance does.
      await page.locator('[data-safe-choice="USDC-balance"]:not([disabled])').waitFor({ timeout: 60_000 });
      await page.locator('[data-safe-choice="USDC-balance"]').check();
      await page.locator('[data-safe-enrol]').waitFor({ timeout: 60_000 });
      const proposeDisabled = await page.locator('[data-action="safe-propose"]').isDisabled();
      const before = mockSafe.proposals.size;
      await page.locator('[data-action="safe-enrol"]').click();
      await page.locator('[data-safe-enrol-proposed]').waitFor({ timeout: 120_000 });
      await shoot(page, 'a2b-ii-safe-enrol');
      const signed = await signRequests(page);
      await context.close();
      const proposal = lastProposal();
      const multiSend = parseAbi(['function multiSend(bytes transactions)']);
      const packed = decodeFunctionData({ abi: multiSend, data: proposal.data }).args[0].slice(2);
      const inner = { operation: parseInt(packed.slice(0, 2), 16), to: getAddress(`0x${packed.slice(2, 42)}`), value: BigInt(`0x${packed.slice(42, 106)}`), length: Number(BigInt(`0x${packed.slice(106, 170)}`)), data: `0x${packed.slice(170)}` };
      const signer = await recoverTypedDataAddress({ ...typedOf(proposal), signature: proposal.confirmations[0].signature });
      const zero = [proposal.safeTxGas, proposal.baseGas, proposal.gasPrice, proposal.value].every((v) => String(v) === '0') && proposal.gasToken === ZERO && proposal.refundReceiver === ZERO;
      record("(ii) a Safe over 40% proposes recording its own loan: one enrol() call on the current AdagBills, MultiSendCallOnly by delegatecall, gas fields 0, signed by the owner",
        borrowed.status === 'success' && safeLtv > 4n * 10n ** 17n && proposeDisabled && mockSafe.proposals.size === before + 1
          && getAddress(proposal.to) === getAddress('0x9641d764fc13c8B624c04430C7356C1C7C8102e2') && Number(proposal.operation) === 1 && zero
          && inner.operation === 0 && inner.to === getAddress(ADAG) && inner.value === 0n && inner.length === 4 && inner.data === toFunctionSelector('enrol()')
          && signer === getAddress(OWNER1.address) && signed === 1,
        `Safe loan-to-value ${(Number(safeLtv) / 1e16).toFixed(2)}%; payment button disabled: ${proposeDisabled}; proposal to ${proposal.to}, operation ${proposal.operation}, gas fields zero ${zero}; inner ${inner.operation} ${inner.to} value ${inner.value} data ${inner.data}; signature from ${signer}`);
    }

    // (jj) At 375 the wallet modal fits inside the screen with no sideways scroll, and the phone menu and the desktop
    // nav both carry Loan guard.
    {
      const JJ = newBill('USDC', 100_000, 'E2E-JJ');
      const phone = await openPage({ account: PAYER, noWallet: true, width: 375, theme: 'light' });
      await phone.page.goto(`${APP}/bill/${JJ}`, { waitUntil: 'networkidle', timeout: 120_000 });
      const box = await openWalletModal(phone.page, 'last');
      await phone.page.screenshot({ path: `${SHOTS}/a2b-jj-sheet-375-light.png`, fullPage: false });
      await phone.page.keyboard.press('Escape');
      await phone.page.locator('w3m-modal wui-card').first().waitFor({ state: 'hidden', timeout: 10_000 });
      await phone.page.locator('[data-action="menu"]').click();
      const phoneLink = await phone.page.getByRole('dialog', { name: 'Menu' }).getByRole('link', { name: 'Loan guard' }).getAttribute('href');
      await phone.page.screenshot({ path: `${SHOTS}/a2b-jj-menu-375-light.png`, fullPage: false });
      await phone.context.close();
      const desk = await openPage({ account: PAYER });
      await desk.page.goto(`${APP}/app/protect`, { waitUntil: 'networkidle', timeout: 120_000 });
      const deskLink = desk.page.locator('header nav[aria-label="App"]').getByRole('link', { name: 'Loan guard' });
      const deskHref = await deskLink.getAttribute('href');
      const deskCurrent = await deskLink.getAttribute('aria-current');
      await desk.page.screenshot({ path: `${SHOTS}/a2b-jj-nav-1440-dark.png`, fullPage: false });
      await desk.context.close();
      record('(jj) at 375 the wallet modal fits inside the screen with no sideways scroll, and Loan guard is in the phone menu and the desktop nav',
        modalFits(box) && phoneLink === '/app/protect' && deskHref === '/app/protect' && deskCurrent === 'page',
        `modal open ${box.open}, card ${JSON.stringify(box.card)} in ${box.width} by ${box.height}, page scroll width ${box.scrollWidth}; phone menu link ${phoneLink}; desktop link ${deskHref}, current ${deskCurrent}`);
    }

    // (kk) The basket learns the enrol card. The 70.26% borrower recorded its loan in (ee), so it first borrows 1 USDC
    // more straight from Morpho, outside Adag: that new debt is unrecorded and the loan is still far over 40%.
    {
      const BORROWER = getAddress('0x87367570B77D92AAC699475d2894539C6092ef24');
      const more = forkScript('send', BORROWER, MORPHO, `borrow(${MP},uint256,uint256,address,address)`, USDC_PARAMS, '1000000', '0', BORROWER, BORROWER);
      await setUsdc(BORROWER, 10_000_000n);
      const K1 = newBill('USDC', 100_000, 'E2E-KK-1');
      const K2 = newBill('USDC', 150_000, 'E2E-KK-2');
      const { context, page } = await openPage({ account: BORROWER });
      await page.goto(`${APP}/pay/basket?bills=${K1},${K2}`, { waitUntil: 'networkidle', timeout: 120_000 });
      await clickConnect(page);
      const balance = page.locator('[data-choice="USDC-balance"]:not([disabled])');
      await balance.waitFor({ timeout: 60_000 });
      await balance.click();
      const card = page.locator('[data-enrol="current"]');
      await card.waitFor({ timeout: 60_000 });
      const cardText = await card.innerText();
      const disabledBefore = await page.locator('[data-action="pay-basket"]').isDisabled();
      await shoot(page, 'a2c-kk-enrol');
      const fromBlock = await fork.getBlockNumber();
      await page.locator('[data-action="enrol"]').click();
      await page.locator('[data-enrol-state="waiting-block"]').waitFor({ timeout: 120_000 });
      await rpc('evm_mine');
      await page.locator('[data-action="pay-basket"]:not([disabled])').waitFor({ timeout: 90_000 });
      await page.locator('[data-action="pay-basket"]').click();
      await page.locator('[data-tx-result="basket-paid"]').waitFor({ timeout: 120_000 });
      await page.waitForTimeout(1200);
      await shoot(page, 'a2c-kk-paid');
      const sent = await sends(page);
      await context.close();
      const enrolled = await fork.getLogs({ address: ADAG, event: enrolledEvent, args: { payer: BORROWER }, fromBlock });
      const logs = await Promise.all([K1, K2].map((id) => billPaidLog(id)));
      record(`(kk) a basket of bills #${K1} and #${K2} for the 70.26% borrower with unrecorded debt: the enrol card, one recording, then both paid from balance with no 40% check`,
        more.includes('"status":"0x1"') && /Record it once, no money moves/.test(cardText) && disabledBefore && enrolled.length === 1
          && logs.every((l) => l?.args.payer.toLowerCase() === BORROWER.toLowerCase() && l?.args.loanChecked === false) && sent === 2,
        `extra borrow ${more}; card: "${cardText.split('\n').slice(1, 2).join('')}"; pay button disabled before: ${disabledBefore}; Enrolled logs ${enrolled.length}; BillPaid loanChecked ${logs.map((l) => l?.args.loanChecked).join(', ')}; wallet sends ${sent}`);
    }

    // (rr) F6: /bill/1, the judge's proof, shows how it was paid, read from its own transaction, and three ways on.
    {
      // Bill #1's own payment is the proof the judges open, and the page can only describe a payment it can fetch. Arc's public RPC keeps
      // transaction lookups for about ten days: on 7 October 2026 it stopped returning the 26 September one (null for eth_getTransactionByHash,
      // while dRPC still has it). Once it is gone, the same checks run on bill B, which this run paid from bitcoin and whose transaction the
      // fork holds itself, and the result line says so.
      const bill1Served = await createPublicClient({ transport: http('https://rpc.mainnet.arc.io', { timeout: 30_000 }) })
        .getTransaction({ hash: '0x7dba4d03f85fd5c323c2172252e55a8d9ed00f0903a2a0ccf1313a84687e3ad0' })
        .then(() => true, () => false);
      const rrBill = bill1Served ? 1n : B;
      const { context, page } = await openPage({ account: PAYER, noWallet: true });
      await page.goto(`${APP}/bill/${rrBill}`, { waitUntil: 'networkidle', timeout: 120_000 });
      const how = page.locator('[data-how-paid]');
      await how.waitFor({ timeout: 60_000 });
      const kind = await how.getAttribute('data-how-paid');
      const figures = await how.locator('dl > div').evaluateAll((els) => els.map((e) => [e.querySelector('dt')?.textContent ?? '', e.querySelector('dd')?.textContent ?? '']));
      const links = await how.locator('[data-visitor-links] a').evaluateAll((els) => els.map((e) => e.getAttribute('href')));
      const txHref = await page.locator('#bill-title').evaluate((el) => el.closest('section')?.querySelector('a[href*="/tx/"]')?.getAttribute('href') ?? '');
      await shoot(page, 'a2e-rr-how-paid');
      await context.close();
      const hash = txHref.split('/tx/')[1];
      const receipt = await oldReceipt(hash);
      const morphoEvents = parseAbi([
        'event SupplyCollateral(bytes32 indexed id, address indexed caller, address indexed onBehalf, uint256 assets)',
        'event Borrow(bytes32 indexed id, address caller, address indexed onBehalf, address indexed receiver, uint256 assets, uint256 shares)',
      ]);
      const evs = parseEventLogs({ abi: morphoEvents, logs: receipt.logs }).filter((l) => l.address.toLowerCase() === MORPHO.toLowerCase() && l.args.onBehalf.toLowerCase() === PAYER.toLowerCase());
      const pledged = evs.filter((e) => e.eventName === 'SupplyCollateral').reduce((s, e) => s + e.args.assets, 0n);
      const borrowed = evs.find((e) => e.eventName === 'Borrow')?.args.assets ?? 0n;
      const ltv = await fork.readContract({ address: ADAG, abi: ltvAbi, functionName: 'loanToValue', args: [PAYER, MARKET_USDC], blockNumber: receipt.blockNumber });
      const value = (label) => (figures.find(([dt]) => dt.startsWith(label))?.[1] ?? '').replace(/,/g, '');
      const bp = (ltv * 10_000n) / 10n ** 18n;
      const wantLtv = `${bp / 100n}.${(bp % 100n).toString().padStart(2, '0')}%`;
      const pledgedShown = value('Pledged').split(' ')[0];
      const borrowedShown = value('Borrowed').split(' ')[0];
      record(`(rr) /bill/${rrBill} shows how it was paid: pledged, borrowed and loan-to-value after, matching its own transaction, with three links onward${bill1Served ? '' : ' (bill 1 is past Arc public RPC retention, see above)'}`,
        kind === 'bitcoin' && pledgedShown !== '' && parseUnits(pledgedShown, 8) === pledged && borrowedShown !== '' && parseUnits(borrowedShown, 6) === borrowed
          && value('Loan-to-value after') === wantLtv && value('Bitcoin sold').startsWith('0') && JSON.stringify(links) === JSON.stringify(['/break', '/bill/new', '/docs/how-it-works']),
        `tx ${hash}; pledged ${pledgedShown} (receipt ${pledged} sat); borrowed ${borrowedShown} (receipt ${borrowed}); loan-to-value ${value('Loan-to-value after')} (at the block ${wantLtv}); links ${links.join(' ')}`);
    }

    // (ll) C58 fails closed: with AdagGuard answering nothing but reverts, paying from bitcoin stays disabled and says why.
    {
      const code = await rpc('eth_getCode', [GUARD, 'latest']);
      await rpc('anvil_setCode', [GUARD, '0x60006000fd']);
      const LL = newBill('USDC', 100_000, 'E2E-LL');
      let reason = '';
      let disabled = false;
      try {
        const { context, page } = await openPage({ account: PAYER });
        await connect(page, `/bill/${LL}`).catch(() => {});
        const blocked = page.locator('[data-blocked-reason]', { hasText: 'cannot tell you whether this payment trips it' });
        await blocked.waitFor({ timeout: 60_000 });
        reason = await blocked.innerText();
        disabled = await page.locator('[data-action="pay-bitcoin"]').isDisabled();
        await shoot(page, 'a2d-ll-unreadable');
        await context.close();
      } finally {
        await rpc('anvil_setCode', [GUARD, code]);
      }
      record('(ll) with the loan guard unreadable, the pay-from-bitcoin button is disabled and the page says why',
        disabled && reason === "Adag could not read your loan guard, so it cannot tell you whether this payment trips it. Try again.",
        `button disabled ${disabled}; shown: "${reason}"`);
    }

    // (mm) A rule saved after the page loaded is caught at signing: the sentence shows and the wallet is never asked.
    {
      await setUsdc(PAYER, 10_000_000n);
      const MM = newBill('USDC', 200_000, 'E2E-MM');
      const { context, page } = await openPage({ account: PAYER });
      await connect(page, `/bill/${MM}`).catch(() => {});
      await page.locator('[data-action="pay-bitcoin"]:not([disabled])').waitFor({ timeout: 60_000 });
      const shownBefore = await page.locator('[data-guard-trigger]').count();
      const saved = [
        forkScript('send', PAYER, USDC, 'approve(address,uint256)', GUARD, '1000000'),
        forkScript('send', PAYER, GUARD, 'setRule(bytes32,uint64,uint64,uint64)', MARKET_USDC, '300000000000000000', '200000000000000000', '0'),
      ];
      await page.locator('[data-action="pay-bitcoin"]').click();
      const dialog = page.getByRole('dialog', { name: /Borrowing through Morpho/ });
      if (await dialog.waitFor({ timeout: 5_000 }).then(() => true, () => false)) {
        await dialog.getByRole('checkbox').check();
        await dialog.getByRole('button', { name: 'Continue to payment' }).click();
      }
      const failed = page.locator('[data-tx-state="failed"]');
      await failed.waitFor({ timeout: 60_000 });
      const failText = await failed.innerText();
      const note = await page.locator('[data-guard-trigger]').innerText();
      await shoot(page, 'a2d-mm-caught');
      const sent = await sends(page);
      await context.close();
      const unsaved = [forkScript('send', PAYER, GUARD, 'clearRule(bytes32)', MARKET_USDC), forkScript('send', PAYER, USDC, 'approve(address,uint256)', GUARD, '0')];
      record(`(mm) a guard rule saved after bill #${MM}'s page loaded is caught at signing: the sentence shows and nothing reaches the wallet`,
        [...saved, ...unsaved].every((s) => s.includes('"status":"0x1"')) && shownBefore === 0 && /changed since this page loaded/.test(failText)
          && /at or past your guard's 30\.00% trigger/.test(note) && sent === 0,
        `sentence before the click ${shownBefore}; stopped with "${failText}"; note: "${note}"; wallet sends ${sent}`);
    }

    // (tt) Ready to lend: a bill bigger than the cash Morpho has free right now switches From bitcoin off, on the bill
    // page and in a basket, with the plain message. A bill that cash covers still says "ready to lend now."
    {
      const market = await fork.readContract({ address: MORPHO, abi: marketAbi, functionName: 'market', args: [MARKET_USDC] });
      const free = market[0] > market[2] ? market[0] - market[2] : 0n;
      // The same figure the page prints: thousands grouped, at least two decimals, no trailing zeros beyond that.
      const [wholePart, fracPart = ''] = formatUnits(free, 6).split('.');
      const readyShown = `${wholePart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fracPart.replace(/0+$/, '').padEnd(2, '0')} USDC`;
      const appears = (locator, timeout = 45_000) => locator.waitFor({ timeout }).then(() => true, () => false);
      const bigAmount = free + 1_000_000n;
      const BIG = newBill('USDC', bigAmount, 'E2E-TT-BIG');
      const bigShown = formatUnits(bigAmount, 6);

      const one = await openPage({ account: PAYER });
      await connect(one.page, `/bill/${BIG}`);
      const note = one.page.locator('[data-lend="short"]');
      const noteShown = await appears(note, 60_000);
      const noteText = noteShown ? (await note.innerText()).replace(/\s+/g, ' ') : '';
      // On the bill page the whole From bitcoin block is replaced by the message, so the button is absent, not just disabled.
      const bitcoinButtons = await one.page.locator('[data-action="pay-bitcoin"]').count();
      const bitcoinUsable = await one.page.locator('[data-action="pay-bitcoin"]:not([disabled])').count();
      await shoot(one.page, 'a2f-tt-lend-short');
      const sentOne = await sends(one.page);
      await one.context.close();

      const two = await openPage({ account: PAYER });
      await openBasket(two.page, [BIG]);
      const choice = two.page.locator('[data-choice="USDC-bitcoin"]');
      const choiceShown = await appears(choice.filter({ hasText: 'ready to lend right now' }), 60_000);
      const choiceText = choiceShown ? (await choice.innerText()).replace(/\s+/g, ' ') : '';
      const choiceDisabled = choiceShown && (await choice.isDisabled());
      const choiceChecked = choiceShown ? await choice.getAttribute('aria-checked') : null;
      await shoot(two.page, 'a2f-tt-lend-short-basket');
      const sentTwo = await sends(two.page);
      await two.context.close();

      // 0.10 USDC is the smallest cash worth testing a covered bill against; under that the check is skipped, and says so.
      let coveredNote = `skipped: free cash ${readyShown} is under 0.10 USDC`;
      let coveredOk = true;
      if (free >= 100_000n) {
        const SMALL = newBill('USDC', 100_000, 'E2E-TT-SMALL');
        const three = await openPage({ account: PAYER });
        await connect(three.page, `/bill/${SMALL}`);
        const line = three.page.getByText(`Morpho has ${readyShown} ready to lend now.`).first();
        const lineShown = await appears(line);
        const usable = await appears(three.page.locator('[data-action="pay-bitcoin"]:not([disabled])'));
        const shortShown = await three.page.locator('[data-lend="short"]').count();
        await three.context.close();

        const four = await openPage({ account: PAYER });
        await openBasket(four.page, [SMALL]);
        const usableChoice = four.page.locator('[data-choice="USDC-bitcoin"]:not([disabled])');
        const choiceUsable = await appears(usableChoice);
        const coveredText = choiceUsable ? (await usableChoice.innerText()).replace(/\s+/g, ' ') : '';
        await four.context.close();

        coveredOk = lineShown && usable && shortShown === 0 && choiceUsable && coveredText.includes('ready to lend now.') && !coveredText.includes('right now');
        coveredNote = `0.10 USDC bill #${SMALL}: "ready to lend now." line ${lineShown}, From bitcoin usable ${usable}, short message ${shortShown}; basket option usable ${choiceUsable}, text "${coveredText}"`;
      }

      record(`(tt) bill #${BIG} (${bigShown} USDC) above Morpho's ${readyShown} free cash: From bitcoin is off with the plain message on the bill page and in a basket, and a covered bill says "ready to lend now."`,
        noteShown && noteText === `Morpho has ${readyShown} ready to lend right now, less than this bill. Paying from your balance still works, or check back later.`
          && bitcoinUsable === 0 && choiceShown && choiceDisabled && choiceChecked !== 'true'
          && choiceText.includes(`Morpho has ${readyShown} ready to lend right now, less than these bills.`)
          && sentOne === 0 && sentTwo === 0 && (await statusOf(BIG)) === 1 && coveredOk,
        `fork free cash ${free} base units (${readyShown}); bill ${bigAmount} base units; bill page: "${noteText}", pay-from-bitcoin buttons ${bitcoinButtons} (usable ${bitcoinUsable}); basket option disabled ${choiceDisabled}, checked ${choiceChecked}, text "${choiceText}"; wallet sends ${sentOne + sentTwo}; covered: ${coveredNote}`);
    }

    // The cross-currency Safe line, now that the Safe exists (the rest of the cross-currency scenarios ran first).
    await fxScenarios({ safe: { SAFE, OWNER1 }, advanceStore: () => store.advance(601_000), only: ['f'] });

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
    mockService.close();
    await store.close?.();
  }
}

let code = 1;
try {
  await main();
  const passed = results.filter((r) => r.ok).length;
  console.log(`\nconsole errors: ${consoleErrors.length}${consoleErrors.length ? `\n  ${consoleErrors.join('\n  ')}` : ''}`);
  console.log(`CSP violation messages: ${cspMessages.length}${cspMessages.length ? `\n  ${cspMessages.slice(0, 10).join('\n  ')}` : ''}`);
  console.log(`browser errors for a failing Circle answer that was expected (stubbed on purpose, or a real no route the app repeats): ${stubbedCircleErrors.length}`);
  const reownByKind = new Map();
  for (const r of reownRequests) {
    const [method, where] = r.split(' ');
    const kind = `${method} ${where.split('/').slice(0, 3).join('/')}`;
    reownByKind.set(kind, (reownByKind.get(kind) ?? 0) + 1);
  }
  console.log(`requests to Reown and WalletConnect, every one answered by a stub: ${reownRequests.length}`);
  for (const [kind, n] of reownByKind) console.log(`  ${n} x ${kind}`);
  const allOk = passed === results.length && results.length === (FX_ONLY ? FX_SCENARIOS - 1 : 46 + FX_SCENARIOS) && consoleErrors.length === 0;
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
