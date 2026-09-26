// Checks the home page against Arc itself: reads every bill of both AdagBills deployments straight from the RPC, then
// asserts that /api/live on the dev server reports the same paid totals, count and newest paid bills, and that no
// paid bill's reference text appears in the home page, /api/live or /api/pledge (security pass 1, M2).
//
//   node scripts/check-landing.mjs            (from packages/web, with the dev server on http://localhost:3000)
//
// Read-only: nothing is signed or sent.
import { createPublicClient, hexToString, http, parseAbi } from 'viem';

// The app's own constants, loaded through the same resolve hook the unit tests use, so no address is restated here.
await import('../src/lib/guard/test/register.mjs');
const { DEPLOYMENTS, USDC, EURC } = await import('../src/lib/pay/constants.ts');

const BASE = process.env.CHECK_BASE_URL || 'http://localhost:3000';
const RPC = process.env.ARC_RPC_URL || 'https://rpc.mainnet.arc.io';
const PAID = 2;

const abi = parseAbi([
  'function billCount() view returns (uint256)',
  'function bill(uint256 id) view returns ((address payee, uint8 status, uint64 due, address currency, uint64 createdAt, uint256 amount, address payer, uint64 paidAt, bytes ref))',
]);
const client = createPublicClient({ transport: http(RPC, { timeout: 15_000, retryCount: 2 }) });

const failures = [];
const check = (ok, label) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failures.push(label);
};

const bills = [];
let written = 0n;
for (const d of DEPLOYMENTS) {
  const count = await client.readContract({ address: d.address, abi, functionName: 'billCount' });
  written += count;
  for (let id = 1n; id <= count; id++) {
    const b = await client.readContract({ address: d.address, abi, functionName: 'bill', args: [id] });
    bills.push({ contract: d.address, label: d.label, id, ...b });
  }
  console.log(`${d.label} AdagBills ${d.address}: ${count} bills`);
}

const paid = bills.filter((b) => b.status === PAID);
const sum = (currency) => paid.filter((b) => b.currency.toLowerCase() === currency.toLowerCase()).reduce((t, b) => t + b.amount, 0n);
const usdc = sum(USDC);
const eurc = sum(EURC);
const newest = [...paid].sort((a, b) => (a.paidAt === b.paidAt ? (a.id > b.id ? -1 : 1) : a.paidAt > b.paidAt ? -1 : 1)).slice(0, 8);
console.log(`From Arc: ${written} bills written, ${paid.length} paid, ${usdc} USDC and ${eurc} EURC base units paid.`);

const fetchText = async (path, init) => {
  const res = await fetch(`${BASE}${path}`, { ...init, signal: AbortSignal.timeout(120_000) });
  if (!res.ok) throw new Error(`${path} answered ${res.status}`);
  return res.text();
};

const liveText = await fetchText('/api/live');
const live = JSON.parse(liveText);
check(live.chainId === 5042, '/api/live answers for Arc mainnet (5042)');
check(live.paid?.ok === true, '/api/live paid cell is available');
check(live.latestBills?.ok === true, '/api/live ledger cell is available');
if (live.paid?.ok) {
  const v = live.paid.value;
  check(v.usdcBaseUnits === usdc.toString(), `paid USDC matches Arc: ${v.usdcBaseUnits} = ${usdc}`);
  check(v.eurcBaseUnits === eurc.toString(), `paid EURC matches Arc: ${v.eurcBaseUnits} = ${eurc}`);
  check(v.billsPaid === paid.length, `bills paid matches Arc: ${v.billsPaid} = ${paid.length}`);
  check(v.billCount === Number(written), `bills written on both contracts matches Arc: ${v.billCount} = ${written}`);
  console.log(`      source: ${v.source}, through block ${v.throughBlock}${v.note ? `, note: ${v.note}` : ''}`);
}
if (live.latestBills?.ok) {
  const shown = live.latestBills.value.bills.map((b) => `${b.contract.toLowerCase()}:${b.id}`);
  const expected = newest.map((b) => `${b.contract.toLowerCase()}:${b.id}`);
  check(JSON.stringify(shown) === JSON.stringify(expected), `ledger shows the newest paid bills, newest first: [${shown.join(', ')}]`);
  const amountsMatch = live.latestBills.value.bills.every((row) => {
    const b = paid.find((x) => x.contract.toLowerCase() === row.contract.toLowerCase() && String(x.id) === row.id);
    return b && row.amountBaseUnits === b.amount.toString() && row.paidAt === Number(b.paidAt) && row.payee === b.payee && row.payer === b.payer;
  });
  check(amountsMatch, 'every ledger row has the amount, payer, payee and paid time Arc stores');
  check(live.latestBills.value.bills.every((row) => !('refHex' in row) && !('reference' in row)), 'no ledger row carries a reference field');
}

const pledgeText = await fetchText('/api/pledge');
const homeHtml = await fetchText('/');
const references = [
  ...new Set(
    paid
      .map((b) => {
        try {
          return b.ref && b.ref !== '0x' ? hexToString(b.ref).trim() : '';
        } catch {
          return '';
        }
      })
      .filter((r) => r.length >= 3),
  ),
];
console.log(`Paid bill references to look for: ${references.length ? references.map((r) => JSON.stringify(r)).join(', ') : 'none'}`);
for (const ref of references) {
  check(!homeHtml.includes(ref), `the home page HTML does not contain ${JSON.stringify(ref)}`);
  check(!liveText.includes(ref), `/api/live does not contain ${JSON.stringify(ref)}`);
  check(!pledgeText.includes(ref), `/api/pledge does not contain ${JSON.stringify(ref)}`);
}

console.log(failures.length ? `\nFAIL: ${failures.length} check(s) failed.` : '\nPASS: the home page matches Arc and shows no bill reference.');
process.exit(failures.length ? 1 : 0);
