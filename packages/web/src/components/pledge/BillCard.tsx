import type { CSSProperties } from "react";
import Link from "next/link";
import { BillStamp } from "@/components/BillStamp";
import type { StageBill } from "@/lib/arc/pledge";
import { billHref } from "@/lib/pay/billId";
import { formatDate, formatToken, shortHash } from "./format";

// The fan spreads around the middle card, so one bill sits level and three open like a hand of cards.
function fanPose(index: number, count: number): CSSProperties {
  const k = index - (count - 1) / 2;
  return { "--k": k, "--r": `${k * 4.5 - 1.5}deg` } as CSSProperties;
}

const short = (address: string) => `${address.slice(0, 6)}...${address.slice(-4)}`;

// A paid bill from its BillPaid event only. There is no reference row: the stage never shows a stranger's words
// (security pass 1, M2); the bill's own page does.
export function BillCard({ bill, index, count }: { bill: StageBill; index: number; count: number }) {
  const [whole, currency] = formatToken(bill.amountBaseUnits, bill.currency).split(" ");
  let href: string | null = null;
  try {
    href = billHref(bill.contract, BigInt(bill.id));
  } catch {
    href = null;
  }
  const title = `Bill #${bill.id}`;
  return (
    <li className="pl-slot" style={fanPose(index, count)} data-pl-slot={bill.key}>
      <div data-pl="card" className="pl-card">
        <article className="pl-card-body" aria-label={bill.first ? `${title}, first deployment` : title}>
          <header>
            {href ? (
              <Link href={href} className="link-draw type-label text-text hover:text-gold">
                {title}
              </Link>
            ) : (
              <span className="type-label text-text">{title}</span>
            )}
          </header>
          <p className="pl-card-amount">
            {whole}
            <span className="type-micro ml-2 text-muted">{currency}</span>
          </p>
          <dl className="pl-card-facts">
            <dt className="type-micro text-muted">To</dt>
            <dd className="type-address break-all text-text">{bill.payee}</dd>
            <dt className="type-micro text-muted">From</dt>
            <dd className="type-address text-text">{short(bill.payer)}</dd>
            <dt className="type-micro text-muted">Paid</dt>
            <dd className="type-micro text-text">{formatDate(bill.paidAt)}</dd>
            {bill.first && (
              <>
                <dt className="type-micro text-muted">On</dt>
                <dd className="type-micro text-text">First deployment</dd>
              </>
            )}
          </dl>
          <p data-pl="tx" className="pl-tx type-micro">
            <span className="text-muted">Paid in </span>
            <a
              href={bill.payment.explorerUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="link-draw text-gold"
              aria-label={`The transaction that paid bill ${bill.id}, on the Arc explorer`}
            >
              tx {shortHash(bill.payment.txHash)}
            </a>
          </p>
        </article>
        <div data-pl="stamp-open" className="pl-stamp">
          <BillStamp status="open" tilt={-6} />
        </div>
        <div data-pl="stamp-paid" className="pl-stamp">
          <BillStamp status="paid" tilt={-8} />
        </div>
      </div>
    </li>
  );
}
