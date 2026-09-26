import type { Metadata } from "next";
import { Hallmark } from "@/components/Hallmark";
import { AppShell } from "@/components/app/AppShell";
import { PayForm } from "@/components/app/PayForm";
import { readTotalBillCount } from "@/lib/pay/read";

export const metadata: Metadata = {
  title: "Pay a bill · Adag",
  description: "Open a bill on Arc by its number or link, and see exactly who it pays and how much.",
};

export const dynamic = "force-dynamic";

export default async function PayPage() {
  const count = await readTotalBillCount();

  return (
    <AppShell>
      <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[14vh] md:pb-[18vh]">
        <div
          aria-hidden="true"
          className="app-watermark absolute right-[4vw] top-[8vh] -z-10 invisible text-[clamp(14rem,30vw,32rem)] md:visible"
        >
          <span className="app-watermark-sign">№</span>
          {count.ok ? count.count.toString() : ""}
        </div>

        <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
          <Hallmark>Pay a bill · Arc mainnet</Hallmark>
        </div>
        <h1 className="app-title app-rise mt-6 max-w-[11ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
          Which <em className="font-semibold text-gold italic">bill</em>?
        </h1>
        <p className="type-lead app-rise mt-6 max-w-[40rem] text-text/88 md:mt-8" style={{ "--d": 2 } as React.CSSProperties}>
          Type the number your supplier sent, or paste their link. Adag reads the bill straight from Arc: who it pays, how much, and
          whether it is still open. Several numbers, up to ten, are paid together with one signature.
        </p>

        <div className="app-rise mt-10 md:mt-14" style={{ "--d": 3 } as React.CSSProperties}>
          <PayForm />
        </div>

        <div className="app-rise mt-6 flex items-baseline gap-4 border-t border-rule pt-6 md:mt-10 md:max-w-[44rem]" style={{ "--d": 4 } as React.CSSProperties}>
          <span className={count.ok ? "type-number text-text" : "type-label text-muted"}>{count.ok ? count.count.toString() : "unavailable"}</span>
          <span className="type-body text-muted">
            {count.ok ? `bill${count.count === 1n ? "" : "s"} written on Arc so far, read from both AdagBills deployments just now.` : "Arc did not answer, so the bill count is unknown right now."}
          </span>
        </div>
      </section>
    </AppShell>
  );
}
