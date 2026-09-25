import { createPublicClient, defineChain, fallback, http } from "viem";
import { CHAIN_ID, RPC_FALLBACK, RPC_MAX_RESPONSE_BYTES, RPC_PRIMARY, RPC_TIMEOUT_MS } from "./constants";

export const arc = defineChain({
  id: CHAIN_ID,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [RPC_PRIMARY] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

const transportOptions = {
  timeout: RPC_TIMEOUT_MS,
  maxResponseBodySize: RPC_MAX_RESPONSE_BYTES,
  // One retry per endpoint keeps the worst case near two timeouts before the fallback takes over.
  retryCount: 1,
  retryDelay: 150,
  batch: { batchSize: 50, wait: 8 },
} as const;

export const arcClient = createPublicClient({
  chain: arc,
  transport: fallback([http(RPC_PRIMARY, transportOptions), http(RPC_FALLBACK, transportOptions)], { rank: false, retryCount: 0 }),
});
