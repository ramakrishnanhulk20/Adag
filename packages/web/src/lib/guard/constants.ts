// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { getAddress, isAddress, parseEther, parseGwei, toFunctionSelector, type Address, type Hex } from "viem";
import { MARKET_EURC, MARKET_USDC } from "../arc/constants";

// Arc mainnet, block 22,859,780, verified on Sourcify and explorer.arc.io.
const DEPLOYED_GUARD: Address | null = "0x9A3F3eE50Ae108124C7Cf54a1b68c14fe5800806";

// NEXT_PUBLIC_ADAG_E2E is written into the build (next.config.ts), so in a real build this whole branch is dead code.
function guardAddress(): Address | null {
  if (process.env.NEXT_PUBLIC_ADAG_E2E === "1") {
    const override = process.env.NEXT_PUBLIC_ADAG_GUARD_E2E;
    if (override && isAddress(override, { strict: false })) return getAddress(override);
  }
  return DEPLOYED_GUARD;
}

export const ADAG_GUARD: Address | null = guardAddress();
export const GUARD_MISSING = "The loan guard is not deployed yet, so there is nothing to run.";

export const GUARD_MARKETS = [MARKET_USDC, MARKET_EURC] as const;
export type GuardMarket = (typeof GUARD_MARKETS)[number];
export const MARKET_CURRENCY: Record<GuardMarket, { symbol: "USDC" | "EURC"; decimals: 6 }> = {
  [MARKET_USDC]: { symbol: "USDC", decimals: 6 },
  [MARKET_EURC]: { symbol: "EURC", decimals: 6 },
};

export const PROTECT_SELECTOR: Hex = toFunctionSelector("protect(address,bytes32)");

// The feeds the two market oracles read, and the aggregators behind them (checked on Arc mainnet: each proxy's
// aggregator() returned these on 26 September). The proxies emit nothing; the aggregators emit AnswerUpdated.
export const BTC_USD_PROXY: Address = "0x7777547914e03BCbB04Ae034942765a0dbb26aE3";
export const EUR_USD_PROXY: Address = "0xa4266689D107aF71c7dBE975cfB92aB40E7b4EFE";
export const BTC_USD_AGGREGATOR: Address = "0x733FE1bA02ea9003C3CFbf5dcc41cf685fF64362";
export const EUR_USD_AGGREGATOR: Address = "0xCEDbC96d866EBe46dcbeF8Ed12F9feA2C464d88F";
export const FEEDS = [
  { proxy: BTC_USD_PROXY, aggregator: BTC_USD_AGGREGATOR },
  { proxy: EUR_USD_PROXY, aggregator: EUR_USD_AGGREGATOR },
] as const;
export const ANSWER_UPDATED_TOPIC: Hex = "0x0559884fd3a460db3073b7fc896cc77986f16e378210ded43186175bf646fc5f";

// Multicall3 at its usual address; its code is on Arc mainnet (checked 26 September).
export const MULTICALL3: Address = "0xcA11bde05977b3631167028862bE2a173976CA11";

// Keeper limits (C42). Anyone can add themselves to AdagGuard's holder set for the price of gas, so a run reads a
// fixed number of pages from a cursor kept in the store and the next run carries on from there. Holders with no
// debt or no allowance are dropped with two cheap reads before any quote, and only a fixed number of the rest are
// simulated. The fee cap is the written worst hour: at most 0.5 USDC of gas, whatever happens.
export const HOLDER_PAGE = 100;
export const PAGES_PER_RUN = 2;
export const MAX_SIMULATIONS_PER_RUN = 5;
export const MAX_ACTIONS_PER_RUN = 5;
export const LEASE_MS = 90_000;
export const RUN_BUDGET_MS = 55_000;
export const BACKOFF_SECONDS = 600;
export const HOURLY_FEE_CAP_WEI = parseEther("0.5");
export const MIN_MAX_FEE = parseGwei("20");
export const PRIORITY_FEE = parseGwei("1");
export const GAS_HEADROOM_PERCENT = 125n;
export const RECEIPT_TIMEOUT_MS = 30_000;

// Alerts: at most this many linked wallets are checked per run, and these are the levels used until a wallet sets its own.
export const MAX_ALERT_WALLETS = 500;
export const DEFAULT_LEVELS_WAD = [parseEther("0.6"), parseEther("0.75")] as const;
export const MIN_LEVEL_WAD = parseEther("0.05");
export const MAX_LEVEL_WAD = parseEther("0.85");
export const MAX_LEVELS = 3;
