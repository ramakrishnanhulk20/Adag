import { createConfig, fallback, http, injected } from "wagmi";
import { WagmiAdapter } from "@reown/appkit-adapter-wagmi";
import { arc } from "viem/chains";
import { RPC_MAX_RESPONSE_BYTES, RPC_TIMEOUT_MS } from "@/lib/arc/constants";

// The override exists for the end-to-end tests, which point a separate build at a local Arc fork. When it is set,
// it is the only endpoint, so a test can never fall through to mainnet.
const RPC_OVERRIDE = process.env.NEXT_PUBLIC_ARC_RPC_URL;
export const ARC_RPC = RPC_OVERRIDE || "https://rpc.mainnet.arc.io";
export const ARC_RPC_FALLBACK = RPC_OVERRIDE || "https://rpc.drpc.mainnet.arc.io";

const transportOptions = {
  timeout: RPC_TIMEOUT_MS,
  maxResponseBodySize: RPC_MAX_RESPONSE_BYTES,
  retryCount: 1,
  retryDelay: 150,
} as const;

const arcTransport = RPC_OVERRIDE
  ? // A fresh fork fetches mainnet state on first touch, which can take longer than the production timeout.
    http(RPC_OVERRIDE, { ...transportOptions, timeout: 30_000 })
  : fallback([http(ARC_RPC, transportOptions), http(ARC_RPC_FALLBACK, transportOptions)], { rank: false, retryCount: 0 });

// Reown's wallet modal needs a project id. Without one the app offers browser wallets alone, through a plain config.
export const projectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID || undefined;

// Handed to the wallet modal as well, so a wallet that adds Arc through it is told Adag's endpoints and not Reown's.
export const customRpcUrls = { "eip155:5042": [{ url: ARC_RPC }, { url: ARC_RPC_FALLBACK }] };

// No cookie storage and no headers() here: either would turn every page dynamic.
export const wagmiAdapter = projectId
  ? new WagmiAdapter({
      ssr: true,
      projectId,
      networks: [arc],
      customRpcUrls,
      transports: { [arc.id]: arcTransport },
    })
  : null;

// Arc mainnet is the only chain the app knows, so every read and every future signature is scoped to 5042 (C4).
export const wagmiConfig =
  wagmiAdapter?.wagmiConfig ??
  createConfig({
    chains: [arc],
    connectors: [injected({ shimDisconnect: true })],
    ssr: true,
    multiInjectedProviderDiscovery: true,
    transports: { [arc.id]: arcTransport },
  });

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
