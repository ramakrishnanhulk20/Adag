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

export type LiveSnapshot = {
  fetchedAt: string;
  chainId: number;
  blockNumber: string | null;
  liquidity: Cell<Liquidity>;
  borrowRate: Cell<BorrowRate>;
  loanCap: Cell<LoanCap>;
  paid: Cell<PaidThroughAdag>;
  price: Cell<PriceStatus>;
};
