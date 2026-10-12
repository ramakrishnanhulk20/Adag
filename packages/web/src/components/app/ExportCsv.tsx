"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { motion } from "motion/react";
import type { Address, PublicClient } from "viem";
import { Button } from "@/components/Button";
import { billKey } from "@/lib/pay/billId";
import type { Bill } from "@/lib/pay/build";
import { BILL_STATUS } from "@/lib/pay/constants";
import { CSV_HEADER, billRow, csvFileName, toCsv, type CsvWords } from "@/lib/pay/csv";
import { searchBillPaid, type PaidTx } from "@/lib/pay/paidTx";
import { publicArc } from "@/lib/wallet/send";
import { useBillList } from "./BillLists";
import { rise } from "./cells";

// Searches run a few at a time, so a long list does not flood the public RPC.
const AT_ONCE = 3;

// The catalog key of each English column name.
const HEADER_KEYS: Record<(typeof CSV_HEADER)[number], string> = {
  "contract address": "contractAddress",
  "bill number": "billNumber",
  status: "status",
  "written at": "writtenAt",
  "paid at": "paidAt",
  supplier: "supplier",
  payer: "payer",
  amount: "amount",
  currency: "currency",
  reference: "reference",
  "transaction link": "transactionLink",
  "40% check ran": "fortyCheckRan",
};

// Keyed by contract and id: the two deployments both have a bill #1, and each row's link comes from its own contract.
async function paidTxFor(bills: Bill[], onProgress: (done: number, total: number) => void): Promise<Map<string, PaidTx>> {
  const paid = bills.filter((b) => b.status === BILL_STATUS.Paid);
  const out = new Map<string, PaidTx>();
  const client = publicArc() as PublicClient;
  let next = 0;
  let done = 0;
  onProgress(0, paid.length);
  const worker = async () => {
    while (next < paid.length) {
      const bill = paid[next++]!;
      out.set(billKey(bill), await searchBillPaid(client, bill));
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
  const t = useTranslations("wallet.export");
  const tCsv = useTranslations("csv");
  const wrote = useBillList("wrote", address);
  const paidList = useBillList("paid", address);
  const [progress, setProgress] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const run = async (kind: "written" | "paid") => {
    const bills = (kind === "written" ? wrote.data : paidList.data)?.bills;
    if (!bills) return setNote(t("notLoaded"));
    setNote(null);
    const txs = await paidTxFor(bills, (d, t2) => setProgress(t2 ? t("finding", { done: String(d), total: String(t2) }) : null));
    setProgress(null);
    // The header row and the status words follow the language; numbers, addresses, references and links do not.
    const header = CSV_HEADER.map((column) => tCsv(`header.${HEADER_KEYS[column]}`));
    const words: CsvWords = {
      paid: tCsv("words.paid"),
      void: tCsv("words.void"),
      open: tCsv("words.open"),
      unknown: tCsv("words.unknown"),
      unavailable: tCsv("words.unavailable"),
      notFound: tCsv("words.notFound"),
      yes: tCsv("words.yes"),
      no: tCsv("words.no"),
    };
    const rows = [header, ...bills.map((b) => billRow(b, txs.get(billKey(b)) ?? null, words))];
    download(csvFileName(kind, address, new Date()), toCsv(rows));
    const capped = (kind === "written" ? wrote.data : paidList.data)?.capped;
    setNote(t("exported", { count: bills.length, n: String(bills.length), capped: capped ? t("cappedNote") : "" }));
  };

  return (
    <motion.section {...rise(0)} aria-labelledby="export-title" className="mt-16 border-t border-rule pt-10" data-export>
      <h2 id="export-title" className="type-h3 text-text">
        {t("title")}
      </h2>
      <p className="type-body mt-2 max-w-[42rem] text-muted">{t("body")}</p>
      <div className="mt-6 flex flex-col gap-3 md:flex-row">
        <Button variant="secondary" disabled={!wrote.data || progress !== null} onClick={() => void run("written")} className="w-full md:w-auto" data-action="export-written">
          {t("written")}
        </Button>
        <Button variant="secondary" disabled={!paidList.data || progress !== null} onClick={() => void run("paid")} className="w-full md:w-auto" data-action="export-paid">
          {t("paid")}
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
