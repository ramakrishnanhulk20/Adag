// Plain TypeScript with relative imports only: scripts/check-batches.mjs runs this folder under bare Node.
import { isAddress, isAddressEqual, type Address, type Hex } from "viem";
import { ADAPTIVE_CURVE_IRM, CIRBTC, EURC, MARKET_EURC, MARKET_USDC, USDC, USDC_MARKET_LLTV, USDC_MARKET_ORACLE } from "../arc/constants";
import { adagAbi, adagFirstAbi } from "./abi";

export {
  ADAPTIVE_CURVE_IRM,
  CHAIN_ID,
  CIRBTC,
  EURC,
  EXPLORER,
  MARKET_EURC,
  MARKET_USDC,
  MORPHO,
  USDC,
  USDC_MARKET_LLTV,
  USDC_MARKET_ORACLE,
  WAD,
} from "../arc/constants";

// Two AdagBills deployments stay live (deployments/arc-mainnet.json). New bills are written only on the current one;
// bills on the first stay viewable and payable there. A bill is the pair (contract, id), never a bare number (C33).
export const ADAG_BILLS: Address = "0xaf6C47ae3e2ccD2Cd829Dd8a1DcCb7a7665c08cB";
export const ADAG_DEPLOY_BLOCK = 22_859_681n;
export const ADAG_BILLS_FIRST: Address = "0x6F2199e0A04e5e8ba67c89C467b6DF168b01137E";
export const ADAG_FIRST_DEPLOY_BLOCK = 22_727_688n;

export type Deployment = {
  address: Address;
  label: "current" | "first";
  abi: typeof adagAbi | typeof adagFirstAbi;
  deployBlock: bigint;
};

export const DEPLOYMENTS: readonly Deployment[] = [
  { address: ADAG_BILLS, label: "current", abi: adagAbi, deployBlock: ADAG_DEPLOY_BLOCK },
  { address: ADAG_BILLS_FIRST, label: "first", abi: adagFirstAbi, deployBlock: ADAG_FIRST_DEPLOY_BLOCK },
];

export function deploymentOf(contract: string): Deployment | null {
  if (typeof contract !== "string" || !isAddress(contract, { strict: false })) return null;
  return DEPLOYMENTS.find((d) => isAddressEqual(d.address, contract)) ?? null;
}

// Anything that is about to read, link or build for a bill runs its contract through this first.
export function requireDeployment(contract: string): Deployment {
  const d = deploymentOf(contract);
  if (!d) throw new Error(`Refusing ${String(contract)}: it is not one of Adag's AdagBills contracts.`);
  return d;
}

// ARCHITECTURE.md section 3. The only addresses a batch may target, together with the ones re-exported above (C3).
export const MEMO: Address = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
export const MULTICALL3_FROM: Address = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
export const EURC_MARKET_ORACLE: Address = "0x6945246777DfdF4744D957323857F797Ec19Ca1e";
export const EURC_MARKET_LLTV = 860000000000000000n;

// The other USDC/cirBTC market on Morpho, with a different oracle. It must never pass the market check.
export const OTHER_USDC_CIRBTC_MARKET: Hex = "0xabd1763943714b96b6590238d484a240019b4b842eb67fbcff7d96c081b7b566";

export const MAX_LTV_WAD = 400000000000000000n;
export const MAX_REFERENCE_BYTES = 140;
export const CIRBTC_DECIMALS = 8;
export const ORACLE_SCALE = 10n ** 36n;
export const MAX_UINT256 = 2n ** 256n - 1n;

// Plain numbers, not a TypeScript enum, so Node can run this file with its type stripping alone.
export const BILL_STATUS = { None: 0, Open: 1, Paid: 2, Void: 3 } as const;

export type MarketParams = {
  loanToken: Address;
  collateralToken: Address;
  oracle: Address;
  irm: Address;
  lltv: bigint;
};

export type Currency = {
  address: Address;
  symbol: "USDC" | "EURC";
  decimals: number;
  marketId: Hex;
  params: MarketParams;
};

export const CURRENCIES: readonly Currency[] = [
  {
    address: USDC,
    symbol: "USDC",
    decimals: 6,
    marketId: MARKET_USDC,
    params: { loanToken: USDC, collateralToken: CIRBTC, oracle: USDC_MARKET_ORACLE, irm: ADAPTIVE_CURVE_IRM, lltv: USDC_MARKET_LLTV },
  },
  {
    address: EURC,
    symbol: "EURC",
    decimals: 6,
    marketId: MARKET_EURC,
    params: { loanToken: EURC, collateralToken: CIRBTC, oracle: EURC_MARKET_ORACLE, irm: ADAPTIVE_CURVE_IRM, lltv: EURC_MARKET_LLTV },
  },
];
