"use client";

import Link from "next/link";
import { useLive } from "@/components/hero/LiveData";
import { CHECKS } from "@/lib/break/catalogue";
import { formatAmount } from "@/lib/arc/present";
import type { ProofBill } from "@/lib/arc/types";
import { billHref } from "@/lib/pay/billId";
import { ADAG_BILLS } from "@/lib/pay/constants";
import { Reveal } from "./Reveal";

type ProofLink = { label: string; href: string; external?: boolean };
type Proof = { title: string; body: string; links: ProofLink[] };

const BILL_ONE = billHref(ADAG_BILLS, 1n);

// Every word about bill #1 is decided by what Arc says now: paid or not, whether the 40% check ran, and which
// transaction did it. Nothing here is copied from the deployment record.
function billOneProof(proof: ProofBill | null, state: "loading" | "ready" | "failed"): Proof {
  const open: ProofLink = { label: "Open bill #1", href: BILL_ONE };
  if (state === "loading") return { title: "Bill #1", body: "Reading bill #1 and its payment from Arc.", links: [open] };
  if (!proof) return { title: "Bill #1", body: "Arc did not answer, so nothing is claimed about bill #1 here. Its own page reads it again.", links: [open] };
  const amount = formatAmount(proof.amountBaseUnits, proof.currency);
  if (proof.status !== 2) return { title: "Bill #1", body: `A ${amount} bill on the current contract, not paid yet.`, links: [open] };
  if (!proof.payment) {
    return { title: "Bill #1, paid", body: `A real ${amount} bill, marked paid on Arc. Its payment transaction was not found in range just now.`, links: [open] };
  }
  const how = proof.payment.loanChecked
    ? "paid from a loan against bitcoin, with Adag's 40% check run on that loan"
    : "paid in one signature; it added no new loan, so there was nothing for the 40% check to test";
  return {
    title: "Bill #1, paid",
    body: `A real ${amount} bill, ${how}.`,
    links: [open, { label: "Its transaction", href: proof.payment.explorerUrl, external: true }],
  };
}

const STATIC_PROOFS: Proof[] = [
  {
    title: "Try to break it",
    body: `${CHECKS.length} attacks against the live contracts, simulated on Arc while you watch. Each shows what stops it.`,
    links: [{ label: "Run the attacks", href: "/break" }],
  },
  {
    title: "Audit status",
    body: "Self-audited, not by an outside firm. What was tested, what was found, and what is not covered.",
    links: [{ label: "Read the record", href: "/docs/security/audit-status" }],
  },
];

// A short strip, not a numbered section: three ways to check the claims above without taking our word for it.
export function CheckIt() {
  const live = useLive();
  const proofCell = live.status === "ready" ? live.snapshot.proof : null;
  const first = billOneProof(proofCell?.ok ? proofCell.value : null, live.status === "ready" ? (proofCell?.ok ? "ready" : "failed") : live.status);
  const proofs = [first, ...STATIC_PROOFS];

  return (
    <section id="proof" aria-labelledby="check-title" className="landing-section scroll-mt-20 border-t border-rule bg-bg px-5 py-16 md:px-[6vw] md:py-20">
      <div className="grid gap-10 md:grid-cols-12 md:gap-8">
        <Reveal className="md:col-span-3">
          <p className="type-label text-gold">Proof</p>
          <h2 id="check-title" className="type-h3 mt-4 max-w-[12ch]">
            Check it <em className="text-gold italic">yourself.</em>
          </h2>
        </Reveal>
        <ul className="grid gap-px bg-rule md:col-span-9 md:grid-cols-3">
          {proofs.map((proof, i) => (
            <li key={i} data-proof={i + 1} className="group bg-bg py-6 md:px-8 md:py-2 md:first:pl-0">
              <Reveal delay={0.08 * (i + 1)} className="flex h-full flex-col gap-4">
                <p className="type-label text-muted transition-colors duration-200 group-hover:text-gold">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="type-h4">{proof.title}</h3>
                <p className="type-body max-w-[34ch] text-muted">{proof.body}</p>
                <p className="mt-auto flex flex-wrap gap-x-6">
                  {proof.links.map((link) =>
                    link.external ? (
                      <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="link-draw tap-target type-label text-gold">
                        {link.label}
                      </a>
                    ) : (
                      <Link key={link.label} href={link.href} className="link-draw tap-target type-label text-gold">
                        {link.label}
                      </Link>
                    ),
                  )}
                </p>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
