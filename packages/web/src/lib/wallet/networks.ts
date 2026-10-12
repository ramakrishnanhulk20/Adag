"use client";

import { useTranslations } from "next-intl";

// Chains a wallet is most likely to be on when it first reaches Adag, by the names people know. The catalog carries
// the names, because "the Sepolia testnet" and "a network it has not named yet" are sentences, not just labels.
const KNOWN: Record<number, string> = {
  1: "ethereum",
  10: "optimism",
  56: "bnb",
  137: "polygon",
  8453: "base",
  42161: "arbitrum",
  43114: "avalanche",
  11155111: "sepolia",
  5042002: "arcTestnet",
};

// An unnamed chain still shows its number, so a wallet that reports something unexpected can be told apart from Arc (5042).
export function useNetworkName(): (chainId: number) => string {
  const t = useTranslations("networks");
  return (chainId) => {
    if (!chainId) return t("unnamed");
    const key = KNOWN[chainId];
    return key ? t(key) : t("numbered", { id: String(chainId) });
  };
}
