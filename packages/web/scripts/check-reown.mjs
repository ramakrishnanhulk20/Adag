// The Reown project id is shared with other apps, and its dashboard overrides AppKit's local feature flags whenever a
// feature carries its own config. Adag turns email, socials, swaps, onramp and activity off locally; this check fails
// if the dashboard would switch any of them back on for Adag.
//   node scripts/check-reown.mjs            (from packages/web, reads NEXT_PUBLIC_WC_PROJECT_ID from .env.local)
import { readFileSync } from 'node:fs';

const fromFile = (() => {
  try {
    const line = readFileSync(new URL('../.env.local', import.meta.url), 'utf8').split(/\r?\n/).find((l) => l.startsWith('NEXT_PUBLIC_WC_PROJECT_ID='));
    return line ? line.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '') : '';
  } catch {
    return '';
  }
})();
const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || fromFile;
if (!/^[0-9a-f]{32}$/i.test(projectId)) {
  console.log('FAIL: no Reown project id in NEXT_PUBLIC_WC_PROJECT_ID or packages/web/.env.local');
  process.exit(1);
}

const res = await fetch(`https://api.web3modal.org/appkit/v1/config?projectId=${projectId}&st=appkit&sv=html-wagmi-2.0.0-wagmi-3.0`);
if (!res.ok) {
  console.log(`FAIL: Reown answered ${res.status}`);
  process.exit(1);
}
const { features } = await res.json();
const watched = ['social_login', 'swap', 'onramp', 'activity'];
const overriding = (features ?? []).filter((f) => watched.includes(f.id) && f.config !== null && f.config !== undefined);
for (const f of features ?? []) console.log(`${f.id.padEnd(22)} enabled ${String(f.isEnabled).padEnd(5)} config ${JSON.stringify(f.config)}`);
if (overriding.length) {
  console.log(`FAIL: the dashboard would override Adag's local "off" for ${overriding.map((f) => f.id).join(', ')}`);
  process.exit(1);
}
console.log('PASS: no dashboard config overrides Adag\'s local feature flags');
