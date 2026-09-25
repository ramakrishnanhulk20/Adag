"use client";

import { motion } from "motion/react";
import { BillStamp } from "@/components/BillStamp";
import { Hallmark } from "@/components/Hallmark";
import { useLive } from "@/components/hero/LiveData";
import { formatAmount, formatDate, referenceText } from "@/lib/arc/present";
import { STAMP } from "./BillCard";
import { Reveal } from "./Reveal";

// Section 7: the bills on Arc, newest first, as many as exist. No padding rows: one real bill shows as one row.
export function Ledger() {
  const live = useLive();

  let body: React.ReactNode;
  if (live.status === "loading") {
    body = (
      <div className="flex flex-col gap-3 border-t border-rule py-8" aria-label="Reading Arc">
        <span aria-hidden="true" className="live-shimmer block h-px w-full" />
        {live.slow && <span className="type-micro text-muted">Reading Arc</span>}
      </div>
    );
  } else if (live.status === "failed" || !live.snapshot.latestBills.ok) {
    body = <p className="type-body border-t border-rule py-8 text-muted">The ledger is unavailable: Arc did not answer.</p>;
  } else if (live.snapshot.latestBills.value.bills.length === 0) {
    body = <p className="type-body border-t border-rule py-8 text-muted">No bill has been written on Arc yet.</p>;
  } else {
    body = (
      <ol>
        {live.snapshot.latestBills.value.bills.map((bill, i) => {
          const reference = referenceText(bill.refHex);
          return (
            <motion.li
              key={bill.id}
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.5 }}
              transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: i * 0.06 }}
              className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 border-t border-rule py-6 transition-colors duration-200 hover:border-gold md:grid-cols-[5rem_12rem_1fr_9rem_10rem]"
            >
              <span className="type-label text-gold">#{bill.id}</span>
              <span className="type-h4 md:order-none">{formatAmount(bill.amountBaseUnits, bill.currency)}</span>
              <span className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-1">
                <span className="type-address break-all text-text">{bill.payee}</span>
                <span className="type-micro text-muted">
                  {reference ? <span className="normal-case tracking-normal">{reference}</span> : "No reference"} · {formatDate(bill.status === 2 ? bill.paidAt : bill.createdAt)}
                </span>
              </span>
              <span className="origin-left scale-[0.8]">
                <BillStamp status={STAMP[bill.status]} entrance="in-view" />
              </span>
              <span className="md:text-right">
                {bill.tx ? (
                  <a href={bill.tx.explorerUrl} target="_blank" rel="noopener noreferrer" className="link-draw type-label text-gold">
                    {bill.txKind === "paid" ? "Payment on Arc" : "Bill on Arc"}
                  </a>
                ) : (
                  <span className="type-micro text-muted">{bill.txNote === "unavailable" ? "Link unavailable" : "Not found in range"}</span>
                )}
              </span>
            </motion.li>
          );
        })}
      </ol>
    );
  }

  return (
    <section aria-labelledby="ledger-title" className="landing-section border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <Reveal>
        <Hallmark>07 · The ledger</Hallmark>
      </Reveal>
      <Reveal delay={0.08}>
        <h2 id="ledger-title" className="type-h2 mt-8 max-w-[14ch]">
          Every bill, <em className="text-gold italic">on the record.</em>
        </h2>
      </Reveal>
      <div className="mt-14 border-b border-rule">{body}</div>
      <p className="type-micro mt-6 text-muted">
        Every bill on Arc, newest first. Nothing here is a mock.
        {live.status === "ready" && live.snapshot.latestBills.ok && live.snapshot.latestBills.value.billCount > live.snapshot.latestBills.value.bills.length
          ? ` Showing the latest ${live.snapshot.latestBills.value.bills.length} of ${live.snapshot.latestBills.value.billCount}.`
          : null}
      </p>
    </section>
  );
}
