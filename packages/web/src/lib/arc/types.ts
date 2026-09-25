// What /api/live returns. Every cell stands alone: one failed read marks only its own cell unavailable (C19).
// Integers stay as base-unit strings end to end; only the display layer formats them (C15).

export type Cell<T> =
  | { ok: true; value: T; source: string }
  | { ok: false; reason: string; source: string };

export type Liquidity = {
  usdcBaseUnits: string;
  // null when only the EURC market read failed; the USDC figure still stands.
  eurcBaseUnits: string | null;
};

export type BorrowRate = {
  perSecondWad: string;
  apy: number;
};

export type LoanCap = {
  maxLtvWad: string;
  morphoLltvWad: string | null;
};

export type PaidThroughAdag = {
  billCount: number;
  billsPaid: number;
  usdcBaseUnits: string;
  eurcBaseUnits: string;
  latestPayment: { billId: number; txHash: string; logIndex: number; blockNumber: string; explorerUrl: string } | null;
  latestPaymentNote: "found" | "none" | "not-found" | "unavailable";
};

export type PriceStatus = {
  fresh: boolean;
  btcUsdUpdatedAt: number;
  ageSeconds: number;
};

// Dollars per whole cirBTC from the USDC market's oracle. Display only, never a transaction input (C18).
export type BtcPrice = {
  usdPerCirbtc: number;
};

export type BillTx = { txHash: string; logIndex: number; explorerUrl: string };

export type LedgerBill = {
  id: number;
  payee: string;
  currency: "USDC" | "EURC";
  amountBaseUnits: string;
  // 1 Open, 2 Paid, 3 Void, as AdagBills stores it.
  status: 1 | 2 | 3;
  due: number;
  createdAt: number;
  paidAt: number;
  // The reference exactly as stored: raw bytes as hex. Only the display layer turns it into text (C14).
  refHex: string;
  // Paid bills link their BillPaid transaction; open or void ones link the BillCreated transaction.
  tx: BillTx | null;
  txKind: "paid" | "created";
  txNote: "found" | "not-found" | "unavailable";
};

export type LatestBills = {
  billCount: number;
  bills: LedgerBill[];
};

export type LiveSnapshot = {
  fetchedAt: string;
  chainId: number;
  blockNumber: string | null;
  liquidity: Cell<Liquidity>;
  borrowRate: Cell<BorrowRate>;
  loanCap: Cell<LoanCap>;
  paid: Cell<PaidThroughAdag>;
  price: Cell<PriceStatus>;
  btcPrice: Cell<BtcPrice>;
  latestBills: Cell<LatestBills>;
};
