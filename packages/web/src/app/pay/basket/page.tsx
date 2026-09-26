import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { Basket, type BasketItem } from "@/components/app/Basket";
import { BillMissing } from "@/components/app/BillMissing";
import { parseBillList } from "@/lib/pay/billId";
import { billToJson } from "@/lib/pay/billJson";
import { readBill } from "@/lib/pay/read";

export const metadata: Metadata = {
  title: "Pay several bills · Adag",
  description: "Pay up to ten bills on Arc with one signature, from your balance or from a loan against your cirBTC.",
  robots: { index: false, follow: false },
};

// Every visit reads the chain; a cached basket could show a paid bill as payable.
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ bills?: string | string[] }> };

export default async function BasketPage({ searchParams }: Props) {
  const raw = (await searchParams).bills;
  // C3: the link carries bill ids and nothing else; every other fact is read from Arc below.
  const text = Array.isArray(raw) ? raw.join(",") : (raw ?? "");
  let ids: bigint[] = [];
  let dropped: string[] = [];
  let droppedCount = 0;
  let refusal: string | null = null;
  try {
    ({ ids, dropped, droppedCount } = parseBillList(text));
  } catch (error) {
    refusal = (error as Error).message;
  }

  if (refusal || ids.length === 0) {
    return (
      <AppShell>
        {refusal ? <BillMissing kind="refused" message={refusal} /> : <BillMissing kind="invalid" raw={text} />}
      </AppShell>
    );
  }

  const reads = await Promise.all(ids.map((id) => readBill(id)));
  const items: BasketItem[] = reads.map((r, i) =>
    r.kind === "found" ? { id: ids[i]!.toString(), kind: "found", bill: billToJson(r.bill) } : { id: ids[i]!.toString(), kind: r.kind },
  );

  return (
    <AppShell>
      <Basket items={items} dropped={dropped} droppedCount={droppedCount} />
    </AppShell>
  );
}
