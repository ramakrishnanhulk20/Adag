import type { CSSProperties } from "react";
import { BillStamp, type BillStatus } from "@/components/BillStamp";
import { Hallmark } from "@/components/Hallmark";
import type { Bill } from "@/lib/pay/build";
import { BILL_STATUS, EXPLORER } from "@/lib/pay/constants";
import { formatDate, formatDateTime, formatUnitsExact, fullAddress, referenceText, shortAddress } from "@/lib/pay/format";
import { currencyOf } from "@/lib/pay/market";
import type { PaidTx } from "@/lib/pay/read";
import { Parallax } from "./Parallax";

const d = (n: number) => ({ "--d": n }) as CSSProperties;

function statusOf(status: number): BillStatus {
  return status === BILL_STATUS.Paid ? "paid" : status === BILL_STATUS.Void ? "void" : "open";
}

const HEADLINE: Record<BillStatus, string> = { open: "Amount due", paid: "Amount paid", void: "Cancelled amount" };

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="app-ledger-row">
      <dt className="type-micro text-muted">{label}</dt>
      <dd className="type-body min-w-0 text-text">{children}</dd>
    </div>
  );
}

function ExternalLink({ href, children, className = "" }: { href: string; children: React.ReactNode; className?: string }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className={`link-draw transition-colors duration-200 hover:text-gold ${className}`}>
      {children}
    </a>
  );
}

// Everything on this sheet is decoded from bill(id), the same record pay() reads (C15). Status comes only from that
// record; the transaction link only from Adag's own BillPaid log (C16).
export function BillSheet({ bill, paidTx }: { bill: Bill; paidTx: PaidTx }) {
  const status = statusOf(bill.status);
  const currency = currencyOf(bill.currency);
  const payee = fullAddress(bill.payee);
  const reference = referenceText(bill.ref);
  const amount = currency ? formatUnitsExact(bill.amount, currency.decimals) : bill.amount.toString();

  return (
    <section className="relative px-5 pt-10 pb-14 md:px-[6vw] md:pt-[9vh] md:pb-20" aria-labelledby="bill-title">
      <Parallax distance={-140} className="pointer-events-none absolute -z-10 right-[4vw] top-[5vh] invisible md:visible">
        <div aria-hidden="true" className="app-watermark text-[clamp(11rem,24vw,26rem)]">
          <span className="app-watermark-sign">№</span>
          {bill.id.toString().length > 6 ? `${bill.id.toString().slice(0, 6)}…` : bill.id.toString()}
        </div>
      </Parallax>

      <div className="grid gap-12 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-7">
          <div className="app-rise" style={d(0)}>
            <Hallmark>Bill No. {bill.id.toString()} · Arc mainnet</Hallmark>
          </div>
          <h1 id="bill-title" className="sr-only">
            Bill number {bill.id.toString()}: {amount} {currency?.symbol ?? ""}, status {status}
          </h1>

          <p className="type-label app-rise mt-10 text-muted md:mt-14" style={d(1)}>
            {HEADLINE[status]}
          </p>
          {/* The stamp sits clear of the figures so the currency always reads. It wraps below on narrow screens. */}
          <div className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-5">
            <p className="app-amount app-rise text-text" style={d(2)}>
              {amount}
              <span className="app-amount-unit">{currency?.symbol ?? "unknown token"}</span>
            </p>
            <div className="app-stamp relative z-10 mb-[0.4rem] md:mb-[1.6rem]">
              {/* Keyed by status, so after a payment or a void the refreshed page stamps the new state down with a spring. */}
              <BillStamp key={status} status={status} entrance="in-view" tilt={status === "paid" ? -9 : status === "void" ? -11 : -6} />
            </div>
          </div>

          <div className="app-rise mt-10 md:mt-14" style={d(3)}>
            <p className="type-label text-muted">Pays</p>
            <p className="type-address mt-3 break-all text-[0.9375rem] text-text md:text-[1.1875rem]">{payee}</p>
            <ExternalLink href={`${EXPLORER}/address/${payee}`} className="type-micro mt-3 inline-block text-muted">
              This address on the Arc explorer
            </ExternalLink>
          </div>

          <p className="type-lead app-rise mt-10 max-w-[38rem] text-text/88" style={d(4)}>
            {status === "open" && "Open. Anyone can pay it, once. Until then the supplier who wrote it can still cancel it."}
            {status === "paid" && "Paid in full on Arc. The supplier's balance rose by exactly this amount in the same transaction."}
            {status === "void" && (
              <span className="text-danger">The supplier cancelled this bill. It can never be paid.</span>
            )}
          </p>
        </div>

        <aside className="app-rise md:col-span-5 md:pt-[clamp(15rem,23vw,22rem)]" style={d(5)} aria-label="Bill details">
          <dl className="app-ledger border-y border-rule">
            <Row label="Due">{bill.due === 0n ? "No due date" : formatDate(bill.due)}</Row>
            <Row label="Written">{formatDateTime(bill.createdAt)}</Row>
            <Row label="Reference">
              {reference ? <span className="app-reference">{reference}</span> : <span className="text-muted">None</span>}
            </Row>
            <Row label="Currency">
              <span className="block">{currency?.symbol ?? "Unknown token"}</span>
              <span className="type-address mt-1 block break-all text-muted">{fullAddress(bill.currency)}</span>
            </Row>
            {status === "paid" && (
              <>
                <Row label="Paid by">
                  <span className="type-address block break-all text-[0.875rem]">{fullAddress(bill.payer)}</span>
                </Row>
                <Row label="Paid on">{formatDateTime(bill.paidAt)}</Row>
                <Row label="Transaction">
                  {paidTx.kind === "found" ? (
                    <ExternalLink href={paidTx.url} className="type-address text-[0.875rem] text-text">
                      {shortAddress(paidTx.txHash)} on the explorer
                    </ExternalLink>
                  ) : paidTx.kind === "unavailable" ? (
                    <span className="text-muted">Unavailable right now. The bill is still paid: that comes from Adag&apos;s own record.</span>
                  ) : (
                    <span className="text-muted">Not found in Adag&apos;s payment log yet.</span>
                  )}
                </Row>
                {paidTx.kind === "found" && (
                  <Row label="40% check">{paidTx.loanChecked ? "Ran: this payment added bitcoin-backed debt." : "Not needed: no new debt."}</Row>
                )}
              </>
            )}
          </dl>
        </aside>
      </div>
    </section>
  );
}
