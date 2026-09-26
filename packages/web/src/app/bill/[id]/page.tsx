import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { BillLive } from "@/components/app/BillLive";
import { BillMissing } from "@/components/app/BillMissing";
import { BillSheet } from "@/components/app/BillSheet";
import { BillWallet } from "@/components/app/BillWallet";
import { parseBillParam } from "@/lib/pay/billId";
import { billToJson } from "@/lib/pay/billJson";
import { findPaidTx, readBill, readBillCount } from "@/lib/pay/read";

// Every visit reads the chain; a cached page could show a paid bill as open.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const id = parseBillParam((await params).id);
  return { title: id ? `Bill #${id} · Adag` : "Bill · Adag", robots: { index: false, follow: false } };
}

export default async function BillPage({ params }: Params) {
  const raw = (await params).id;
  const id = parseBillParam(raw);
  if (id === null) {
    return (
      <AppShell>
        <BillMissing kind="invalid" raw={raw} />
      </AppShell>
    );
  }

  const read = await readBill(id);
  if (read.kind === "unavailable") {
    return (
      <AppShell>
        <BillMissing kind="unavailable" id={id} />
      </AppShell>
    );
  }
  if (read.kind === "none") {
    const count = await readBillCount();
    return (
      <AppShell>
        <BillMissing kind="none" id={id} count={count.ok ? count.count : null} />
      </AppShell>
    );
  }

  const paidTx = await findPaidTx(read.bill);
  return (
    <AppShell>
      <BillSheet bill={read.bill} paidTx={paidTx} />
      <BillWallet bill={billToJson(read.bill)} paidTxUrl={paidTx.kind === "found" ? paidTx.url : null} />
      <BillLive id={read.bill.id.toString()} status={read.bill.status} />
    </AppShell>
  );
}
