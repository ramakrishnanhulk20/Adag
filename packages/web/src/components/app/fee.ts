import { usdc4, type FeeFigures } from "@/lib/wallet/send";

// The same words on every screen that quotes a fee. Both numbers come from one estimate (feeFigures): "about" is
// what it should cost, "keep up to" is what Arc sets aside first, the figure the pre-send check enforces.
export function feeText(wei: bigint): string {
  return `about ${usdc4(wei, "up")} USDC`;
}

export function keepText(wei: bigint): string {
  return `keep up to ${usdc4(wei, "up")} USDC available`;
}

export function feeSentence(f: FeeFigures): string {
  return `Network fee ${feeText(f.about)}; ${keepText(f.keepUpTo)}. Arc sets aside the most it could cost and refunds the rest.`;
}
