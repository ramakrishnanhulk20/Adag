"use client";

import { useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { BillStamp, type BillStatus } from "@/components/BillStamp";
import { Button } from "@/components/Button";
import type { Bill } from "@/lib/pay/build";
import { BILL_STATUS, CURRENCIES } from "@/lib/pay/constants";
import { formatDate, formatUnitsExact, referenceText, shortAddress } from "@/lib/pay/format";
import { LIST_PAGE, readBillList } from "@/lib/pay/lists";
import { currencyOf } from "@/lib/pay/market";
import { publicArc } from "@/lib/wallet/send";
import { Reading, rise } from "./cells";

const statusOf = (s: number): BillStatus => (s === BILL_STATUS.Paid ? "paid" : s === BILL_STATUS.Void ? "void" : "open");
const money = (b: Bill) => {
  const c = currencyOf(b.currency);
  return c ? `${formatUnitsExact(b.amount, c.decimals)} ${c.symbol}` : b.amount.toString();
};

export function useBillList(kind: "wrote" | "paid", address: Address) {
  return useQuery({
    queryKey: ["adag-bill-list", kind, address],
    queryFn: () => readBillList(publicArc(), kind, address),
    staleTime: 15_000,
    retry: 1,
    // A supplier learns a bill was paid by the list changing on its own: every 20 seconds, and on coming back to the tab.
    refetchInterval: 20_000,
    refetchOnWindowFocus: true,
  });
}

function CopyLink({ id }: { id: bigint }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/bill/${id}`);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={`Copy the link to bill ${id}`}
      className="type-micro shrink-0 rounded-[6px] border border-rule px-2.5 py-1.5 text-muted transition-colors duration-200 hover:border-gold hover:text-gold"
      data-action="copy-bill-link"
    >
      {copied ? "Copied" : "Copy link"}
    </button>
  );
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="mt-5 flex items-center justify-between gap-4">
      <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
        Newer
      </Button>
      <span className="type-micro text-muted">
        Page {page + 1} of {pages}
      </span>
      <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        Older
      </Button>
    </div>
  );
}

function ListState({ query, children }: { query: ReturnType<typeof useBillList>; children: React.ReactNode }) {
  if (query.isPending)
    return (
      <div className="py-6">
        <Reading />
      </div>
    );
  // C19: a failed list says so; it never shows as "no bills".
  if (query.isError)
    return (
      <p className="type-body flex flex-wrap items-baseline gap-x-3 py-6 text-muted">
        This list is unavailable right now: Arc did not answer.
        <button type="button" onClick={() => void query.refetch()} className="type-micro text-gold underline-offset-4 hover:underline" data-retry>
          Try again
        </button>
      </p>
    );
  return <>{children}</>;
}

export function BillsWritten({ address }: { address: Address }) {
  const query = useBillList("wrote", address);
  const [page, setPage] = useState(0);
  const bills = query.data?.bills ?? [];
  const pages = Math.max(1, Math.ceil(bills.length / LIST_PAGE));
  const rows = bills.slice(page * LIST_PAGE, (page + 1) * LIST_PAGE);
  const open = bills.filter((b) => b.status === BILL_STATUS.Open);
  const totals = CURRENCIES.map((c) => ({ c, sum: open.filter((b) => b.currency.toLowerCase() === c.address.toLowerCase()).reduce((s, b) => s + b.amount, 0n) })).filter((t) => t.sum > 0n);

  return (
    <motion.section {...rise(0)} aria-labelledby="wrote-title" data-list="wrote">
      <div className="flex flex-wrap items-end justify-between gap-4 border-b border-rule pb-5">
        <div>
          <h2 id="wrote-title" className="type-h3 text-text">
            Bills you wrote
          </h2>
          <p className="type-body mt-2 text-muted">
            {query.data
              ? `${query.data.total} written. Open: ${totals.length ? totals.map((t) => `${formatUnitsExact(t.sum, t.c.decimals)} ${t.c.symbol}`).join(" and ") : "nothing"}${open.length ? ` across ${open.length} bill${open.length === 1 ? "" : "s"}` : ""}.${query.data.capped ? " Totals cover the newest 1,000." : ""}`
              : " "}
          </p>
        </div>
        <Button href="/bill/new" variant="primary" size="sm">
          Write a bill
        </Button>
      </div>
      <ListState query={query}>
        {bills.length === 0 ? (
          <p className="type-body py-8 text-text">No bills yet. Write your first one: it takes one signature, and you send the link.</p>
        ) : (
          <>
            <ul>
              {rows.map((b) => (
                <li key={b.id.toString()} className="flex items-center gap-3 border-b border-rule" data-bill-row={b.id.toString()} data-status={statusOf(b.status)}>
                  <Link href={`/bill/${b.id}`} className="group grid min-w-0 flex-1 grid-cols-[4.5rem_1fr_auto] items-center gap-x-4 gap-y-1 py-4 transition-colors duration-200 hover:bg-surface/60 md:grid-cols-[5rem_10rem_7rem_1fr_12rem] md:px-2">
                    <span className="font-display text-[1.5rem] leading-none text-text transition-colors duration-200 group-hover:text-gold">No. {b.id.toString()}</span>
                    <span className="type-ui tabular-nums text-text">{money(b)}</span>
                    <span className="app-stamp-sm justify-self-end md:justify-self-start">
                      <BillStamp status={statusOf(b.status)} tilt={-4} />
                    </span>
                    <span className="type-body col-span-3 min-w-0 truncate text-muted md:col-span-1">
                      {b.ref !== "0x" ? <span className="app-reference">{referenceText(b.ref)}</span> : "No reference"}
                    </span>
                    <span className="type-micro col-span-3 normal-case tracking-[0.04em] text-muted md:col-span-1 md:text-right">
                      {b.status === BILL_STATUS.Paid ? `Paid ${formatDate(b.paidAt)} by ${shortAddress(b.payer)}` : b.due === 0n ? "No due date" : `Due ${formatDate(b.due)}`}
                    </span>
                  </Link>
                  <CopyLink id={b.id} />
                </li>
              ))}
            </ul>
            <Pager page={page} pages={pages} onPage={setPage} />
          </>
        )}
      </ListState>
    </motion.section>
  );
}

export function BillsPaid({ address }: { address: Address }) {
  const query = useBillList("paid", address);
  const [page, setPage] = useState(0);
  const bills = query.data?.bills ?? [];
  const pages = Math.max(1, Math.ceil(bills.length / LIST_PAGE));
  const rows = bills.slice(page * LIST_PAGE, (page + 1) * LIST_PAGE);

  return (
    <motion.section {...rise(1)} aria-labelledby="paid-title" data-list="paid">
      <div className="border-b border-rule pb-5">
        <h2 id="paid-title" className="type-h3 text-text">
          Bills you paid
        </h2>
        <p className="type-body mt-2 text-muted">{query.data ? `${query.data.total} paid through Adag.` : " "}</p>
      </div>
      <ListState query={query}>
        {bills.length === 0 ? (
          <div className="py-8">
            <p className="type-body text-text">You have not paid a bill through Adag yet. Open one from its link, or find it by number.</p>
            <Button href="/pay" variant="secondary" size="sm" className="mt-4">
              Pay a bill
            </Button>
          </div>
        ) : (
          <>
            <ul>
              {rows.map((b) => (
                <li key={b.id.toString()} className="border-b border-rule" data-bill-row={b.id.toString()} data-status={statusOf(b.status)}>
                  <Link href={`/bill/${b.id}`} className="group grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-4 py-4 transition-colors duration-200 hover:bg-surface/60 md:grid-cols-[5rem_1fr_auto] md:px-2">
                    <span className="font-display text-[1.5rem] leading-none text-text transition-colors duration-200 group-hover:text-gold">No. {b.id.toString()}</span>
                    <span className="type-ui tabular-nums text-text">{money(b)}</span>
                    <span className="type-micro text-right normal-case tracking-[0.04em] text-muted">
                      <span className="block whitespace-nowrap">To {shortAddress(b.payee)}</span>
                      <span className="mt-1 block whitespace-nowrap">Paid {formatDate(b.paidAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            <Pager page={page} pages={pages} onPage={setPage} />
          </>
        )}
      </ListState>
    </motion.section>
  );
}
