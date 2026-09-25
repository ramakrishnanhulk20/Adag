import type { CSSProperties } from "react";
import { BillStamp } from "@/components/BillStamp";
import type { StageBill } from "@/lib/arc/pledge";
import { formatDate, formatToken, shortHash } from "./format";

// The fan spreads around the middle card, so one bill sits level and three open like a hand of cards.
function fanPose(index: number, count: number): CSSProperties {
  const k = index - (count - 1) / 2;
  return { "--k": k, "--r": `${k * 4.5 - 1.5}deg` } as CSSProperties;
}

function PaymentLine({ bill }: { bill: StageBill }) {
  if (bill.status !== "paid") return null;
  if (bill.payment) {
    return (
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
    );
  }
  return (
    <p data-pl="tx" className="pl-tx type-micro text-muted">
      {bill.paymentNote === "not-found" ? "Tx outside the search window" : "Tx link unavailable"}
    </p>
  );
}

export function BillCard({ bill, index, count }: { bill: StageBill; index: number; count: number }) {
  const [whole, currency] = formatToken(bill.amountBaseUnits, bill.currency).split(" ");
  return (
    <li className="pl-slot" style={fanPose(index, count)} data-pl-slot={bill.id}>
      <div data-pl="card" className="pl-card">
        <article className="pl-card-body" aria-label={`Bill ${bill.id}`}>
          <header className="type-label text-text">Bill #{bill.id}</header>
          <p className="pl-card-amount">
            {whole}
            <span className="type-micro ml-2 text-muted">{currency}</span>
          </p>
          <dl className="pl-card-facts">
            <dt className="type-micro text-muted">To</dt>
            <dd className="type-address break-all text-text">{bill.payee}</dd>
            <dt className="type-micro text-muted">Ref</dt>
            {/* C14: the reference is text only, never markup or a link. */}
            <dd className="type-address break-words text-text">{bill.reference || "none"}</dd>
            <dt className="type-micro text-muted">Due</dt>
            <dd className="type-micro text-text">{formatDate(bill.due)}</dd>
          </dl>
          <PaymentLine bill={bill} />
        </article>
        <div data-pl="stamp-open" className="pl-stamp">
          <BillStamp status="open" tilt={-6} />
        </div>
        {bill.status === "paid" && (
          <div data-pl="stamp-paid" className="pl-stamp">
            <BillStamp status="paid" tilt={-8} />
          </div>
        )}
      </div>
    </li>
  );
}
