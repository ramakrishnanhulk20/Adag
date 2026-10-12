"use client";

import { useCallback } from "react";
import { useTranslations } from "next-intl";
import { translateLibText } from "./libText";

// The screens' way to show a sentence lib/ wrote: translated when the table knows it, English otherwise.
export function useLibText(): (text: string) => string {
  const t = useTranslations("lib");
  return useCallback((text: string) => translateLibText(t as unknown as (key: string, values?: Record<string, string | number>) => string, text), [t]);
}
