import type { BillPayment, Cell, Currency, MarketPledge, Pledge, PledgeSnapshot, StageBill, StageBills } from "@/lib/arc/pledge";
import { deploymentOf } from "@/lib/pay/constants";

// Runs in the browser. Every field is checked, because a malformed answer must read "unavailable", never a wrong number (C19).

const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d{1,78}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown): v is number => isNum(v) && Number.isInteger(v) && v >= 0;
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isCurrency = (v: unknown): v is Currency => v === "USDC" || v === "EURC";
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const TX_HASH = /^0x[0-9a-fA-F]{64}$/;
const BILL_ID = /^[1-9]\d{0,77}$/;

function checkCell<T>(raw: unknown, read: (v: Record<string, unknown>) => T | null): Cell<T> {
  if (!isObj(raw) || typeof raw.source !== "string") return { ok: false, reason: "Malformed answer.", source: "" };
  if (raw.ok === true && isObj(raw.value)) {
    const value = read(raw.value);
    if (value !== null) return { ok: true, value, source: raw.source };
  }
  return { ok: false, reason: typeof raw.reason === "string" ? raw.reason.slice(0, 160) : "Malformed answer.", source: raw.source };
}

function readPayment(v: unknown): BillPayment | null {
  if (!isObj(v) || typeof v.txHash !== "string" || !TX_HASH.test(v.txHash) || !isInt(v.logIndex) || !isDigits(v.blockNumber)) return null;
  // The link is rebuilt from the checked hash, so nothing else in the answer can steer where it points.
  return { txHash: v.txHash, logIndex: v.logIndex, blockNumber: v.blockNumber, explorerUrl: `https://explorer.arc.io/tx/${v.txHash}` };
}

// The contract must be one of Adag's two, and the key and the "first" mark must agree with it (C18).
function readBill(v: unknown): StageBill | null {
  if (!isObj(v) || typeof v.contract !== "string" || !ADDRESS.test(v.contract)) return null;
  const deployment = deploymentOf(v.contract);
  const payment = readPayment(v.payment);
  if (
    !deployment ||
    !payment ||
    typeof v.id !== "string" ||
    !BILL_ID.test(v.id) ||
    v.first !== (deployment.label === "first") ||
    v.key !== `${deployment.label}:${v.id}` ||
    typeof v.payee !== "string" ||
    !ADDRESS.test(v.payee) ||
    typeof v.payer !== "string" ||
    !ADDRESS.test(v.payer) ||
    !isCurrency(v.currency) ||
    !isDigits(v.amountBaseUnits) ||
    !isInt(v.paidAt) ||
    typeof v.loanChecked !== "boolean"
  )
    return null;
  return {
    key: v.key,
    contract: deployment.address,
    first: v.first,
    id: v.id,
    payee: v.payee,
    payer: v.payer,
    currency: v.currency,
    amountBaseUnits: v.amountBaseUnits,
    paidAt: v.paidAt,
    loanChecked: v.loanChecked,
    payment,
  };
}

function readBills(v: Record<string, unknown>): StageBills | null {
  if (!isInt(v.billsPaid) || !Array.isArray(v.bills) || v.bills.length > 3 || !isDigits(v.throughBlock)) return null;
  if (v.mode !== "paid" && v.mode !== "none") return null;
  if (v.source !== "index" && v.source !== "direct") return null;
  if (v.note !== null && (typeof v.note !== "string" || v.note.length > 200)) return null;
  const bills = v.bills.map(readBill);
  if (bills.some((b) => b === null)) return null;
  const list = bills as StageBill[];
  if (new Set(list.map((b) => b.key)).size !== list.length) return null;
  if ((v.mode === "paid") !== list.length > 0) return null;
  return { billsPaid: v.billsPaid, source: v.source, throughBlock: v.throughBlock, note: v.note as string | null, mode: v.mode, bills: list };
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
