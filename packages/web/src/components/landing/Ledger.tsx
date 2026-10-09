"use client";

import Link from "next/link";
import { motion } from "motion/react";
import { BillStamp } from "@/components/BillStamp";
import { Hallmark } from "@/components/Hallmark";
import { useLive } from "@/components/hero/LiveData";
import { formatAmount, formatDate } from "@/lib/arc/present";
import type { PaidEntry } from "@/lib/arc/types";
import { billHref } from "@/lib/pay/billId";
import { Reveal } from "./Reveal";

const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

// The link is rebuilt from the entry's own contract and id, and billHref refuses any contract that is not Adag's.
function hrefOf(entry: PaidEntry): string | null {
  try {
    return billHref(entry.contract, BigInt(entry.id));
  } catch {
    return null;
  }
}

function Row({ entry, index }: { entry: PaidEntry; index: number }) {
  const href = hrefOf(entry);
  return (
    <motion.li
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.5 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1], delay: index * 0.06 }}
      data-ledger-row={`${entry.first ? "first" : "current"}:${entry.id}`}
      className="grid grid-cols-[auto_1fr] items-center gap-x-6 gap-y-3 border-t border-rule py-6 transition-colors duration-200 hover:border-gold lg:grid-cols-[7rem_12rem_1fr_8rem_10rem]"
    >
      <span className="flex flex-col items-start gap-1.5">
        {href ? (
          <Link href={href} className="link-draw tap-target type-label text-gold">
            Bill #{entry.id}
          </Link>
        ) : (
          <span className="type-label text-gold">Bill #{entry.id}</span>
        )}
        {entry.first && <span className="type-micro text-muted">First deployment</span>}
      </span>
      <span className="type-h4">{formatAmount(entry.amountBaseUnits, entry.currency)}</span>
      <span className="col-span-2 flex min-w-0 flex-col gap-1 lg:col-span-1">
        <span className="type-address text-text">
          <span className="text-muted">from </span>
          {short(entry.payer)}
          <span className="text-muted"> to </span>
          {short(entry.payee)}
        </span>
        <span className="type-micro text-muted">
          {formatDate(entry.paidAt)}
          {entry.loanChecked ? " · from a loan, 40% check ran" : null}
        </span>
      </span>
      <span className="origin-left scale-[0.8]">
        <BillStamp status="paid" entrance="in-view" />
      </span>
      <span className="lg:text-right">
        <a href={entry.explorerUrl} target="_blank" rel="noopener noreferrer" className="link-draw tap-target type-label text-gold">
          Payment on Arc
        </a>
      </span>
    </motion.li>
  );
}

// Section 7: the newest payments on Arc, from each contract's own BillPaid event. Only paid bills appear, and never
// a bill's reference, so nobody can write words onto this page or crowd it out with junk bills (security pass 1, M2).
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
    body = <p className="type-body border-t border-rule py-8 text-muted">No bill has been paid on Arc yet.</p>;
  } else {
    body = (
      <ol>
        {live.snapshot.latestBills.value.bills.map((entry, i) => (
          <Row key={`${entry.contract}:${entry.id}`} entry={entry} index={i} />
        ))}
      </ol>
    );
  }

  const paid = live.status === "ready" && live.snapshot.paid.ok ? live.snapshot.paid.value : null;
  const shown = live.status === "ready" && live.snapshot.latestBills.ok ? live.snapshot.latestBills.value : null;

  return (
    <section aria-labelledby="ledger-title" className="landing-section border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <Reveal>
        <Hallmark>08 · The ledger</Hallmark>
      </Reveal>
      <Reveal delay={0.08}>
        <h2 id="ledger-title" className="type-h2 mt-8 max-w-[14ch]">
          Every payment, <em className="text-gold italic">on the record.</em>
        </h2>
      </Reveal>
      <div className="mt-14 border-b border-rule">{body}</div>
      <p className="type-micro mt-6 max-w-[70ch] text-muted">
        The newest payments through Adag on Arc, read from each contract&apos;s own payment record. Invoice references stay on each bill&apos;s own
        page. Nothing here is a mock.
        {shown && shown.billsPaid > shown.bills.length ? ` Showing the latest ${shown.bills.length} of ${shown.billsPaid} paid.` : null}
        {paid?.note ? ` ${paid.note}` : null}
      </p>
    </section>
  );
}
