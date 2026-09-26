"use client";

import { arc } from "viem/chains";
import { useReadContract } from "wagmi";
import { oracleAbi } from "@/lib/pay/abi";
import { USDC_MARKET_ORACLE } from "@/lib/pay/constants";
import { usdOfSats } from "@/lib/pay/format";

// The USDC market oracle's price of cirBTC, the source of every dollar estimate on the app screens. One read, shared
// by every component through the query cache.
export function useUsdPrice(): bigint | null {
  const price = useReadContract({
    chainId: arc.id,
    address: USDC_MARKET_ORACLE,
    abi: oracleAbi,
    functionName: "price",
    query: { refetchInterval: 60_000, staleTime: 30_000 },
  });
  return price.data ?? null;
}

// "0.00001098 cirBTC (about $0.92)" reads as money; the bare figure does not. Empty until the price arrives.
export function usdHint(sats: bigint, price: bigint | null): string {
  return price === null ? "" : ` (about ${usdOfSats(sats, price)}, estimated)`;
}
