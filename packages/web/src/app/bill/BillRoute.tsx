import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { BillLive } from "@/components/app/BillLive";
import { BillMissing } from "@/components/app/BillMissing";
import { BillSheet } from "@/components/app/BillSheet";
import { BillWallet } from "@/components/app/BillWallet";
import { parseBillRoute } from "@/lib/pay/billId";
import { billToJson } from "@/lib/pay/billJson";
import { deploymentOf } from "@/lib/pay/constants";
import { findPaidTx, readBill, readBillCount } from "@/lib/pay/read";
import type { PublicClient } from "viem";
import { HowPaid } from "@/components/app/HowPaid";
import { arcClient } from "@/lib/arc/client";
import { readHowPaid } from "@/lib/pay/howPaid";

// Shared by /bill/[id] (the current contract) and /bill/first/[id] (the first deployment). The route's segments go
// through parseBillRoute once, and that one pair drives the read, the sheet, the wallet panel and the live poll (C33).
export function billMetadata(segments: string[]): Metadata {
  const ref = parseBillRoute(segments);
  const first = ref && deploymentOf(ref.contract)?.label === "first";
  return { title: ref ? `Bill #${ref.id}${first ? " (first deployment)" : ""}` : "Bill", robots: { index: false, follow: false } };
}

export async function BillRoute({ segments }: { segments: string[] }) {
  const ref = parseBillRoute(segments);
  if (ref === null) {
    return (
      <AppShell>
        <BillMissing kind="invalid" raw={segments.join("/")} />
      </AppShell>
    );
  }

  const read = await readBill(ref);
  if (read.kind === "unavailable") {
    return (
      <AppShell>
        <BillMissing kind="unavailable" id={ref.id} />
      </AppShell>
    );
  }
  if (read.kind === "none") {
    const count = await readBillCount(ref.contract);
    return (
      <AppShell>
        <BillMissing kind="none" id={ref.id} count={count.ok ? count.count : null} first={deploymentOf(ref.contract)?.label === "first"} />
      </AppShell>
    );
  }

  const paidTx = await findPaidTx(read.bill);
  const how = paidTx.kind === "found" ? await readHowPaid(arcClient as PublicClient, read.bill, paidTx) : null;
  return (
    <AppShell>
      <BillSheet bill={read.bill} paidTx={paidTx} />
      {how && <HowPaid how={how} />}
      <BillWallet bill={billToJson(read.bill)} paidTxUrl={paidTx.kind === "found" ? paidTx.url : null} />
      <BillLive contract={read.bill.contract} id={read.bill.id.toString()} status={read.bill.status} />
    </AppShell>
  );
}
