import type { BillPayment, Cell, Currency, MarketPledge, Pledge, PledgeSnapshot, StageBill, StageBills } from "@/lib/arc/pledge";

// Runs in the browser. Every field is checked, because a malformed answer must read "unavailable", never a wrong number (C19).

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isCurrency = (v: unknown): v is Currency => v === "USDC" || v === "EURC";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const DIRECTION_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

// Stripped again here so the page never trusts that the server did it (C14).
const plain = (s: string) => s.replace(DIRECTION_CONTROLS, "").replace(CONTROL_CHARS, " ").slice(0, 200);

function checkCell<T>(raw: unknown, read: (v: Record<string, unknown>) => T | null): Cell<T> {
  if (!isObj(raw) || typeof raw.source !== "string") return { ok: false, reason: "Malformed answer.", source: "" };
  if (raw.ok === true && isObj(raw.value)) {
    const value = read(raw.value);
    if (value !== null) return { ok: true, value, source: raw.source };
  }
  return { ok: false, reason: typeof raw.reason === "string" ? raw.reason.slice(0, 160) : "Malformed answer.", source: raw.source };
}

function readPayment(v: unknown): BillPayment | null | undefined {
  if (v === null) return null;
  if (!isObj(v) || typeof v.txHash !== "string" || !TX_HASH.test(v.txHash) || !isInt(v.logIndex) || !isDigits(v.blockNumber)) return undefined;
  // The link is rebuilt from the checked hash, so nothing else in the answer can steer where it points.
  return { txHash: v.txHash, logIndex: v.logIndex, blockNumber: v.blockNumber, explorerUrl: `https://explorer.arc.io/tx/${v.txHash}` };
}

function readBill(v: unknown): StageBill | null {
  if (!isObj(v)) return null;
  const payment = readPayment(v.payment);
  const notes = ["found", "not-found", "unavailable", "open"] as const;
  const note = notes.find((n) => n === v.paymentNote);
  if (
    !isInt(v.id) ||
    (v.status !== "paid" && v.status !== "open") ||
    typeof v.payee !== "string" ||
    !ADDRESS.test(v.payee) ||
    !isCurrency(v.currency) ||
    !isDigits(v.amountBaseUnits) ||
    !isInt(v.due) ||
    !isInt(v.createdAt) ||
    !isInt(v.paidAt) ||
    typeof v.reference !== "string" ||
    payment === undefined ||
    !note
  )
    return null;
  return {
    id: v.id,
    status: v.status,
    payee: v.payee,
    currency: v.currency,
    amountBaseUnits: v.amountBaseUnits,
    due: v.due,
    createdAt: v.createdAt,
    paidAt: v.paidAt,
    reference: plain(v.reference),
    payment: v.status === "paid" ? payment : null,
    paymentNote: note,
  };
}

function readBills(v: Record<string, unknown>): StageBills | null {
  if (!isInt(v.billCount) || !isInt(v.scanned) || !Array.isArray(v.bills) || v.bills.length > 3) return null;
  if (v.mode !== "paid" && v.mode !== "open" && v.mode !== "none") return null;
  const bills = v.bills.map(readBill);
  if (bills.some((b) => b === null)) return null;
  const list = bills as StageBill[];
  if (new Set(list.map((b) => b.id)).size !== list.length) return null;
  if (list.some((b) => b.status !== (v.mode === "paid" ? "paid" : "open"))) return null;
  return { billCount: v.billCount, scanned: v.scanned, mode: v.mode, bills: list };
}

function readMarket(v: unknown): MarketPledge | null {
  if (!isObj(v) || !isCurrency(v.currency) || typeof v.marketId !== "string") return null;
  const digits = ["billsBaseUnits", "collateralNeededSat", "pledgeSat", "oraclePrice", "collateralValueBaseUnits", "ltvWad", "independentSat"] as const;
  if (digits.some((k) => !isDigits(v[k]))) return null;
  if (v.fresh !== null && typeof v.fresh !== "boolean") return null;
  if (typeof v.agrees !== "boolean") return null;
  return v as unknown as MarketPledge;
}

function readPledge(v: Record<string, unknown>): Pledge | null {
  if (!Array.isArray(v.markets) || v.markets.length === 0 || v.markets.length > 2) return null;
  const markets = v.markets.map(readMarket);
  if (markets.some((m) => m === null)) return null;
  const digits = ["totalPledgeSat", "headlineLtvWad", "maxLtvWad", "lltvWad"] as const;
  if (digits.some((k) => !isDigits(v[k]))) return null;
  if (v.totalValueUsdBaseUnits !== null && !isDigits(v.totalValueUsdBaseUnits)) return null;
  if (v.usdPerBtcBaseUnits !== null && !isDigits(v.usdPerBtcBaseUnits)) return null;
  if (!isNum(v.fallToLiquidation) || v.fallToLiquidation > 1 || typeof v.margin !== "string") return null;
  return {
    markets: markets as MarketPledge[],
    totalPledgeSat: v.totalPledgeSat as string,
    totalValueUsdBaseUnits: v.totalValueUsdBaseUnits as string | null,
    usdPerBtcBaseUnits: v.usdPerBtcBaseUnits as string | null,
    headlineLtvWad: v.headlineLtvWad as string,
    maxLtvWad: v.maxLtvWad as string,
    lltvWad: v.lltvWad as string,
    fallToLiquidation: v.fallToLiquidation,
    margin: v.margin,
  };
}

export function parsePledge(raw: unknown): PledgeSnapshot | null {
  if (!isObj(raw) || raw.chainId !== 5042 || typeof raw.fetchedAt !== "string") return null;
  return {
    fetchedAt: raw.fetchedAt,
    chainId: 5042,
    blockNumber: isDigits(raw.blockNumber) ? raw.blockNumber : null,
    bills: checkCell(raw.bills, readBills),
    pledge: checkCell(raw.pledge, readPledge),
  };
}
