"use client";

import { useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import type { Address } from "viem";
import { BillStamp, type BillStatus } from "@/components/BillStamp";
import { Button } from "@/components/Button";
import { dateIn } from "@/i18n/dates";
import { localeOf } from "@/i18n/locales";
import type { Bill } from "@/lib/pay/build";
import { billHref, billKey } from "@/lib/pay/billId";
import { BILL_STATUS, CURRENCIES, deploymentOf } from "@/lib/pay/constants";
import { formatUnitsExact, referenceText, shortAddress } from "@/lib/pay/format";
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

// The first deployment's bills stay in the lists, marked, and link to their own page.
function FirstMark({ bill }: { bill: Bill }) {
  const tc = useTranslations("common");
  if (deploymentOf(bill.contract)?.label !== "first") return null;
  return (
    <span className="type-micro ml-2 rounded-[4px] border border-rule px-1.5 py-0.5 align-middle text-muted" title={tc("firstDeploymentAddress", { address: bill.contract })} data-first-deployment>
      {tc("firstDeployment")}
    </span>
  );
}

function CopyLink({ bill }: { bill: Bill }) {
  const t = useTranslations("wallet.lists");
  const tc = useTranslations("common");
  const id = bill.id;
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}${billHref(bill.contract, bill.id)}`);
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
      aria-label={t("copyLinkTo", { id: id.toString() })}
      className="type-micro shrink-0 rounded-[6px] border border-rule px-2.5 py-1.5 text-muted transition-colors duration-200 hover:border-gold hover:text-gold"
      data-action="copy-bill-link"
    >
      {copied ? tc("copied") : tc("copyLink")}
    </button>
  );
}

function Pager({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  const t = useTranslations("wallet.lists");
  if (pages <= 1) return null;
  return (
    <div className="mt-5 flex items-center justify-between gap-4">
      <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => onPage(page - 1)}>
        {t("newer")}
      </Button>
      <span className="type-micro text-muted">{t("pageOf", { page: String(page + 1), pages: String(pages) })}</span>
      <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => onPage(page + 1)}>
        {t("older")}
      </Button>
    </div>
  );
}

function ListState({ query, children }: { query: ReturnType<typeof useBillList>; children: React.ReactNode }) {
  const t = useTranslations("wallet.lists");
  const tc = useTranslations("common");
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
        {t("unavailable")}
        <button type="button" onClick={() => void query.refetch()} className="type-micro text-gold underline-offset-4 hover:underline" data-retry>
          {tc("tryAgain")}
        </button>
      </p>
    );
  return <>{children}</>;
}

export function BillsWritten({ address }: { address: Address }) {
  const t = useTranslations("wallet.lists");
  const tc = useTranslations("common");
  const locale = localeOf(useLocale());
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
            {t("wroteTitle")}
          </h2>
          <p className="type-body mt-2 text-muted">
            {query.data
              ? t("wroteSummary", {
                  total: query.data.total.toString(),
                  open: totals.length ? totals.map((x) => `${formatUnitsExact(x.sum, x.c.decimals)} ${x.c.symbol}`).join(t("and")) : t("nothing"),
                  across: open.length ? t("acrossBills", { count: open.length, n: String(open.length) }) : "",
                  capped: query.data.capped ? t("totalsCapped") : "",
                })
              : " "}
          </p>
        </div>
        <Button href="/bill/new" variant="primary" size="sm">
          {tc("writeABill")}
        </Button>
      </div>
      <ListState query={query}>
        {bills.length === 0 ? (
          <p className="type-body py-8 text-text">{t("noneWritten")}</p>
        ) : (
          <>
            <ul>
              {rows.map((b) => (
                <li key={billKey(b)} className="flex items-center gap-3 border-b border-rule" data-bill-row={b.id.toString()} data-contract={deploymentOf(b.contract)?.label} data-status={statusOf(b.status)}>
                  <Link href={billHref(b.contract, b.id)} className="group grid min-w-0 flex-1 grid-cols-[4.5rem_1fr_auto] items-center gap-x-4 gap-y-1 py-4 transition-colors duration-200 hover:bg-surface/60 md:grid-cols-[5rem_10rem_7rem_1fr_12rem] md:px-2">
                    <span className="font-display text-[1.5rem] leading-none text-text transition-colors duration-200 group-hover:text-gold">{tc("no", { id: b.id.toString() })}</span>
                    <span className="type-ui tabular-nums text-text">{money(b)}</span>
                    <span className="app-stamp-sm justify-self-end md:justify-self-start">
                      <BillStamp status={statusOf(b.status)} tilt={-4} />
                    </span>
                    <span className="type-body col-span-3 min-w-0 truncate text-muted md:col-span-1">
                      {b.ref !== "0x" ? <span className="app-reference">{referenceText(b.ref)}</span> : t("noReference")}
                      <FirstMark bill={b} />
                    </span>
                    <span className="type-micro col-span-3 normal-case tracking-[0.04em] text-muted md:col-span-1 md:text-right">
                      {b.status === BILL_STATUS.Paid
                        ? t("paidOnBy", { date: dateIn(locale, b.paidAt), payer: shortAddress(b.payer) })
                        : b.due === 0n
                          ? tc("noDueDate")
                          : t("dueOn", { date: dateIn(locale, b.due) })}
                    </span>
                  </Link>
                  <CopyLink bill={b} />
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
  const t = useTranslations("wallet.lists");
  const tc = useTranslations("common");
  const locale = localeOf(useLocale());
  const query = useBillList("paid", address);
  const [page, setPage] = useState(0);
  const bills = query.data?.bills ?? [];
  const pages = Math.max(1, Math.ceil(bills.length / LIST_PAGE));
  const rows = bills.slice(page * LIST_PAGE, (page + 1) * LIST_PAGE);

  return (
    <motion.section {...rise(1)} aria-labelledby="paid-title" data-list="paid">
      <div className="border-b border-rule pb-5">
        <h2 id="paid-title" className="type-h3 text-text">
          {t("paidTitle")}
        </h2>
        <p className="type-body mt-2 text-muted">{query.data ? t("paidSummary", { total: query.data.total.toString() }) : " "}</p>
      </div>
      <ListState query={query}>
        {bills.length === 0 ? (
          <div className="py-8">
            <p className="type-body text-text">{t("nonePaid")}</p>
            <Button href="/pay" variant="secondary" size="sm" className="mt-4">
              {tc("payABill")}
            </Button>
          </div>
        ) : (
          <>
            <ul>
              {rows.map((b) => (
                <li key={billKey(b)} className="border-b border-rule" data-bill-row={b.id.toString()} data-contract={deploymentOf(b.contract)?.label} data-status={statusOf(b.status)}>
                  <Link href={billHref(b.contract, b.id)} className="group grid grid-cols-[4.5rem_1fr_auto] items-center gap-x-4 py-4 transition-colors duration-200 hover:bg-surface/60 md:grid-cols-[5rem_1fr_auto] md:px-2">
                    <span className="font-display text-[1.5rem] leading-none text-text transition-colors duration-200 group-hover:text-gold">{tc("no", { id: b.id.toString() })}</span>
                    <span className="type-ui tabular-nums text-text">
                      {money(b)}
                      <FirstMark bill={b} />
                    </span>
                    <span className="type-micro text-right normal-case tracking-[0.04em] text-muted">
                      <span className="block sm:whitespace-nowrap">{t("to", { payee: shortAddress(b.payee) })}</span>
                      <span className="mt-1 block sm:whitespace-nowrap">{t("paidOn", { date: dateIn(locale, b.paidAt) })}</span>
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
