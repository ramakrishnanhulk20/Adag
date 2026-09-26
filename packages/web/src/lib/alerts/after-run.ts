import type { Address } from "viem";
import { DEFAULT_LEVELS_WAD, MAX_ALERT_WALLETS } from "../guard/constants";
import type { Protection } from "../guard/keeper";
import { readLiveLoans, readQuotes, type KeeperClient } from "../guard/read";
import { keys, normaliseAddress } from "../store/keys";
import type { Store } from "../store/upstash";
import { checkLevels } from "./message";
import type { Telegram } from "./telegram";
import { levelCrossedText, protectedText } from "./text";

type Deps = { client: KeeperClient; store: Store; telegram: Telegram; guard: Address; site: string; blockNumber: bigint; budgetMs: number };

async function levelsOf(store: Store, wallet: Address): Promise<readonly bigint[]> {
  const raw = await store.get(keys.thresholds(wallet));
  if (!raw) return DEFAULT_LEVELS_WAD;
  try {
    return checkLevels(JSON.parse(raw));
  } catch {
    return DEFAULT_LEVELS_WAD;
  }
}

// After a run: one message for each protection, then one for each linked loan that rose past a level it had not
// reached before. The loan-to-value is AdagGuard's own quote, the contract's arithmetic (C50). Best effort: a
// failed send is counted, never retried into a loop, and nothing here can cause a transaction.
export async function sendRunAlerts(protections: Protection[], deps: Deps): Promise<{ sent: number; failed: number }> {
  const { client, store, telegram, guard, site, blockNumber, budgetMs } = deps;
  const started = Date.now();
  let sent = 0;
  let failed = 0;
  const deliver = async (chat: string | null, text: string) => {
    if (!chat) return;
    if (await telegram.send(chat, text)) sent += 1;
    else failed += 1;
  };

  for (const p of protections) {
    await deliver(await store.get(keys.link(p.borrower)), protectedText(p, site));
  }

  const linked: Address[] = [];
  for (const member of (await store.smembers(keys.linked())).slice(0, MAX_ALERT_WALLETS)) {
    try {
      linked.push(normaliseAddress(member));
    } catch {
      // Not an address: skipped.
    }
  }
  if (linked.length === 0) return { sent, failed };

  // Only loans with debt are quoted; an empty position has nothing to alert about.
  const { loans } = await readLiveLoans(client, guard, linked, blockNumber, false);
  for (const quote of await readQuotes(client, guard, loans, blockNumber)) {
    if (Date.now() - started > budgetMs) break;
    const levelKey = keys.level(quote.borrower, quote.market);
    const levels = await levelsOf(store, quote.borrower);
    const reached = quote.ltvWad === 0n ? 0 : levels.filter((l) => quote.ltvWad >= l).length;
    const before = Number((await store.get(levelKey)) ?? "0");
    if (reached === before) continue;
    // Falling back below a level re-arms it, so the next rise past it alerts again.
    await store.set(levelKey, String(reached), { px: 30 * 86_400_000 });
    if (reached > before) {
      await deliver(await store.get(keys.link(quote.borrower)), levelCrossedText({ market: quote.market, ltvWad: quote.ltvWad, levelWad: levels[reached - 1] }, site));
    }
  }
  return { sent, failed };
}
