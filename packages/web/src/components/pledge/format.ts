import type { Currency } from "@/lib/arc/pledge";

function units(value: string, decimals: number): { whole: string; frac: string } {
  const big = BigInt(value);
  const scale = 10n ** BigInt(decimals);
  return { whole: (big / scale).toString(), frac: (big % scale).toString().padStart(decimals, "0") };
}

const group = (whole: string) => whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",");

export function formatBtc(sat: string): string {
  const { whole, frac } = units(sat, 8);
  return `${group(whole)}.${frac}`;
}

export function formatToken(baseUnits: string, currency: Currency): string {
  const { whole, frac } = units(baseUnits, 6);
  return `${group(whole)}.${frac.slice(0, 2)} ${currency}`;
}

export function formatUsd(baseUnits: string, cents = true): string {
  const { whole, frac } = units(baseUnits, 6);
  return cents ? `$${group(whole)}.${frac.slice(0, 2)}` : `$${group(whole)}`;
}

export function formatPercentWad(wad: string, digits = 1): string {
  const pct = Number((BigInt(wad) * 1_000_000n) / 10n ** 16n) / 1_000_000;
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(digits)}%`;
}

export const wadRatio = (wad: string) => Number((BigInt(wad) * 1_000_000n) / 10n ** 18n) / 1_000_000;

const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export const formatDate = (seconds: number) => (seconds > 0 ? DATE.format(new Date(seconds * 1000)).toUpperCase() : "NO DATE");

export const shortHash = (hash: string) => `${hash.slice(0, 6)}...${hash.slice(-4)}`;

const WORDS = ["No", "One", "Two", "Three"];
export const countWord = (n: number) => WORDS[n] ?? String(n);
