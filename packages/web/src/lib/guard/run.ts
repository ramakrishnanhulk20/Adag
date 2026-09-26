import type { PublicClient } from "viem";
import { sendRunAlerts } from "../alerts/after-run";
import { telegramFromEnv } from "../alerts/telegram";
import { arcClient } from "../arc/client";
import { STORE_MISSING, storeFromEnv } from "../store/env";
import { siteUrl } from "../wallet/site";
import { ADAG_GUARD, GUARD_MISSING } from "./constants";
import { runKeeper } from "./keeper";
import { keeperFromEnv } from "./wallet";

export type RunOutcome = { status: number; body: Record<string, unknown> };

const ALERT_BUDGET_MS = 20_000;

// One keeper run, then the alerts it calls for. Shared by the cron route and the webhook route, which each check
// their own caller first. The answer carries counts and transaction hashes only, never who is linked (C49).
export async function runOnce(source: "cron" | "quicknode"): Promise<RunOutcome> {
  if (!ADAG_GUARD) return { status: 503, body: { error: GUARD_MISSING } };
  const store = storeFromEnv();
  if (!store) return { status: 503, body: { error: STORE_MISSING } };
  const keeper = keeperFromEnv();
  if ("error" in keeper) return { status: 503, body: { error: keeper.error } };

  const client = arcClient as PublicClient;
  let result;
  try {
    // The log line holds counts only: no wallet, no chat.
    result = await runKeeper({ client, store, sender: keeper.sender, guard: ADAG_GUARD, log: (line) => console.log(line) });
  } catch {
    return { status: 502, body: { error: "The run could not read Arc or the store. The next run tries again." } };
  }
  if (result.state === "busy") return { status: 200, body: { source, state: "busy" } };

  let alerts = { sent: 0, failed: 0, skipped: true };
  const telegram = telegramFromEnv();
  if (telegram) {
    try {
      alerts = { ...(await sendRunAlerts(result.protections, { client, store, telegram, guard: ADAG_GUARD, site: siteUrl(), blockNumber: result.block, budgetMs: ALERT_BUDGET_MS })), skipped: false };
    } catch {
      alerts = { sent: 0, failed: 0, skipped: true };
    }
  }

  return {
    status: 200,
    body: {
      source,
      state: "done",
      block: result.block.toString(),
      ...result.counts,
      attempts: result.attempts,
      protections: result.protections.length,
      movedFeeds: result.movedFeeds,
      alerts,
    },
  };
}
