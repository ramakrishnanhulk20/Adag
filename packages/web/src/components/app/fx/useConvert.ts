"use client";

import { keepPreviousData, useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import type { Currency } from "@/lib/pay/constants";
import type { CurrencySymbol } from "@/lib/fx/estimate";
import { publicArc } from "@/lib/wallet/send";
import { readBillConvert, readCloseConvert } from "./figures";

// Read when the screen opens and every 30 seconds after. Never asks Circle anything: the plan is requested only when
// the payer presses pay (C73). While a payment is in progress `enabled` is false, so the figures stop moving under it.
export function useBillConvert(a: { enabled: boolean; payer: Address | null; contract: string; billSymbol: CurrencySymbol; total: bigint; otherTotal: bigint }) {
  return useQuery({
    queryKey: ["adag-convert", a.contract, a.payer, a.billSymbol, a.total.toString(), a.otherTotal.toString()],
    enabled: a.enabled && a.payer !== null && a.total > 0n,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
    placeholderData: keepPreviousData,
    queryFn: () => readBillConvert(publicArc(), { payer: a.payer!, contract: a.contract, billSymbol: a.billSymbol, total: a.total, otherTotal: a.otherTotal }),
  });
}

export function useCloseConvert(a: { enabled: boolean; payer: Address; loan: Currency; approval: bigint }) {
  return useQuery({
    queryKey: ["adag-convert-close", a.payer, a.loan.marketId, a.approval.toString()],
    enabled: a.enabled && a.approval > 0n,
    refetchInterval: 30_000,
    staleTime: 15_000,
    retry: 1,
    placeholderData: keepPreviousData,
    queryFn: () => readCloseConvert(publicArc(), { payer: a.payer, loan: a.loan, approval: a.approval }),
  });
}
