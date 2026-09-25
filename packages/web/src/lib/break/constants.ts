import { getAddress, keccak256, stringToHex, type Address } from "viem";

// Every address here is fixed at build time and copied from ARCHITECTURE.md section 3 or
// packages/contracts/prove-it; nothing read from an RPC ever replaces one (C18).
export const MEMO: Address = "0x5294E9927c3306DcBaDb03fe70b92e01cCede505";
export const MULTICALL3_FROM: Address = "0x522fAf9A91c41c443c66765030741e4AaCe147D0";
export const WETH: Address = "0x128cC466B61f542da60c70e3aA11c10e19B84EDB";

// The public demo wallets from the live proof (packages/contracts/deployments/prove-it-2026-09-25.md).
export const DEMO_PAYER: Address = "0x6e26Dd347b57ba591Ee34292A2d828CCC17A1fDE";
export const DEMO_PAYEE: Address = "0xc95DE79125A9D7fCfE17f35C7Dbe0e88725Ad93B";

// Derived exactly as attack.mjs derives them, so the page and the script attack with the same stranger.
export const STRANGER: Address = getAddress(`0x${keccak256(stringToHex("adag attack stranger")).slice(-40)}`);
export const RANDOM_TOKEN: Address = getAddress(`0x${keccak256(stringToHex("adag attack random token")).slice(-40)}`);

// Circle's RPC does not serve eth_simulateV1, so the suite simulates on dRPC's public endpoint, as attack.mjs does.
export const SIM_RPC = "https://rpc.drpc.mainnet.arc.io";
export const SIM_SPACING_MS = 1_500;
export const RATE_LIMIT_WAIT_MS = 5_000;
export const SIM_TIMEOUT_MS = 30_000;
export const SIM_MAX_RESPONSE_CHARS = 2_000_000;

export const RUN_CACHE_MS = 60_000;
export const BILL_AMOUNT = 100_000n;

// Set this when the repository is public; until then the page names the files as plain text.
export const REPO_URL: string | null = null;
export const ATTACK_SCRIPT_PATH = "packages/contracts/prove-it/attack.mjs";
export const THREAT_MODEL_PATH = "docs/security/threat-model.md";

// Runtime code of the R&D MockOracle (reference/rnd/option-a/MockOracle.json), used by A9 alone. Its three
// sentinels are patched with a fixed price and the real oracle's feeds before it is placed in the simulation.
export const MOCK_ORACLE_CODE =
  "0x6080604052348015600e575f5ffd5b5060043610603a575f3560e01c806356095e1114603e578063a035b1fe146071578063f50a471814609e575b5f5ffd5b73c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c05b6040516001600160a01b0390911681526020015b60405180910390f35b6040517f5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed5eed81526020016068565b73b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0605456fea26469706673582212201fec25d6656a12d436ad0fdc9b8c2cd0337a54d28d81ce2932aef82e564bb67164736f6c634300081e0033";
