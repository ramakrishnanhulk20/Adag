import { getAddress } from "viem";
import { deploymentOf } from "../pay/constants";
import type { BorrowRate, BtcPrice, Cell, LatestBills, Liquidity, LiveSnapshot, LoanCap, PaidEntry, PaidThroughAdag, PriceStatus, ProofBill } from "./types";

// Runs in the browser. The route is ours, but its answer is still checked field by field, because a malformed
// answer must render "unavailable", never a wrong number (C19).

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const EXPLORER_TX = "https://explorer.arc.io/tx/";

// A payee is only shown if it is a well-formed address whose checksum survives a round trip (C15).
function isChecksummed(v: unknown): v is string {
  if (typeof v !== "string" || !/^0x[0-9a-fA-F]{40}$/.test(v)) return false;
  try {
    return getAddress(v) === v;
  } catch {
    return false;
  }
}

// A paid entry must name one of Adag's two contracts, and its "first" mark must agree with which one (C18).
function isEntry(v: unknown): v is PaidEntry {
  if (!isObj(v) || !isChecksummed(v.contract)) return false;
  const known = deploymentOf(v.contract);
  return (
    known !== null &&
    v.first === (known.label === "first") &&
    typeof v.id === "string" &&
    /^[1-9]\d{0,77}$/.test(v.id) &&
    (v.currency === "USDC" || v.currency === "EURC") &&
    isDigits(v.amountBaseUnits) &&
    isChecksummed(v.payer) &&
    isChecksummed(v.payee) &&
    typeof v.txHash === "string" &&
    TX_HASH.test(v.txHash) &&
    v.explorerUrl === EXPLORER_TX + v.txHash &&
    isNum(v.logIndex) &&
    isDigits(v.blockNumber) &&
    isNum(v.paidAt) &&
    typeof v.loanChecked === "boolean"
  );
}

function checkCell<T>(raw: unknown, valid: (v: Record<string, unknown>) => boolean): Cell<T> {
  if (!isObj(raw) || typeof raw.source !== "string") return { ok: false, reason: "Malformed answer.", source: "" };
  if (raw.ok === true && isObj(raw.value) && valid(raw.value)) return { ok: true, value: raw.value as T, source: raw.source };
  return { ok: false, reason: typeof raw.reason === "string" ? raw.reason : "Malformed answer.", source: raw.source };
}

export function parseSnapshot(raw: unknown): LiveSnapshot | null {
  if (!isObj(raw) || raw.chainId !== 5042 || typeof raw.fetchedAt !== "string") return null;
  return {
    fetchedAt: raw.fetchedAt,
    chainId: 5042,
    blockNumber: isDigits(raw.blockNumber) ? raw.blockNumber : null,
    liquidity: checkCell<Liquidity>(raw.liquidity, (v) => isDigits(v.usdcBaseUnits) && (v.eurcBaseUnits === null || isDigits(v.eurcBaseUnits))),
    borrowRate: checkCell<BorrowRate>(raw.borrowRate, (v) => isDigits(v.perSecondWad) && isNum(v.apy) && v.apy >= 0),
    loanCap: checkCell<LoanCap>(raw.loanCap, (v) => isDigits(v.maxLtvWad) && (v.morphoLltvWad === null || isDigits(v.morphoLltvWad))),
    paid: checkCell<PaidThroughAdag>(raw.paid, (v) => {
      const lp = v.latestPayment;
      const lpOk =
        lp === null ||
        (isObj(lp) &&
          isNum(lp.billId) &&
          typeof lp.txHash === "string" &&
          TX_HASH.test(lp.txHash) &&
          typeof lp.explorerUrl === "string" &&
          lp.explorerUrl === `https://explorer.arc.io/tx/${lp.txHash}`);
      return (
        isNum(v.billCount) &&
        isNum(v.billsPaid) &&
        isDigits(v.usdcBaseUnits) &&
        isDigits(v.eurcBaseUnits) &&
        lpOk &&
        (v.source === "index" || v.source === "direct") &&
        isDigits(v.throughBlock) &&
        (v.note === null || (typeof v.note === "string" && v.note.length <= 200))
      );
    }),
    price: checkCell<PriceStatus>(raw.price, (v) => typeof v.fresh === "boolean" && isNum(v.btcUsdUpdatedAt) && isNum(v.ageSeconds)),
    btcPrice: checkCell<BtcPrice>(raw.btcPrice, (v) => isNum(v.usdPerCirbtc) && v.usdPerCirbtc > 0),
    latestBills: checkCell<LatestBills>(
      raw.latestBills,
      (v) => isNum(v.billsPaid) && Array.isArray(v.bills) && v.bills.length <= 8 && v.bills.every(isEntry),
    ),
    proof: checkCell<ProofBill>(raw.proof, (v) => {
      const p = v.payment;
      const paymentOk =
        p === null ||
        (isObj(p) &&
          typeof p.txHash === "string" &&
          TX_HASH.test(p.txHash) &&
          p.explorerUrl === EXPLORER_TX + p.txHash &&
          isNum(p.logIndex) &&
          isDigits(p.blockNumber) &&
          typeof p.loanChecked === "boolean");
      return (
        v.id === "1" &&
        (v.status === 1 || v.status === 2 || v.status === 3) &&
        (v.currency === "USDC" || v.currency === "EURC") &&
        isDigits(v.amountBaseUnits) &&
        isNum(v.paidAt) &&
        paymentOk &&
        (v.paymentNote === "found" || v.paymentNote === "not-paid" || v.paymentNote === "not-found") &&
        (v.paymentNote === "found") === (p !== null)
      );
    }),
  };
}

function baseUnitsToNumber(units: string, decimals: number): number {
  const big = BigInt(units);
  const scale = 10n ** BigInt(decimals);
  return Number(big / scale) + Number(big % scale) / Number(scale);
}

const compactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", notation: "compact", maximumFractionDigits: 2 });
const compactEur = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", notation: "compact", maximumFractionDigits: 2 });
const exactUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
const exactEur = new Intl.NumberFormat("en-US", { style: "currency", currency: "EUR", minimumFractionDigits: 2, maximumFractionDigits: 2 });

// Below ten thousand every cent is shown; above it the compact form keeps the cell on one line.
export function formatMoney(units: string, currency: "USD" | "EUR"): string {
  const n = baseUnitsToNumber(units, 6);
  if (n < 10_000) return (currency === "USD" ? exactUsd : exactEur).format(n);
  return (currency === "USD" ? compactUsd : compactEur).format(n);
}

export function formatWadPercent(wad: string): string {
  const pct = baseUnitsToNumber(wad, 16);
  return `${Number.isInteger(pct) ? pct.toFixed(0) : pct.toFixed(2)}%`;
}

export function formatApy(apy: number): string {
  return `${(apy * 100).toFixed(2)}%`;
}

export function formatAge(seconds: number): string {
  const minutes = Math.max(0, Math.floor(seconds / 60));
  if (minutes < 1) return "UNDER A MIN AGO";
  if (minutes < 60) return `${minutes} MIN AGO`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} H AGO` : `${hours} H ${rest} MIN AGO`;
}

const wholeUsd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

export function formatUsdPrice(usd: number): string {
  return wholeUsd.format(usd);
}

export function formatAmount(units: string, currency: "USDC" | "EURC"): string {
  const n = baseUnitsToNumber(units, 6);
  const money = (currency === "USDC" ? exactUsd : exactEur).format(n);
  return `${money} ${currency}`;
}

const dateFormat = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export function formatDate(unixSeconds: number): string {
  return unixSeconds > 0 ? dateFormat.format(new Date(unixSeconds * 1000)) : "";
}
