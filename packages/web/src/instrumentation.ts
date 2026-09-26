// Runs once when the server starts. It says which server features are off and why, by key name only, never a value.
// It uses the same readers the routes use, so what it reports is exactly what a request would meet. It never throws:
// every route already fails closed on its own.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const [{ keeperFromEnv }, { telegramFromEnv }, { storeFromEnv }, { safeService }] = await Promise.all([
      import("./lib/guard/wallet"),
      import("./lib/alerts/telegram"),
      import("./lib/store/env"),
      import("./lib/safe/service"),
    ]);
    const missing = (name: string) => !process.env[name];
    const storeReasons = storeFromEnv() ? [] : ["UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN (or KV_REST_API_URL and KV_REST_API_TOKEN) missing or not https"];

    const keeper: string[] = [];
    const setup = keeperFromEnv();
    if ("error" in setup) keeper.push(missing("KEEPER_PRIVATE_KEY") ? "KEEPER_PRIVATE_KEY missing" : `KEEPER_PRIVATE_KEY or KEEPER_ADDRESS: ${setup.error}`);
    if (missing("KEEPER_ADDRESS")) keeper.push("KEEPER_ADDRESS missing");
    if (missing("CRON_SECRET")) keeper.push("CRON_SECRET missing");

    const alerts: string[] = [];
    if (missing("TELEGRAM_BOT_TOKEN")) alerts.push("TELEGRAM_BOT_TOKEN missing");
    else if (!telegramFromEnv()) alerts.push("TELEGRAM_BOT_TOKEN malformed");
    if (missing("TELEGRAM_WEBHOOK_SECRET")) alerts.push("TELEGRAM_WEBHOOK_SECRET missing");

    const features: [string, string[]][] = [
      ["keeper", [...keeper, ...storeReasons]],
      ["price webhook", [...(missing("QUICKNODE_WEBHOOK_SECRET") ? ["QUICKNODE_WEBHOOK_SECRET missing"] : []), ...storeReasons]],
      ["alerts", [...alerts, ...storeReasons]],
      ["Safe payments", [...(safeService() ? [] : ["SAFE_API_KEY missing"]), ...storeReasons]],
    ];
    for (const [feature, reasons] of features) {
      if (reasons.length > 0) console.warn(`Adag at boot, ${feature} off: ${reasons.join("; ")}.`);
    }
  } catch {
    console.warn("Adag: the boot check could not run; each route still checks its own settings.");
  }
}
