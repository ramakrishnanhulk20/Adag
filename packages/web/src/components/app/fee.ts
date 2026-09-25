import { formatUnitsExact } from "@/lib/pay/format";

// Rounded up to four decimals: it is an estimate, and it should never read cheaper than it is.
export function feeText(wei: bigint): string {
  const step = 10n ** 14n;
  return `about ${formatUnitsExact(((wei + step - 1n) / step) * step, 18)} USDC`;
}
