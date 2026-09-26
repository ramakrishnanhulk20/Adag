// Names people know, for the chains a wallet is most likely to be on when it first reaches Adag.
const NAMES: Record<number, string> = {
  1: "Ethereum mainnet",
  10: "OP Mainnet",
  56: "BNB Smart Chain",
  137: "Polygon",
  8453: "Base",
  42161: "Arbitrum One",
  43114: "Avalanche",
  11155111: "the Sepolia testnet",
  5042002: "the Arc testnet",
};

export function networkName(chainId: number): string {
  return NAMES[chainId] ?? "another network";
}
