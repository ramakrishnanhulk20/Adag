// End to end for the loan guard's keeper and alerts, on an arc-anvil fork of Arc mainnet where transactions really
// execute. It deploys AdagGuard from source onto the fork, builds a real Morpho loan for a fresh wallet, sets a rule,
// approves USDC, links a Telegram chat through the real routes (Telegram and the store are local mocks), drops the
// bitcoin price past the trigger with a mock oracle, and drives the keeper through its routes.
//
//   node scripts/e2e-guard.mjs            (from packages/web)
//
// Exits 0 only if every check passes. Every key here is made fresh for the run; nothing touches Arc mainnet.
import { registerHooks } from 'node:module';
import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  createPublicClient, createWalletClient, decodeEventLog, defineChain, encodeFunctionData, http, parseAbi, parseEther, parseGwei, stringToHex, toHex,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';

registerHooks({
  resolve(specifier, context, next) {
    try {
      return next(specifier, context);
    } catch (error) {
      if (error?.code === 'ERR_MODULE_NOT_FOUND' && /^\.\.?\//.test(specifier) && !/\.[cm]?[jt]s$/.test(specifier)) return next(`${specifier}.ts`, context);
      throw error;
    }
  },
});
const emitWarning = process.emitWarning.bind(process);
process.emitWarning = (warning, ...rest) => {
  const code = typeof rest[0] === 'object' ? rest[0]?.code : rest[1];
  if (code !== 'MODULE_TYPELESS_PACKAGE_JSON') emitWarning(warning, ...rest);
};

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONTRACTS = resolve(WEB, '../contracts');
const { buildMessage } = await import(pathToFileURL(resolve(WEB, 'src/lib/alerts/message.ts')).href);
const { startMockUpstash } = await import(pathToFileURL(resolve(WEB, 'src/lib/store/test/mock-upstash.mjs')).href);
const { mockOracleCode } = await import(pathToFileURL(resolve(CONTRACTS, 'prove-it/lib.mjs')).href);

// Its own port, build folder and app port, so it never collides with scripts/e2e.mjs (8545, .next-e2e, 3400).
const FORK_PORT = 8546;
const FORK = `http://127.0.0.1:${FORK_PORT}`;
const APP_PORT = 3600;
const APP = `http://localhost:${APP_PORT}`;
const DIST = '.next-e2e-guard';

const MORPHO = '0x34CD04070dD72b14E241112F6d83812Df5Af7fCD';
const USDC = '0x3600000000000000000000000000000000000000';
const CIRBTC = '0x171A4217b86A807A64eB94757Db6849fb4bDbAA0';
const ADAG_BILLS = '0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E';
const MARKET_USDC = '0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d';
const ORACLE_USDC = '0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab';
const BTC_AGGREGATOR = '0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362';
const ANSWER_UPDATED = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';
const TRIGGER = parseEther('0.55');
const TARGET = parseEther('0.45');
const CHAT_ID = 777001;
const HOSTILE_REF = '<b>URGENT</b> [claim](https://evil.example) `now`';

const mp = '(address loanToken, address collateralToken, address oracle, address irm, uint256 lltv)';
const morphoAbi = parseAbi([
  `function idToMarketParams(bytes32 id) view returns ${mp}`,
  `function supplyCollateral(${mp} marketParams, uint256 assets, address onBehalf, bytes data)`,
  `function borrow(${mp} marketParams, uint256 assets, uint256 shares, address onBehalf, address receiver) returns (uint256, uint256)`,
]);
const erc20Abi = parseAbi(['function approve(address, uint256) returns (bool)', 'function transfer(address, uint256) returns (bool)', 'function balanceOf(address) view returns (uint256)']);
const oracleAbi = parseAbi(['function price() view returns (uint256)', 'function BASE_FEED_1() view returns (address)', 'function QUOTE_FEED_1() view returns (address)']);
const guardAbi = parseAbi([
  'function setRule(bytes32 marketId, uint64 triggerWad, uint64 targetWad, uint64 expiry)',
  'function quote(address borrower, bytes32 marketId) view returns (bool wouldAct, uint256 amount, uint256 ltvWad)',
  'event Protected(address indexed borrower, bytes32 indexed marketId, uint256 repaid, uint256 ltvBeforeWad, uint256 ltvAfterWad)',
]);
const billsAbi = parseAbi(['function createBill(address currency, uint256 amount, uint64 due, bytes ref) returns (uint256)']);

const results = [];
const record = (label, ok, detail = '') => {
  results.push({ label, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `\n        ${detail}` : ''}`);
};

// WSL runs the fork and the compiler. The script goes in on stdin, so nothing is re-quoted on the way.
function wsl(script) {
  const r = spawnSync('wsl.exe', ['-d', 'Ubuntu', '--', 'bash', '-s'], { input: `export PATH="$HOME/.local/bin:$HOME/.foundry/bin:/usr/local/bin:/usr/bin:/bin"\n${script}`, encoding: 'utf8' });
  return { status: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const toWsl = (winPath) => `/mnt/${winPath[0].toLowerCase()}${winPath.slice(2).replace(/\\/g, '/')}`;

function startFork() {
  stopFork();
  // stdin from /dev/null, or the fork dies with the pipe that carried this script in. A block every second, as on
  // Arc, because a receipt wait watches for new blocks and an automine-only fork would never make another one.
  const r = wsl(`nohup arc-anvil --fork-url https://rpc.mainnet.arc.io --port ${FORK_PORT} --host 0.0.0.0 --block-time 1 > /tmp/adag-guard-anvil.log 2>&1 < /dev/null &\necho $! > /tmp/adag-guard-anvil.pid\nsleep 1`);
  if (r.status !== 0) throw new Error(`could not start arc-anvil: ${r.out}`);
}
function stopFork() {
  wsl(`[ -f /tmp/adag-guard-anvil.pid ] && kill "$(cat /tmp/adag-guard-anvil.pid)" 2>/dev/null; rm -f /tmp/adag-guard-anvil.pid; pkill -f "arc-anvil --fork-url https://rpc.mainnet.arc.io --port ${FORK_PORT}" 2>/dev/null; true`);
}

const forkChain = defineChain({ id: 5042, name: 'Arc fork', nativeCurrency: { name: 'USDC', symbol: 'USDC', decimals: 18 }, rpcUrls: { default: { http: [FORK] } } });
const fork = createPublicClient({ chain: forkChain, transport: http(FORK, { timeout: 60_000 }), pollingInterval: 250 });
const rpc = (method, params = []) => fork.request({ method, params });
const fees = { maxFeePerGas: parseGwei('50'), maxPriorityFeePerGas: parseGwei('1') };

async function waitForFork() {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await rpc('eth_chainId')) === '0x13b2') return;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('the fork did not come up');
}

async function sendAs(wallet, request) {
  const hash = await wallet.sendTransaction({ ...request, ...fees, chain: forkChain });
  const receipt = await fork.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success') throw new Error(`transaction reverted: ${request.to} ${request.data?.slice(0, 10)}`);
  return receipt;
}

// A local stand-in for api.telegram.org: getMe answers a bot, sendMessage records what would have been sent.
async function startMockTelegram(token) {
  const sent = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      const method = req.url?.startsWith(`/bot${token}/`) ? req.url.slice(`/bot${token}/`.length) : null;
      if (method === 'getMe') return res.end(JSON.stringify({ ok: true, result: { id: 1, is_bot: true, username: 'adag_e2e_bot' } }));
      if (method === 'sendMessage') {
        sent.push(JSON.parse(body));
        return res.end(JSON.stringify({ ok: true, result: { message_id: sent.length } }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, description: 'Not Found' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, sent, close: () => new Promise((r) => server.close(r)) };
}

const nextBin = resolve(WEB, 'node_modules/next/dist/bin/next');
let app = null;
let upstash = null;
let telegram = null;
const tsconfigPath = resolve(WEB, 'tsconfig.json');
const tsconfigBefore = readFileSync(tsconfigPath);

async function main() {
  console.log('e2e-guard: starting arc-anvil on :8546 in WSL');
  startFork();
  await waitForFork();

  // Fresh wallets, funded on the fork only. Arc's native balance is its USDC balance.
  const deployer = privateKeyToAccount(generatePrivateKey()).address;
  const borrower = privateKeyToAccount(generatePrivateKey());
  const keeperKey = generatePrivateKey();
  const keeper = privateKeyToAccount(keeperKey);
  await rpc('anvil_setBalance', [deployer, toHex(parseEther('50'))]);
  await rpc('anvil_setBalance', [borrower.address, toHex(parseEther('2000'))]);
  await rpc('anvil_setBalance', [keeper.address, toHex(parseEther('10'))]);
  await rpc('anvil_impersonateAccount', [deployer]);

  console.log('e2e-guard: deploying AdagGuard from packages/contracts/src/AdagGuard.sol');
  const deployed = wsl(`cd "${toWsl(CONTRACTS)}" && arc-forge create src/AdagGuard.sol:AdagGuard --rpc-url http://127.0.0.1:${FORK_PORT} --unlocked --from ${deployer} --broadcast --gas-price 20gwei --out /tmp/adag-guard-out --cache-path /tmp/adag-guard-cache`);
  const guard = deployed.out.match(/Deployed to:\s*(0x[0-9a-fA-F]{40})/)?.[1];
  if (!guard) throw new Error(`AdagGuard did not deploy:\n${deployed.out.slice(-1500)}`);
  record('AdagGuard deployed on the fork from source', true, guard);

  // A real Morpho loan: 0.01 cirBTC pledged, borrowed to 50% of its value at the oracle's price.
  const wallet = createWalletClient({ account: borrower, chain: forkChain, transport: http(FORK) });
  await rpc('anvil_impersonateAccount', [MORPHO]);
  const morphoWallet = createWalletClient({ account: MORPHO, chain: forkChain, transport: http(FORK) });
  const pledge = 1_000_000n;
  await sendAs(morphoWallet, { to: CIRBTC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [borrower.address, pledge] }) });
  const params = await fork.readContract({ address: MORPHO, abi: morphoAbi, functionName: 'idToMarketParams', args: [MARKET_USDC] });
  const tuple = { loanToken: params[0], collateralToken: params[1], oracle: params[2], irm: params[3], lltv: params[4] };
  const price = await fork.readContract({ address: ORACLE_USDC, abi: oracleAbi, functionName: 'price' });
  const value = (pledge * price) / 10n ** 36n;
  await sendAs(wallet, { to: CIRBTC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [MORPHO, pledge] }) });
  await sendAs(wallet, { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: 'supplyCollateral', args: [tuple, pledge, borrower.address, '0x'] }) });
  await sendAs(wallet, { to: MORPHO, data: encodeFunctionData({ abi: morphoAbi, functionName: 'borrow', args: [tuple, value / 2n, 0n, borrower.address, borrower.address] }) });
  await sendAs(wallet, { to: guard, data: encodeFunctionData({ abi: guardAbi, functionName: 'setRule', args: [MARKET_USDC, TRIGGER, TARGET, 0n] }) });
  await sendAs(wallet, { to: USDC, data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [guard, 1_000_000_000n] }) });
  // Chain text an attacker controls, tied to this wallet: an alert must never carry it.
  await sendAs(wallet, { to: ADAG_BILLS, data: encodeFunctionData({ abi: billsAbi, functionName: 'createBill', args: [USDC, 1_000_000n, 0n, stringToHex(HOSTILE_REF)] }) });
  const [, , ltvStart] = await fork.readContract({ address: guard, abi: guardAbi, functionName: 'quote', args: [borrower.address, MARKET_USDC] });
  record('a real loan near 50%, a rule at 55% back to 45%, and a USDC approval to the guard', ltvStart > parseEther('0.49') && ltvStart < parseEther('0.51'), `loan-to-value ${Number(ltvStart) / 1e16}%`);

  // The app, built against the fork with this guard, a mock store and a mock Telegram.
  upstash = await startMockUpstash({ token: randomBytes(16).toString('hex') });
  // Shaped like a real token (digits, a colon, 36 characters) so the app accepts it; it opens nothing.
  const botToken = `1234567:${randomBytes(27).toString('base64url')}`;
  telegram = await startMockTelegram(botToken);
  const secrets = { cron: randomBytes(24).toString('hex'), qn: randomBytes(24).toString('hex'), tg: randomBytes(24).toString('hex') };
  const appEnv = {
    ...process.env,
    NEXT_DIST_DIR: DIST,
    NEXT_PUBLIC_ADAG_E2E: '1',
    NEXT_PUBLIC_ADAG_GUARD_E2E: guard,
    NEXT_PUBLIC_ARC_RPC_URL: FORK,
    NEXT_PUBLIC_SITE_URL: APP,
    ARC_RPC_URL: FORK,
    ARC_RPC_FALLBACK_URL: FORK,
    KEEPER_PRIVATE_KEY: keeperKey,
    KEEPER_ADDRESS: keeper.address,
    CRON_SECRET: secrets.cron,
    QUICKNODE_WEBHOOK_SECRET: secrets.qn,
    TELEGRAM_BOT_TOKEN: botToken,
    TELEGRAM_WEBHOOK_SECRET: secrets.tg,
    ADAG_E2E_TELEGRAM_API: telegram.url,
    UPSTASH_REDIS_REST_URL: upstash.url,
    UPSTASH_REDIS_REST_TOKEN: upstash.token,
    KV_REST_API_URL: '',
    KV_REST_API_TOKEN: '',
    ADAG_STORE_NAMESPACE: '',
  };
  console.log(`e2e-guard: building the app (${DIST}) and serving it on :${APP_PORT}`);
  if (existsSync(resolve(WEB, DIST))) rmSync(resolve(WEB, DIST), { recursive: true, force: true });
  const built = spawnSync(process.execPath, [nextBin, 'build'], { cwd: WEB, env: appEnv, encoding: 'utf8' });
  writeFileSync(tsconfigPath, tsconfigBefore);
  if (built.status !== 0) throw new Error(`the fork build failed:\n${(built.stdout + built.stderr).slice(-2000)}`);
  app = spawn(process.execPath, [nextBin, 'start', '--port', String(APP_PORT)], { cwd: WEB, env: appEnv, stdio: 'ignore' });
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(`${APP}/docs`, { signal: AbortSignal.timeout(20_000) })).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }

  const post = (path, body, headers = {}) =>
    fetch(`${APP}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: typeof body === 'string' ? body : JSON.stringify(body), signal: AbortSignal.timeout(90_000) });

  // Link a chat, the way a person would: code, Start in Telegram, sign in the wallet.
  const issued = await (await post('/api/alerts/code', {})).json();
  const startUpdate = { update_id: 9001, message: { message_id: 1, date: 0, chat: { id: CHAT_ID, type: 'private' }, from: { id: CHAT_ID, is_bot: false, username: 'e2e_person' }, text: `/start ${issued.code}` } };
  const refused = await post('/api/telegram', startUpdate, { 'x-telegram-bot-api-secret-token': 'wrong' });
  const started = await post('/api/telegram', startUpdate, { 'x-telegram-bot-api-secret-token': secrets.tg });
  const status = await (await post('/api/alerts/code/status', { code: issued.code })).json();
  if (status.state !== 'pressed') throw new Error(`linking stalled: code ${issued.error ?? 'issued'}, start ${started.status} ${await started.text()}, status ${JSON.stringify(status)}, telegram saw ${telegram.sent.length}`);
  const expiry = Math.floor(Date.now() / 1000) + 300;
  const message = buildMessage(APP, { action: 'link', wallet: borrower.address, code: issued.code, chatId: status.chatId, chatHandle: status.chatHandle, expiry });
  const linked = await post('/api/alerts/link', { wallet: borrower.address, code: issued.code, expiry, signature: await borrower.signMessage({ message }) });
  const again = await post('/api/alerts/link', { wallet: borrower.address, code: issued.code, expiry, signature: await borrower.signMessage({ message }) });
  record(
    'a chat links through code, Start and a wallet signature; a wrong webhook secret and a reused code are refused',
    issued.link === `https://t.me/adag_e2e_bot?start=${issued.code}` && refused.status === 401 && started.status === 200 && status.chatId === String(CHAT_ID) && linked.status === 200 && again.status === 410,
    `code ${issued.link ? 'issued' : 'missing'}, bad secret ${refused.status}, start ${started.status}, link ${linked.status}, reuse ${again.status}`,
  );

  // The price drops so the loan sits near 62%, past the 55% trigger: the oracle's code is swapped for MockOracle.
  const base = await fork.readContract({ address: ORACLE_USDC, abi: oracleAbi, functionName: 'BASE_FEED_1' });
  const quoteFeed = await fork.readContract({ address: ORACLE_USDC, abi: oracleAbi, functionName: 'QUOTE_FEED_1' });
  await rpc('anvil_setCode', [ORACLE_USDC, mockOracleCode((price * 50n) / 62n, base, quoteFeed)]);
  const [wouldAct, , ltvDropped] = await fork.readContract({ address: guard, abi: guardAbi, functionName: 'quote', args: [borrower.address, MARKET_USDC] });
  record('after the price drop the guard would act', wouldAct && ltvDropped > TRIGGER, `loan-to-value ${Number(ltvDropped) / 1e16}%`);

  const keeperNonce = () => fork.getTransactionCount({ address: keeper.address });
  const nonce0 = await keeperNonce();

  // A forged price webhook: the right shape, the wrong signature. Nothing may happen.
  const payload = JSON.stringify([{ address: BTC_AGGREGATOR, topics: [ANSWER_UPDATED, '0x01', '0x02'], data: '0x' }]);
  const ts = String(Math.floor(Date.now() / 1000));
  const forged = await post('/api/hooks/quicknode', payload, { 'x-qn-nonce': 'forged-1', 'x-qn-timestamp': ts, 'x-qn-signature': createHmac('sha256', 'not-the-secret').update(`forged-1${ts}${payload}`).digest('hex') });
  const unsigned = await post('/api/hooks/quicknode', payload, {});
  record('a forged or unsigned webhook is refused and sends nothing', forged.status === 401 && unsigned.status === 401 && (await keeperNonce()) === nonce0, `forged ${forged.status}, unsigned ${unsigned.status}`);

  const unauthorised = await post('/api/keeper/run', {}, { authorization: 'Bearer wrong' });
  record('the run route refuses a wrong CRON_SECRET', unauthorised.status === 401 && (await keeperNonce()) === nonce0);

  // Two runs at once: the lease lets one act.
  const fromBlock = await fork.getBlockNumber();
  const auth = { authorization: `Bearer ${secrets.cron}` };
  const [a, b] = await Promise.all([post('/api/keeper/run', {}, auth), post('/api/keeper/run', {}, auth)]);
  const bodies = [await a.json(), await b.json()];
  const logs = await fork.getLogs({ address: guard, fromBlock, toBlock: 'latest' });
  const protectedLogs = logs.map((l) => { try { return decodeEventLog({ abi: guardAbi, data: l.data, topics: l.topics }); } catch { return null; } }).filter((e) => e?.eventName === 'Protected');
  const nonce1 = await keeperNonce();
  record('two concurrent runs send exactly one transaction', nonce1 === nonce0 + 1 && protectedLogs.length === 1, `states ${bodies.map((x) => x.state).join(' and ')}, keeper sent ${nonce1 - nonce0}`);

  const [, , ltvAfter] = await fork.readContract({ address: guard, abi: guardAbi, functionName: 'quote', args: [borrower.address, MARKET_USDC] });
  const event = protectedLogs[0]?.args;
  record('Protected landed and the loan is at or under the 45% target', !!event && event.ltvAfterWad <= TARGET && ltvAfter <= TARGET, event ? `repaid ${Number(event.repaid) / 1e6} USDC, ${Number(event.ltvBeforeWad) / 1e16}% to ${Number(event.ltvAfterWad) / 1e16}%` : 'no event');

  const third = await (await post('/api/keeper/run', {}, auth)).json();
  record('a second run at the same price does nothing', (await keeperNonce()) === nonce1 && third.state === 'done' && third.due === 0, `due ${third.due}`);

  // A correctly signed webhook runs the keeper too, and finds nothing left to do.
  const ts2 = String(Math.floor(Date.now() / 1000));
  const signedHook = await post('/api/hooks/quicknode', payload, { 'x-qn-nonce': 'real-1', 'x-qn-timestamp': ts2, 'x-qn-signature': createHmac('sha256', secrets.qn).update(`real-1${ts2}${payload}`).digest('hex') });
  const replay = await post('/api/hooks/quicknode', payload, { 'x-qn-nonce': 'real-1', 'x-qn-timestamp': ts2, 'x-qn-signature': createHmac('sha256', secrets.qn).update(`real-1${ts2}${payload}`).digest('hex') });
  const hookBody = await signedHook.json();
  const replayBody = await replay.json();
  record('a signed webhook wakes a run; replaying it does nothing', signedHook.status === 200 && hookBody.state === 'done' && replayBody.state === 'duplicate' && (await keeperNonce()) === nonce1, `run ${hookBody.state}, replay ${replayBody.state}`);

  const toChat = telegram.sent.filter((m) => m.chat_id === CHAT_ID);
  const texts = toChat.map((m) => m.text);
  const protectedAlert = texts.find((t) => t.includes("loan guard repaid"));
  const plain = toChat.every((m) => !('parse_mode' in m) && !/[<>`]|evil|claim|URGENT/.test(m.text));
  record('the linked chat got a plain protection alert with no reference text', !!protectedAlert && plain, protectedAlert ? protectedAlert.replace(/\n/g, ' | ') : `messages: ${texts.length}`);

  const leaked = JSON.stringify(bodies) + JSON.stringify(third) + JSON.stringify(hookBody);
  record('no run answer names a linked wallet or chat', !leaked.includes(borrower.address) && !leaked.includes(borrower.address.toLowerCase()) && !leaked.includes(String(CHAT_ID)));
}

try {
  await main();
} catch (error) {
  record('the run finished', false, error.message.slice(0, 1500));
} finally {
  if (app?.pid) spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
  await upstash?.close();
  await telegram?.close();
  stopFork();
  writeFileSync(tsconfigPath, tsconfigBefore);
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\ne2e-guard: ${results.length - failed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
