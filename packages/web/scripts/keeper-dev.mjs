// The keeper's wake-up for local development, where QuickNode's webhook cannot reach localhost. It polls Arc for
// AnswerUpdated from the two price aggregators and calls the run route with CRON_SECRET whenever one appears, and
// once every --every minutes regardless, the way the Vercel cron backs up the webhook.
//
//   node scripts/keeper-dev.mjs [--url=http://localhost:3000] [--poll=15] [--every=30]
//
// Reads CRON_SECRET and ARC_RPC_URL from the environment or packages/web/.env.local, and prints neither.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const WEB = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const arg = (name, fallback) => process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=') ?? fallback;

function localEnv() {
  const file = resolve(WEB, '.env.local');
  const out = {};
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]] = m[2].replace(/^"(.*)"$/, '$1');
  }
  return out;
}
const fileEnv = localEnv();
const env = (name) => process.env[name] || fileEnv[name] || '';

const RUN_URL = `${arg('url', 'http://localhost:3000').replace(/\/+$/, '')}/api/keeper/run`;
const RPC = env('ARC_RPC_URL') || 'https://rpc.mainnet.arc.io';
const SECRET = env('CRON_SECRET');
const POLL_MS = Number(arg('poll', '15')) * 1000;
const EVERY_MS = Number(arg('every', '30')) * 60_000;

const AGGREGATORS = ['0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362', '0xCEDbC96d866EBe46dcbeF8Ed12F9feA2C464d88F'];
const ANSWER_UPDATED = '0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f';
// The RPC refuses log ranges wider than 10,000 blocks.
const MAX_RANGE = 9_999n;

if (!SECRET) {
  console.error('CRON_SECRET is not set in the environment or .env.local, so the run route would refuse every call.');
  process.exit(1);
}

async function rpc(method, params) {
  const res = await fetch(RPC, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    signal: AbortSignal.timeout(10_000),
  });
  const body = await res.json();
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result;
}

async function wake(reason) {
  const started = Date.now();
  try {
    const res = await fetch(RUN_URL, { method: 'POST', headers: { authorization: `Bearer ${SECRET}` }, signal: AbortSignal.timeout(90_000) });
    const body = await res.json().catch(() => ({}));
    const summary = body.state ? `${body.state}, ${body.due ?? 0} due, ${(body.attempts ?? []).length} attempted` : body.error ?? 'no answer';
    console.log(`${new Date().toISOString()} ${reason}: ${res.status} ${summary} (${Date.now() - started} ms)`);
  } catch (error) {
    console.log(`${new Date().toISOString()} ${reason}: the run route did not answer (${error.message})`);
  }
}

let from = BigInt(await rpc('eth_blockNumber', []));
let lastWake = 0;
console.log(`Watching AnswerUpdated from block ${from}; waking ${RUN_URL}. Ctrl+C to stop.`);

for (;;) {
  try {
    const head = BigInt(await rpc('eth_blockNumber', []));
    let found = 0;
    while (from <= head) {
      const to = from + MAX_RANGE < head ? from + MAX_RANGE : head;
      const logs = await rpc('eth_getLogs', [{ address: AGGREGATORS, topics: [ANSWER_UPDATED], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }]);
      found += logs.length;
      from = to + 1n;
    }
    if (found > 0) {
      await wake(`${found} price update${found === 1 ? '' : 's'}`);
      lastWake = Date.now();
    } else if (Date.now() - lastWake > EVERY_MS) {
      await wake('scheduled');
      lastWake = Date.now();
    }
  } catch (error) {
    console.log(`${new Date().toISOString()} poll failed: ${error.message}`);
  }
  await new Promise((r) => setTimeout(r, POLL_MS));
}
