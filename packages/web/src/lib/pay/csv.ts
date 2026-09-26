import { formatUnits } from "viem";
import type { Bill } from "./build";
import { BILL_STATUS } from "./constants";
import { referenceText } from "./format";
import { currencyOf } from "./market";
import type { PaidTx } from "./paidTx";

export const CSV_HEADER = [
  "contract address",
  "bill number",
  "status",
  "written at",
  "paid at",
  "supplier",
  "payer",
  "amount",
  "currency",
  "reference",
  "transaction link",
  "40% check ran",
] as const;

// A spreadsheet runs a cell that starts with one of these as a formula. References and every other cell come from
// outside, so each such cell gets a leading single quote and is shown as the text it is.
const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralise(cell: string): string {
  return FORMULA_START.test(cell) ? `'${cell}` : cell;
}

// RFC 4180: every field quoted, quotes doubled, lines ended with CRLF.
export function toCsv(rows: readonly (readonly string[])[]): string {
  return rows.map((row) => row.map((cell) => `"${neutralise(cell).replace(/"/g, '""')}"`).join(",")).join("\r\n") + "\r\n";
}

const iso = (seconds: bigint) => (seconds > 0n ? new Date(Number(seconds) * 1000).toISOString() : "");
const statusWord = (s: number) => (s === BILL_STATUS.Paid ? "paid" : s === BILL_STATUS.Void ? "void" : s === BILL_STATUS.Open ? "open" : "unknown");

// One row per bill, from the same bill(id) records the lists show. The transaction and the 40% flag come only from
// Adag's own BillPaid log for that bill (C16); when it cannot be read, the cell says so rather than guessing.
export function billRow(bill: Bill, paid: PaidTx | null): string[] {
  const c = currencyOf(bill.currency);
  const isPaid = bill.status === BILL_STATUS.Paid;
  const tx = !isPaid ? "" : paid?.kind === "found" ? paid.url : paid?.kind === "unavailable" ? "unavailable" : "not found";
  const checked = !isPaid ? "" : paid?.kind === "found" ? (paid.loanChecked ? "yes" : "no") : "unknown";
  return [
    bill.contract,
    bill.id.toString(),
    statusWord(bill.status),
    iso(bill.createdAt),
    isPaid ? iso(bill.paidAt) : "",
    bill.payee,
    isPaid ? bill.payer : "",
    c ? formatUnits(bill.amount, c.decimals) : bill.amount.toString(),
    c?.symbol ?? bill.currency,
    referenceText(bill.ref),
    tx,
    checked,
  ];
}

export function csvFileName(kind: "written" | "paid", address: string, now: Date): string {
  const day = now.toISOString().slice(0, 10);
  return `adag-bills-${kind}-${address.slice(0, 6).toLowerCase()}...${address.slice(-4).toLowerCase()}-${day}.csv`;
}
