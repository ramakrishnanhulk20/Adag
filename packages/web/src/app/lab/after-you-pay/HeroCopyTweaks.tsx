"use client";

import Link from "next/link";
import { Hallmark } from "@/components/Hallmark";
import { LiveData, useLive } from "@/components/hero/LiveData";

// The paid count is read live, as the real hero cell would read it; nothing on this lab card is a fixed figure.
function PaidCell() {
  const live = useLive();
  const paid = live.status === "ready" && live.snapshot.paid.ok ? live.snapshot.paid.value.billsPaid : null;
  return (
    <p className="type-micro text-muted">
      {paid === null ? "Reading Arc" : `${paid} bill${paid === 1 ? "" : "s"} paid`}
      {" · "}
      <Link href="/bill/1" className="link-draw text-gold">
        see bill #1
      </Link>
    </p>
  );
}

// The two hero copy changes as Ram approved them, kept beside the section for reference; the hero now carries both.
export function HeroCopyTweaks() {
  return (
    <section aria-labelledby="tweaks-title" className="border-t border-rule bg-surface px-5 py-20 md:px-[6vw] md:py-28">
      <Hallmark tone="quiet">Hero copy · approved, now live on /</Hallmark>
      <h2 id="tweaks-title" className="type-h3 mt-8">
        Two hero tweaks, as they would read
      </h2>
      <div className="mt-12 grid gap-12 md:grid-cols-2 md:gap-16">
        <div className="flex flex-col gap-4">
          <p className="type-label text-gold">01 · The line under the headline</p>
          <p className="type-micro text-muted">Now</p>
          <p className="type-lead max-w-[46ch] text-text/70">
            Pay your suppliers from the bitcoin your company holds. One signature pledges cirBTC on Morpho, borrows exactly the bills and pays
            them in USDC or EURC, invoice number attached.
          </p>
          <p className="type-micro mt-2 text-muted">Proposed</p>
          <p className="type-lead max-w-[46ch] text-text">
            Pay your suppliers from the bitcoin your company holds. One signature, from your wallet{" "}
            <em className="text-gold not-italic">or your company Safe</em>, pledges cirBTC on Morpho, borrows exactly the bills and pays them in USDC
            or EURC, invoice number attached.
          </p>
        </div>
        <div className="flex flex-col gap-4">
          <p className="type-label text-gold">02 · The hero&apos;s paid number</p>
          <p className="type-body max-w-[40ch] text-muted">
            The &quot;Paid through Adag&quot; cell gains a direct way to the proof, the judge&apos;s shortest path to a real payment:
          </p>
          <div className="border border-rule-strong bg-raised px-6 py-5">
            <p className="type-label text-muted">Paid through Adag</p>
            <LiveData>
              <PaidCell />
            </LiveData>
          </div>
        </div>
      </div>
    </section>
  );
}
