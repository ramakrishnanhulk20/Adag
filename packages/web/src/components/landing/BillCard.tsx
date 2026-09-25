"use client";

import { BillStamp, type BillStatus } from "@/components/BillStamp";
import { useLive } from "@/components/hero/LiveData";
import { formatAmount, formatDate, referenceText } from "@/lib/arc/present";
import type { LedgerBill } from "@/lib/arc/types";

export const STAMP: Record<LedgerBill["status"], BillStatus> = { 1: "open", 2: "paid", 3: "void" };

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

// The newest bill on Arc, exactly as AdagBills stores it. Nothing on this card is typed in by us.
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
        <p className="type-body text-muted">The latest bill is unavailable: Arc did not answer. Nothing is shown in its place.</p>
      </Frame>
    );
  }
  const bill = live.snapshot.latestBills.value.bills[0];
  if (!bill) {
    return (
      <Frame>
        <p className="type-body text-muted">No bill has been written on Arc yet.</p>
      </Frame>
    );
  }

  const reference = referenceText(bill.refHex);
  return (
    <Frame>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-4">
        <div>
          <p className="type-label text-gold">Bill #{bill.id}</p>
          <p className="type-number mt-3 whitespace-nowrap">{formatAmount(bill.amountBaseUnits, bill.currency)}</p>
        </div>
        <BillStamp status={STAMP[bill.status]} entrance="in-view" className="mt-1 shrink-0" />
      </div>
      <dl className="mt-7">
        <Row label="Pay to">
          <span className="type-address break-all text-text">{bill.payee}</span>
        </Row>
        <Row label="Reference">
          {reference ? <span className="type-body break-words text-text">{reference}</span> : <span className="type-body text-muted">None</span>}
        </Row>
        {bill.due > 0 && (
          <Row label="Due">
            <span className="type-body text-text">{formatDate(bill.due)}</span>
          </Row>
        )}
        <Row label={bill.status === 2 ? "Paid" : "Written"}>
          <span className="type-body text-text">{formatDate(bill.status === 2 ? bill.paidAt : bill.createdAt)}</span>
          {bill.tx ? (
            <a href={bill.tx.explorerUrl} target="_blank" rel="noopener noreferrer" className="link-draw type-label ml-4 text-gold">
              {bill.status === 2 ? "Payment on Arc" : "Bill on Arc"}
            </a>
          ) : (
            <span className="type-micro ml-4 text-muted">{bill.txNote === "unavailable" ? "Link unavailable" : "Transaction outside the search window"}</span>
          )}
        </Row>
      </dl>
    </Frame>
  );
}
