import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { Basket, type BasketItem } from "@/components/app/Basket";
import { BillMissing } from "@/components/app/BillMissing";
import { parseBasketQuery, type BillRef } from "@/lib/pay/billId";
import { billToJson } from "@/lib/pay/billJson";
import { ADAG_BILLS } from "@/lib/pay/constants";
import { readBill } from "@/lib/pay/read";

export const metadata: Metadata = {
  title: "Pay several bills · Adag",
  description: "Pay up to ten bills on Arc with one signature, from your balance or from a loan against your cirBTC.",
  robots: { index: false, follow: false },
};

// Every visit reads the chain; a cached basket could show a paid bill as payable.
export const dynamic = "force-dynamic";

type Props = { searchParams: Promise<{ bills?: string | string[]; deployment?: string | string[] }> };

export default async function BasketPage({ searchParams }: Props) {
  const query = await searchParams;
  // C3: the link carries bill ids and, for the first deployment, one marker; every other fact is read from Arc below.
  const text = Array.isArray(query.bills) ? query.bills.join(",") : (query.bills ?? "");
  const deployment = Array.isArray(query.deployment) ? query.deployment.join(",") : (query.deployment ?? null);
  let refs: BillRef[] = [];
  let dropped: string[] = [];
  let droppedCount = 0;
  let refusal: string | null = null;
  try {
    ({ refs, dropped, droppedCount } = parseBasketQuery(text, deployment));
  } catch (error) {
    refusal = (error as Error).message;
  }

  if (refusal || refs.length === 0) {
    return (
      <AppShell>
        {refusal ? <BillMissing kind="refused" message={refusal} /> : <BillMissing kind="invalid" raw={text} />}
      </AppShell>
    );
  }

  const contract = refs[0]?.contract ?? ADAG_BILLS;
  const reads = await Promise.all(refs.map((ref) => readBill(ref)));
  const items: BasketItem[] = reads.map((r, i) =>
    r.kind === "found" ? { id: refs[i]!.id.toString(), kind: "found", bill: billToJson(r.bill) } : { id: refs[i]!.id.toString(), kind: r.kind },
  );

  return (
    <AppShell>
      <Basket contract={contract} items={items} dropped={dropped} droppedCount={droppedCount} />
    </AppShell>
  );
}
