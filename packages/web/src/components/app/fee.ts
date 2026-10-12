"use client";

import { useTranslations } from "next-intl";
import { usdc4, type FeeFigures } from "@/lib/wallet/send";

// The same words on every screen that quotes a fee. Both numbers come from one estimate (feeFigures): "about" is
// what it should cost, "keep up to" is what Arc sets aside first, the figure the pre-send check enforces.
export function useFeeWords() {
  const t = useTranslations("tx");
  const feeText = (wei: bigint) => t("about", { amount: usdc4(wei, "up") });
  const keepText = (wei: bigint) => t("keepAtLeast", { amount: usdc4(wei, "up") });
  const feeSentence = (f: FeeFigures) => t("feeSentence", { about: feeText(f.about), keep: keepText(f.keepUpTo) });
  return { feeText, keepText, feeSentence };
}
