"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
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

type T = ReturnType<typeof useTranslations<"landing.checkIt">>;

// Every word about bill #1 is decided by what Arc says now: paid or not, whether the 40% check ran, and which
// transaction did it. Nothing here is copied from the deployment record.
function billOneProof(t: T, proof: ProofBill | null, state: "loading" | "ready" | "failed"): Proof {
  const open: ProofLink = { label: t("openBillOne"), href: BILL_ONE };
  if (state === "loading") return { title: t("billOne"), body: t("reading"), links: [open] };
  if (!proof) return { title: t("billOne"), body: t("noAnswer"), links: [open] };
  const amount = formatAmount(proof.amountBaseUnits, proof.currency);
  if (proof.status !== 2) return { title: t("billOne"), body: t("notPaidYet", { amount }), links: [open] };
  if (!proof.payment) {
    return { title: t("billOnePaid"), body: t("txNotFound", { amount }), links: [open] };
  }
  return {
    title: t("billOnePaid"),
    body: proof.payment.loanChecked ? t("paidFromLoan", { amount }) : t("paidNoLoan", { amount }),
    links: [open, { label: t("itsTransaction"), href: proof.payment.explorerUrl, external: true }],
  };
}

// A short strip, not a numbered section: three ways to check the claims above without taking our word for it.
export function CheckIt() {
  const live = useLive();
  const t = useTranslations("landing.checkIt");
  const proofCell = live.status === "ready" ? live.snapshot.proof : null;
  const first = billOneProof(t, proofCell?.ok ? proofCell.value : null, live.status === "ready" ? (proofCell?.ok ? "ready" : "failed") : live.status);
  const proofs: Proof[] = [
    first,
    { title: t("tryToBreakIt"), body: t("attacks", { n: String(CHECKS.length) }), links: [{ label: t("runTheAttacks"), href: "/break" }] },
    { title: t("auditStatus"), body: t("auditBody"), links: [{ label: t("readTheRecord"), href: "/docs/security/audit-status" }] },
  ];

  return (
    <section id="proof" aria-labelledby="check-title" className="landing-section scroll-mt-20 border-t border-rule bg-bg px-5 py-16 md:px-[6vw] md:py-20">
      <div className="grid gap-10 md:grid-cols-12 md:gap-8">
        <Reveal className="md:col-span-3">
          <p className="type-label text-gold">{t("proof")}</p>
          <h2 id="check-title" className="type-h3 mt-4 max-w-[12ch]">
            {t.rich("title", { em: (chunks) => <em className="text-gold italic">{chunks}</em> })}
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
