import { createConfig, fallback, http, injected, type CreateConnectorFn } from "wagmi";
// The deep path, never "wagmi/connectors": the barrel drags in every optional wallet SDK and breaks the build.
import { walletConnect } from "wagmi/connectors/walletConnect";
import { arc } from "viem/chains";
import { RPC_MAX_RESPONSE_BYTES, RPC_TIMEOUT_MS } from "@/lib/arc/constants";

export const ARC_RPC = "https://rpc.mainnet.arc.io";
export const ARC_RPC_FALLBACK = "https://rpc.drpc.mainnet.arc.io";

const transportOptions = {
  timeout: RPC_TIMEOUT_MS,
  maxResponseBodySize: RPC_MAX_RESPONSE_BYTES,
  retryCount: 1,
  retryDelay: 150,
} as const;

// WalletConnect only exists when a project id is configured; without one the app offers browser wallets alone.
const wcProjectId = process.env.NEXT_PUBLIC_WC_PROJECT_ID;

const connectors: CreateConnectorFn[] = [injected({ shimDisconnect: true })];
if (wcProjectId) {
  connectors.push(
    walletConnect({
      projectId: wcProjectId,
      showQrModal: true,
      metadata: {
        name: "Adag",
        description: "Pay the bill. Keep the bitcoin.",
        url: "https://adag.app",
        icons: [],
      },
    }),
  );
}

// Arc mainnet is the only chain the app knows, so every read and every future signature is scoped to 5042 (C4).
export const wagmiConfig = createConfig({
  chains: [arc],
  connectors,
  ssr: true,
  multiInjectedProviderDiscovery: true,
  transports: {
    [arc.id]: fallback([http(ARC_RPC, transportOptions), http(ARC_RPC_FALLBACK, transportOptions)], { rank: false, retryCount: 0 }),
  },
});

declare module "wagmi" {
  interface Register {
    config: typeof wagmiConfig;
  }
}
