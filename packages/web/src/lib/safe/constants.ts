// Plain TypeScript with relative imports only: lib/pay/build.ts imports this, and scripts run that under bare Node.
import type { Address } from "viem";

// Safe v1.4.1 canonical deployments on Arc (safe-deployments assets/v1.4.1, "5042": "canonical"), each checked for
// code on Arc mainnet when this was written: 410, 850, 3,054, 23,579, 24,421 and 5,637 bytes.
export const MULTISEND_CALL_ONLY: Address = "0x9641d764fc13c8B624c04430C7356C1C7C8102e2";
export const SIMULATE_TX_ACCESSOR: Address = "0x3d4BA2E0884aa488718476ca2FB8Efc291A46199";
export const SAFE_PROXY_FACTORY: Address = "0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67";
export const SAFE_SINGLETON: Address = "0x41675C099F32341bf84BFc5382aF534df5C7461a";
export const SAFE_L2_SINGLETON: Address = "0x29fcB43b46531BcA003ddC8FCB67FFE91900C762";
export const SAFE_FALLBACK_HANDLER: Address = "0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99";

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

// C52: the oldest Safe whose EIP-712 domain carries the chain id, so a signature cannot be replayed on another chain.
export const MIN_SAFE_VERSION = [1, 3, 0] as const;

export const SAFE_APP_URL = "https://app.safe.global";
