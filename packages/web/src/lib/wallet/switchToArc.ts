import { numberToHex, type EIP1193Provider } from "viem";
import { arc } from "viem/chains";
import { ARC_RPC, ARC_RPC_FALLBACK } from "./config";

export const ARC_CHAIN_HEX = numberToHex(arc.id);

const ADD_ARC = {
  chainId: ARC_CHAIN_HEX,
  chainName: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: [ARC_RPC, ARC_RPC_FALLBACK],
  blockExplorerUrls: ["https://explorer.arc.io"],
};

type RpcError = { code?: number; message?: string; data?: { originalError?: { code?: number } } };

// MetaMask says 4902; its mobile app hides the same code one level down; some wallets only say it in words.
function isUnknownChain(error: unknown) {
  const e = error as RpcError | undefined;
  if (e?.code === 4902 || e?.data?.originalError?.code === 4902) return true;
  return /unrecognized chain|unknown chain|not been added|not added|chain .* not supported/i.test(e?.message ?? "");
}

export async function switchToArc(provider: EIP1193Provider) {
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_CHAIN_HEX }] });
  } catch (error) {
    if (!isUnknownChain(error)) throw error;
    await provider.request({ method: "wallet_addEthereumChain", params: [ADD_ARC] });
    // Most wallets switch as part of adding; asking again covers the ones that only add.
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: ARC_CHAIN_HEX }] });
  }
}
