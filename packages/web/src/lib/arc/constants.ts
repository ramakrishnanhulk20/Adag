import type { Address, Hex } from "viem";

// Copied from ARCHITECTURE.md section 3. Nothing read from the chain is ever used in place of these (C18).
export const CHAIN_ID = 5042;

export const ADAG_BILLS: Address = "0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E";
export const MORPHO: Address = "0x34CD04070dD72b14E241112F6d83812Df5Af7fCD";
export const ADAPTIVE_CURVE_IRM: Address = "0xF02615d094Fc02fC031C35fe705e175aA4653f20";
export const USDC: Address = "0x3600000000000000000000000000000000000000";
export const EURC: Address = "0xbEf5f6d51CB62b58e6A8f77868681825C6fe21c1";
export const CIRBTC: Address = "0x171A4217b86A807A64eB94757Db6849fb4bDbAA0";
export const USDC_MARKET_ORACLE: Address = "0x2AA87fF48933Ce6aBA240BEE916Fc2e6Ec1e51Ab";

export const MARKET_USDC: Hex = "0xc2db905f174e5defcce01d321b09f15f78856a36a21b90cc7e1abbc29225815d";
export const MARKET_EURC: Hex = "0x6ea1ea96a1cc671615f3a3bdf51481c5b79e362a8b634396e680d1070137daf4";
export const USDC_MARKET_LLTV = 860000000000000000n;

export const ADAG_DEPLOY_BLOCK = 22_727_688n;

export const EXPLORER = "https://explorer.arc.io";

// Env overrides exist so the "RPC unreachable" state can be tested; production uses the defaults.
export const RPC_PRIMARY = process.env.ARC_RPC_URL || "https://rpc.mainnet.arc.io";
export const RPC_FALLBACK = process.env.ARC_RPC_FALLBACK_URL || "https://rpc.drpc.mainnet.arc.io";

export const RPC_TIMEOUT_MS = 4_000;
export const RPC_MAX_RESPONSE_BYTES = 1_000_000;
export const LIVE_CACHE_MS = 15_000;

// The RPC refuses log queries wider than 10,000 blocks; 20 pages bounds a search at about 28 hours of Arc blocks.
export const LOG_PAGE_BLOCKS = 10_000n;
export const LOG_MAX_PAGES = 20;

// Past this, summing bill(id) reads is too heavy for one request and the total reads "unavailable" until log summing is built.
export const MAX_BILL_READS = 400;
export const BILL_READ_CHUNK = 25;

export const SECONDS_PER_YEAR = 31_536_000;
export const WAD = 10n ** 18n;
