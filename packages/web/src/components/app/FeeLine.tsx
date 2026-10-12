"use client";

import { useTranslations } from "next-intl";
import type { FeeFigures } from "@/lib/wallet/send";
import { Reading, Unavailable } from "./cells";
import { useFeeWords } from "./fee";

type FeeQuery = { isSuccess: boolean; isError: boolean; isFetching?: boolean; data?: FeeFigures };

// One line, one wording, everywhere a fee is quoted.
export function FeeLine({ query, idle, className = "" }: { query: FeeQuery; idle?: string; className?: string }) {
  const t = useTranslations("tx");
  const { feeSentence } = useFeeWords();
  let body: React.ReactNode;
  if (query.isSuccess && query.data) body = feeSentence(query.data);
  else if (query.isError) body = (
    <>
      {t("networkFee")} <Unavailable />
    </>
  );
  else if (query.isFetching) body = (
    <>
      {t("networkFee")} <Reading />
    </>
  );
  else body = idle ?? t("feeIdle");
  return (
    <p className={`type-body text-muted ${className}`} data-fee>
      {body}
    </p>
  );
}
