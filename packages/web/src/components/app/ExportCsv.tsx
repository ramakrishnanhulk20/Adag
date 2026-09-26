"use client";

import { useState } from "react";
import { motion } from "motion/react";
import type { Address, PublicClient } from "viem";
import { Button } from "@/components/Button";
import type { Bill } from "@/lib/pay/build";
import { BILL_STATUS } from "@/lib/pay/constants";
import { CSV_HEADER, billRow, csvFileName, toCsv } from "@/lib/pay/csv";
import { searchBillPaid, type PaidTx } from "@/lib/pay/paidTx";
import { publicArc } from "@/lib/wallet/send";
import { useBillList } from "./BillLists";
import { rise } from "./cells";

// Searches run a few at a time, so a long list does not flood the public RPC.
const AT_ONCE = 3;

async function paidTxFor(bills: Bill[], onProgress: (done: number, total: number) => void): Promise<Map<bigint, PaidTx>> {
  const paid = bills.filter((b) => b.status === BILL_STATUS.Paid);
  const out = new Map<bigint, PaidTx>();
  const client = publicArc() as PublicClient;
  let next = 0;
  let done = 0;
  onProgress(0, paid.length);
  const worker = async () => {
    while (next < paid.length) {
      const bill = paid[next++]!;
      out.set(bill.id, await searchBillPaid(client, bill));
      onProgress(++done, paid.length);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, paid.length) }, worker));
  return out;
}

function download(name: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function ExportCsv({ address }: { address: Address }) {
  const wrote = useBillList("wrote", address);
  const paidList = useBillList("paid", address);
  const [progress, setProgress] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (kind: "written" | "paid") => {
    const bills = (kind === "written" ? wrote.data : paidList.data)?.bills;
    if (!bills) return setNote("The list has not loaded yet. Try again in a moment.");
    setNote(null);
    const txs = await paidTxFor(bills, (d, t) => setProgress(t ? `Finding the transactions on Arc · ${d} of ${t}` : null));
    setProgress(null);
    const rows = [CSV_HEADER as readonly string[], ...bills.map((b) => billRow(b, txs.get(b.id) ?? null))];
    download(csvFileName(kind, address, new Date()), toCsv(rows));
    const capped = (kind === "written" ? wrote.data : paidList.data)?.capped;
    setNote(`${bills.length} bill${bills.length === 1 ? "" : "s"} exported${capped ? ", the newest 1,000" : ""}.`);
  };

  return (
    <motion.section {...rise(0)} aria-labelledby="export-title" className="mt-16 border-t border-rule pt-10" data-export>
      <h2 id="export-title" className="type-h3 text-text">
        Export for your accountant
      </h2>
      <p className="type-body mt-2 max-w-[42rem] text-muted">
        Two spreadsheet files, made in your browser from the same records as the lists above: every bill with its status, dates in UTC, amounts, reference,
        transaction link and whether the 40% check ran.
      </p>
      <div className="mt-6 flex flex-col gap-3 md:flex-row">
        <Button variant="secondary" disabled={!wrote.data || progress !== null} onClick={() => void run("written")} className="w-full md:w-auto" data-action="export-written">
          Bills you wrote (CSV)
        </Button>
        <Button variant="secondary" disabled={!paidList.data || progress !== null} onClick={() => void run("paid")} className="w-full md:w-auto" data-action="export-paid">
          Bills you paid (CSV)
        </Button>
      </div>
      {(progress || note) && (
        <p className="type-body mt-3 text-muted" role="status">
          {progress ?? note}
        </p>
      )}
    </motion.section>
  );
}
