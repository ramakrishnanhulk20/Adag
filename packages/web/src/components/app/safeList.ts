"use client";

import { useQuery } from "@tanstack/react-query";
import { isAddress, type Address } from "viem";

// Ten minutes in this tab: every pay page asks, and the server allows 20 lookups per visitor in ten minutes.
const CACHE_MS = 10 * 60_000;
const cacheKey = (owner: Address) => `adag-safe-list:${owner.toLowerCase()}`;

function cached(owner: Address): string[] | null {
  try {
    const raw = window.sessionStorage.getItem(cacheKey(owner));
    if (!raw) return null;
    const v = JSON.parse(raw) as { at?: unknown; safes?: unknown };
    if (typeof v.at !== "number" || Date.now() - v.at > CACHE_MS || !Array.isArray(v.safes)) return null;
    return v.safes.filter((s): s is string => typeof s === "string" && isAddress(s, { strict: false }));
  } catch {
    return null;
  }
}

function remember(owner: Address, safes: string[]) {
  try {
    window.sessionStorage.setItem(cacheKey(owner), JSON.stringify({ at: Date.now(), safes }));
  } catch {
    // Private mode: the next page asks the server again, which only costs one lookup.
  }
}

// The Safes Safe's own service lists for this owner, through our server. A hint only: every Safe is checked on Arc
// before anything is signed, so a list up to ten minutes old can never cause a wrong payment. Shared by the pay-as
// switch and the Safe panel, so it is fetched once.
export function useSafeList(owner: Address | null) {
  return useQuery({
    queryKey: ["adag-safe-list", owner],
    enabled: Boolean(owner),
    retry: false,
    staleTime: CACHE_MS,
    queryFn: async () => {
      const hit = cached(owner!);
      if (hit) return hit;
      const res = await fetch(`/api/safe/list?owner=${owner}`, { signal: AbortSignal.timeout(15_000) });
      const body = (await res.json()) as { safes?: string[]; error?: string };
      if (!res.ok) throw new Error(body.error ?? "The Safe list is unavailable.");
      const safes = (body.safes ?? []).filter((s) => typeof s === "string" && isAddress(s, { strict: false }));
      remember(owner!, safes);
      return safes;
    },
  });
}
