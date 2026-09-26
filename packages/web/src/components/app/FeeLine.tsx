"use client";

import type { FeeFigures } from "@/lib/wallet/send";
import { Reading, Unavailable } from "./cells";
import { feeSentence } from "./fee";

type FeeQuery = { isSuccess: boolean; isError: boolean; isFetching?: boolean; data?: FeeFigures };

// One line, one wording, everywhere a fee is quoted.
export function FeeLine({ query, idle, className = "" }: { query: FeeQuery; idle?: string; className?: string }) {
  let body: React.ReactNode;
  if (query.isSuccess && query.data) body = feeSentence(query.data);
  else if (query.isError) body = (
    <>
      Network fee <Unavailable />
    </>
  );
  else if (query.isFetching) body = (
    <>
      Network fee <Reading />
    </>
  );
  else body = idle ?? "The network fee shows once everything above is ready.";
  return (
    <p className={`type-body text-muted ${className}`} data-fee>
      {body}
    </p>
  );
}
