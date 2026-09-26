"use client";

import Link from "next/link";
import { BillStamp } from "@/components/BillStamp";
import { useLive } from "@/components/hero/LiveData";
import { formatAmount, formatDate } from "@/lib/arc/present";
import { billHref } from "@/lib/pay/billId";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 border-t border-rule py-4 sm:grid-cols-[8.5rem_1fr] sm:gap-4">
      <dt className="type-label text-muted">{label}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return <div className="relative border border-rule-strong bg-raised px-6 py-7 md:px-9 md:py-9">{children}</div>;
}

// The newest payment on Arc, from its own BillPaid event. The invoice reference is not shown here: anyone can write
// one, and the home page never carries a stranger's words (security pass 1, M2). The bill's own page shows it.
export function BillCard() {
  const live = useLive();

  if (live.status === "loading") {
    return (
      <Frame>
        <div className="flex min-h-72 flex-col justify-center gap-3" aria-label="Reading Arc">
          <span aria-hidden="true" className="live-shimmer block h-px w-2/3" />
          {live.slow && <span className="type-micro text-muted">Reading Arc</span>}
        </div>
      </Frame>
    );
  }
  if (live.status === "failed" || !live.snapshot.latestBills.ok) {
    return (
      <Frame>
        <p className="type-body text-muted">The latest payment is unavailable: Arc did not answer. Nothing is shown in its place.</p>
      </Frame>
    );
  }
  const entry = live.snapshot.latestBills.value.bills[0];
  if (!entry) {
    return (
      <Frame>
        <p className="type-body text-muted">No bill has been paid on Arc yet.</p>
      </Frame>
    );
  }

  let href: string | null = null;
  try {
    href = billHref(entry.contract, BigInt(entry.id));
  } catch {
    href = null;
  }
  return (
    <Frame>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div>
          <p className="type-label text-gold">
            Bill #{entry.id}
            {entry.first ? <span className="ml-3 text-muted">First deployment</span> : null}
          </p>
          <p className="type-number mt-3 whitespace-nowrap">{formatAmount(entry.amountBaseUnits, entry.currency)}</p>
        </div>
        <BillStamp status="paid" entrance="in-view" className="mt-1 shrink-0" />
      </div>
      <dl className="mt-7">
        <Row label="Paid to">
          <span className="type-address break-all text-text">{entry.payee}</span>
        </Row>
        <Row label="Paid by">
          <span className="type-address break-all text-text">{entry.payer}</span>
        </Row>
        <Row label="Paid">
          <span className="type-body text-text">{formatDate(entry.paidAt)}</span>
          <a href={entry.explorerUrl} target="_blank" rel="noopener noreferrer" className="link-draw type-label ml-4 text-gold">
            Payment on Arc
          </a>
        </Row>
        {href && (
          <Row label="The bill">
            <Link href={href} className="link-draw type-label text-gold">
              Open it, with its invoice reference
            </Link>
          </Row>
        )}
      </dl>
    </Frame>
  );
}
