import type { CSSProperties } from "react";
import { getTranslations } from "next-intl/server";
import { BillStamp, type BillStatus } from "@/components/BillStamp";
import { Hallmark } from "@/components/Hallmark";
import { dateIn, dateTimeIn } from "@/i18n/dates";
import { getLocale } from "@/i18n/server";
import type { Bill } from "@/lib/pay/build";
import { BILL_STATUS, EXPLORER, deploymentOf } from "@/lib/pay/constants";
import { formatUnitsExact, fullAddress, referenceText, shortAddress } from "@/lib/pay/format";
import { currencyOf } from "@/lib/pay/market";
import type { PaidTx } from "@/lib/pay/read";
import { Parallax } from "./Parallax";

const d = (n: number) => ({ "--d": n }) as CSSProperties;

function statusOf(status: number): BillStatus {
  return status === BILL_STATUS.Paid ? "paid" : status === BILL_STATUS.Void ? "void" : "open";
}

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

// Everything on this sheet is decoded from bill(id) on the bill's own contract, the same record pay() reads (C15).
// Status comes only from that record; the transaction link only from that contract's BillPaid log (C16, C33).
export async function BillSheet({ bill, paidTx }: { bill: Bill; paidTx: PaidTx }) {
  const [t, tc, locale] = await Promise.all([getTranslations("bill.sheet"), getTranslations("common"), getLocale()]);
  const status = statusOf(bill.status);
  const currency = currencyOf(bill.currency);
  const payee = fullAddress(bill.payee);
  // The reference is the supplier's own text, decoded to plain characters (C14) and placed as a React child, never markup (I2).
  const reference = referenceText(bill.ref);
  const amount = currency ? formatUnitsExact(bill.amount, currency.decimals) : bill.amount.toString();
  const first = deploymentOf(bill.contract)?.label === "first";
  const id = bill.id.toString();

  return (
    <section className="relative px-5 pt-10 pb-14 md:px-[6vw] md:pt-[9vh] md:pb-20" aria-labelledby="bill-title">
      <Parallax distance={-140} className="pointer-events-none absolute -z-10 right-[4vw] top-[5vh] invisible md:visible">
        <div aria-hidden="true" className="app-watermark text-[clamp(11rem,24vw,26rem)]">
          <span className="app-watermark-sign">№</span>
          {id.length > 6 ? `${id.slice(0, 6)}…` : id}
        </div>
      </Parallax>

      <div className="grid gap-12 md:grid-cols-12 md:gap-8">
        <div className="md:col-span-7">
          <div className="app-rise" style={d(0)}>
            <Hallmark>
              {tc("billNo", { id })}
              {first ? (
                <>
                  {` · ${tc("firstDeployment")}`}
                  {/* The longer mark would push a phone screen wider than itself, so the network drops there. */}
                  <span className="hidden md:inline"> · {tc("arcMainnet")}</span>
                </>
              ) : (
                ` · ${tc("arcMainnet")}`
              )}
            </Hallmark>
          </div>
          <h1 id="bill-title" className="sr-only">
            {t("srTitle", { id, amount, currency: currency?.symbol ?? "", status: t(`statusWord.${status}`) })}
          </h1>

          <p className="type-label app-rise mt-10 text-muted md:mt-14" style={d(1)}>
            {t(`headline.${status}`)}
          </p>
          {/* The stamp sits clear of the figures so the currency always reads. It wraps below on narrow screens. */}
          <div className="mt-3 flex flex-wrap items-end gap-x-10 gap-y-5">
            <p className="app-amount app-rise text-text" style={d(2)}>
              {amount}
              <span className="app-amount-unit">{currency?.symbol ?? t("unknownTokenLower")}</span>
            </p>
            <div className="app-stamp relative z-10 mb-[0.4rem] md:mb-[1.6rem]">
              {/* Keyed by status, so after a payment or a void the refreshed page stamps the new state down with a spring. */}
              <BillStamp key={status} status={status} entrance="in-view" tilt={status === "paid" ? -9 : status === "void" ? -11 : -6} />
            </div>
          </div>

          <div className="app-rise mt-10 md:mt-14" style={d(3)}>
            <p className="type-label text-muted">{t("pays")}</p>
            <p className="type-address mt-3 break-all text-[0.9375rem] text-text md:text-[1.1875rem]">{payee}</p>
            <ExternalLink href={`${EXPLORER}/address/${payee}`} className="type-micro mt-3 inline-block text-muted">
              {t("addressOnExplorer")}
            </ExternalLink>
          </div>

          <p className="type-lead app-rise mt-10 max-w-[38rem] text-text/88" style={d(4)}>
            {status === "open" && t("openText")}
            {status === "paid" && t("paidText")}
            {status === "void" && <span className="text-danger">{t("voidText")}</span>}
          </p>
        </div>

        <aside className="app-rise md:col-span-5 md:pt-[clamp(15rem,23vw,22rem)]" style={d(5)} aria-label={t("details")}>
          <dl className="app-ledger border-y border-rule">
            <Row label={t("due")}>{bill.due === 0n ? tc("noDueDate") : dateIn(locale, bill.due)}</Row>
            <Row label={t("written")}>{dateTimeIn(locale, bill.createdAt)}</Row>
            <Row label={tc("reference")}>
              {reference ? <span className="app-reference">{reference}</span> : <span className="text-muted">{tc("none")}</span>}
            </Row>
            <Row label={t("currency")}>
              <span className="block">{currency?.symbol ?? t("unknownToken")}</span>
              <span className="type-address mt-1 block break-all text-muted">{fullAddress(bill.currency)}</span>
            </Row>
            <Row label={t("contract")}>
              <span className="block" data-bill-contract={first ? "first" : "current"}>
                {first ? tc("contractNames.billsFirst") : tc("contractNames.bills")}
              </span>
              <ExternalLink href={`${EXPLORER}/address/${bill.contract}`} className="type-address mt-1 block break-all text-muted">
                {fullAddress(bill.contract)}
              </ExternalLink>
            </Row>
            {status === "paid" && (
              <>
                <Row label={t("paidBy")}>
                  <span className="type-address block break-all text-[0.875rem]">{fullAddress(bill.payer)}</span>
                </Row>
                <Row label={t("paidOn")}>{dateTimeIn(locale, bill.paidAt)}</Row>
                <Row label={tc("transaction")}>
                  {paidTx.kind === "found" ? (
                    <ExternalLink href={paidTx.url} className="type-address text-[0.875rem] text-text">
                      {tc("hashOnExplorer", { hash: shortAddress(paidTx.txHash) })}
                    </ExternalLink>
                  ) : paidTx.kind === "unavailable" ? (
                    <span className="text-muted">{t("txUnavailable")}</span>
                  ) : (
                    <span className="text-muted">{t("txNotFound")}</span>
                  )}
                </Row>
                {paidTx.kind === "found" && (
                  <Row label={tc("fortyCheck")}>
                    {paidTx.loanChecked ? t("checkPassed") : paidTx.checkedOnBill !== null ? t("checkPassedOnBill", { id: paidTx.checkedOnBill.toString() }) : t("checkNotNeeded")}
                  </Row>
                )}
              </>
            )}
          </dl>
        </aside>
      </div>
    </section>
  );
}
