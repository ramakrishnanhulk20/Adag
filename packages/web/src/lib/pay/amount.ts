import { parseUnits } from "viem";

export type Parsed = { ok: true; value: bigint } | { ok: false; message: string };

// C15: a typed decimal is parsed exactly once, here, into base units. Everything after this is an integer.
export function parseAmountInput(text: string, decimals: number): Parsed {
  const raw = text.trim();
  if (raw === "") return { ok: false, message: "Enter an amount." };
  // No thousands separators. A lone comma is the decimal mark, because some phone keypads offer only a comma, and the
  // preview shows the parsed amount in full before anything is signed.
  const commas = raw.split(",").length - 1;
  if (commas > 1 || (commas === 1 && raw.includes("."))) {
    return { ok: false, message: "Use one decimal mark and no thousands separators, like 1250.50." };
  }
  const t = raw.replace(",", ".");
  if (!/^\d+(\.\d*)?$|^\.\d+$/.test(t)) return { ok: false, message: "Use digits and one decimal point, like 12.50." };
  const [, frac = ""] = t.split(".");
  if (frac.length > decimals) return { ok: false, message: `At most ${decimals} decimal places.` };
  const value = parseUnits(t.startsWith(".") ? `0${t}` : t, decimals);
  if (value <= 0n) return { ok: false, message: "The amount must be more than zero." };
  return { ok: true, value };
}

// A due date is stored as 12:00 UTC on the chosen day, so it reads as the same calendar date in every time zone.
export function dueFromDate(isoDate: string): bigint | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12);
  return Number.isFinite(ms) && ms > 0 ? BigInt(ms / 1000) : null;
}

export function localIsoDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
