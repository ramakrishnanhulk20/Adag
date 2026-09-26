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
  // Bills written on both AdagBills deployments together.
  billCount: number;
  billsPaid: number;
  usdcBaseUnits: string;
  eurcBaseUnits: string;
  latestPayment: { billId: number; txHash: string; logIndex: number; blockNumber: string; explorerUrl: string } | null;
  latestPaymentNote: "found" | "none" | "not-found" | "unavailable";
  // "index": the BillPaid index in the server store; "direct": the newest bills read straight from Arc.
  source: "index" | "direct";
  throughBlock: string;
  note: string | null;
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

// One payment, exactly as its BillPaid event records it (C16). There is deliberately no reference here: the home page
// never shows words a stranger wrote into a bill (security pass 1, M2).
export type PaidEntry = {
  contract: string;
  // True for the first AdagBills deployment, whose bills open at /bill/first/N.
  first: boolean;
  id: string;
  currency: "USDC" | "EURC";
  amountBaseUnits: string;
  payer: string;
  payee: string;
  txHash: string;
  logIndex: number;
  blockNumber: string;
  paidAt: number;
  loanChecked: boolean;
  explorerUrl: string;
};

// The live proof bill the "Check it yourself" strip talks about: bill #1 on the current AdagBills. Every fact the
// strip states comes from bill(1) and that bill's own BillPaid event, read on each snapshot.
export type ProofBill = {
  id: string;
  // 1 Open, 2 Paid, 3 Void, as AdagBills stores it.
  status: 1 | 2 | 3;
  currency: "USDC" | "EURC";
  amountBaseUnits: string;
  paidAt: number;
  payment: { txHash: string; logIndex: number; blockNumber: string; explorerUrl: string; loanChecked: boolean } | null;
  paymentNote: "found" | "not-paid" | "not-found";
};

export type LatestBills = {
  billsPaid: number;
  bills: PaidEntry[];
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
  proof: Cell<ProofBill>;
};
