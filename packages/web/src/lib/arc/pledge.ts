import { encodeAbiParameters, isAddressEqual, keccak256, zeroAddress, type Address } from "viem";
import { ADAG_BILLS, ADAG_BILLS_FIRST, EURC_MARKET_ORACLE } from "../pay/constants";
import { adagAbi, morphoAbi } from "./abi";
import { arcClient } from "./client";
import { ADAPTIVE_CURVE_IRM, CHAIN_ID, CIRBTC, EURC, EXPLORER, MARKET_EURC, MARKET_USDC, MORPHO, USDC, USDC_MARKET_ORACLE, WAD } from "./constants";
import { readPaid, type PaidRead } from "./paidIndex";
import { adagPledgeAbi, oracleAbi } from "./pledgeAbi";

const SHOWN = 3;
const ORACLE_SCALE = 10n ** 36n;
const SAT_PER_BTC = 10n ** 8n;

export type Currency = "USDC" | "EURC";

export type Cell<T> = { ok: true; value: T; source: string } | { ok: false; reason: string; source: string };

export type BillPayment = { txHash: string; logIndex: number; blockNumber: string; explorerUrl: string };

// A paid bill on the stage, exactly as its BillPaid event records it (C16). There is no reference field: the stage
// never carries words a stranger wrote into a bill (security pass 1, M2).
export type StageBill = {
  // Unique across both AdagBills deployments, which each have their own bill #1.
  key: string;
  contract: string;
  first: boolean;
  id: string;
  payee: string;
  payer: string;
  currency: Currency;
  amountBaseUnits: string;
  paidAt: number;
  loanChecked: boolean;
  payment: BillPayment;
};

export type StageBills = {
  billsPaid: number;
  source: "index" | "direct";
  throughBlock: string;
  note: string | null;
  // "none" means no bill has been paid yet: the stage then shows no bill at all, never an open one.
  mode: "paid" | "none";
  bills: StageBill[];
};

export type MarketPledge = {
  currency: Currency;
  marketId: string;
  billsBaseUnits: string;
  collateralNeededSat: string;
  pledgeSat: string;
  oraclePrice: string;
  collateralValueBaseUnits: string;
  ltvWad: string;
  fresh: boolean | null;
  // The contract's answer recomputed here from the oracle price and the 40% cap, as a cross-check.
  independentSat: string;
  agrees: boolean;
};

export type Pledge = {
  markets: MarketPledge[];
  totalPledgeSat: string;
  totalValueUsdBaseUnits: string | null;
  usdPerBtcBaseUnits: string | null;
  headlineLtvWad: string;
  maxLtvWad: string;
  lltvWad: string;
  fallToLiquidation: number;
  margin: string;
};

export type PledgeSnapshot = {
  fetchedAt: string;
  chainId: number;
  blockNumber: string | null;
  bills: Cell<StageBills>;
  pledge: Cell<Pledge>;
};

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

const settle = <T>(p: Promise<T>): Promise<Settled<T>> =>
  p.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );

async function need<T>(p: Promise<Settled<T>>): Promise<T> {
  const r = await p;
  if (!r.ok) throw r.error;
  return r.value;
}

// C62: only a sentence this code wrote reaches the page. viem wraps every RPC failure in its own error type, whose
// text can hold a node's words, so those become a fixed sentence and their short message goes to the log instead.
function reasonOf(error: unknown): string {
  if (error instanceof Error && error.constructor === Error && !("shortMessage" in error)) return error.message.split("\n")[0]!.slice(0, 160);
  const e = error as { shortMessage?: string; name?: string } | undefined;
  console.warn(`Arc read failed: ${e?.shortMessage ?? e?.name ?? "unknown"}`);
  return "Arc did not answer. Try again in a moment.";
}

async function cell<T>(source: string, chain: Promise<Settled<number>>, run: () => Promise<T>): Promise<Cell<T>> {
  try {
    const id = await need(chain);
    if (id !== CHAIN_ID) throw new Error(`The RPC answered for chain ${id}, not Arc mainnet (${CHAIN_ID}).`);
    return { ok: true, value: await run(), source };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), source };
  }
}

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

type ParamsTuple = readonly [Address, Address, Address, Address, bigint];

const MARKETS = {
  USDC: { id: MARKET_USDC, token: USDC, oracle: USDC_MARKET_ORACLE },
  EURC: { id: MARKET_EURC, token: EURC, oracle: EURC_MARKET_ORACLE },
} as const;

// The params only feed a display figure here, but they are still held to the fixed market id and constants (C12).
function verifiedLltv(currency: Currency, p: ParamsTuple): bigint {
  const m = MARKETS[currency];
  const id = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], p),
  );
  const [loanToken, collateralToken, oracle, irm, lltv] = p;
  const matches =
    id.toLowerCase() === m.id.toLowerCase() &&
    isAddressEqual(loanToken, m.token) &&
    isAddressEqual(collateralToken, CIRBTC) &&
    isAddressEqual(oracle, m.oracle) &&
    isAddressEqual(irm, ADAPTIVE_CURVE_IRM);
  if (!matches) throw new Error(`Morpho's ${currency} market params do not match the fixed market.`);
  if (lltv <= 0n || lltv >= WAD) throw new Error("Morpho returned an impossible liquidation line.");
  return lltv;
}

function stageBillsOf(paid: PaidRead): StageBills {
  const bills = paid.latest.slice(0, SHOWN).map((r): StageBill => {
    const first = isAddressEqual(r.contract, ADAG_BILLS_FIRST);
    return {
      key: `${first ? "first" : "current"}:${r.id}`,
      contract: r.contract,
      first,
      id: r.id.toString(),
      payee: r.payee,
      payer: r.payer,
      currency: isAddressEqual(r.currency, USDC) ? "USDC" : "EURC",
      amountBaseUnits: r.amount.toString(),
      paidAt: Number(r.paidAt),
      loanChecked: r.loanChecked,
      payment: { txHash: r.txHash, logIndex: r.logIndex, blockNumber: r.blockNumber.toString(), explorerUrl: `${EXPLORER}/tx/${r.txHash}` },
    };
  });
  return {
    billsPaid: paid.totals.count,
    source: paid.source,
    throughBlock: paid.throughBlock.toString(),
    note: paid.note,
    mode: bills.length > 0 ? "paid" : "none",
    bills,
  };
}

// collateralNeeded and priceStatus come from the current AdagBills, the one every new payment goes through.
async function readMarketPledge(currency: Currency, bills: bigint, maxLtv: bigint): Promise<MarketPledge & { lltv: bigint }> {
  const m = MARKETS[currency];
  const [needed, price, params, status] = await Promise.all([
    arcClient.readContract({ address: ADAG_BILLS, abi: adagPledgeAbi, functionName: "collateralNeeded", args: [zeroAddress, m.id, bills] }),
    arcClient.readContract({ address: m.oracle, abi: oracleAbi, functionName: "price" }),
    arcClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [m.id] }),
    settle(arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [m.id] })),
  ]);
  if (needed === 0n) throw new Error("collateralNeeded returned 0 for a wallet with no position.");
  if (price === 0n) throw new Error("The oracle reads 0.");
  const lltv = verifiedLltv(currency, params);

  // Same two ceilings as AdagBills.collateralNeeded, so the page can say whether the chain and the formula agree.
  const independent = ceilDiv(ceilDiv(bills * WAD, maxLtv) * ORACLE_SCALE, price);
  // C13: 5% margin, rounded up, plus one satoshi for Morpho's share rounding.
  const pledge = ceilDiv(needed * 105n, 100n) + 1n;
  const value = (pledge * price) / ORACLE_SCALE;
  if (value === 0n) throw new Error("The pledge has no value at the oracle price.");
  const ltv = ceilDiv(bills * WAD, value);

  return {
    currency,
    marketId: m.id,
    billsBaseUnits: bills.toString(),
    collateralNeededSat: needed.toString(),
    pledgeSat: pledge.toString(),
    oraclePrice: price.toString(),
    collateralValueBaseUnits: value.toString(),
    ltvWad: ltv.toString(),
    fresh: status.ok ? status.value[0] : null,
    independentSat: independent.toString(),
    agrees: (independent > needed ? independent - needed : needed - independent) <= 1n,
    lltv,
  };
}

async function readPledge(stage: Promise<Cell<StageBills>>, maxLtvRead: Promise<Settled<bigint>>, usdcPriceRead: Promise<Settled<bigint>>): Promise<Pledge> {
  const bills = await stage;
  if (!bills.ok) throw new Error("The bills could not be read, so there is nothing to pledge for.");
  if (bills.value.bills.length === 0) throw new Error("No bill has been paid on Arc yet.");
  const maxLtv = await need(maxLtvRead);
  if (maxLtv <= 0n || maxLtv >= WAD) throw new Error("AdagBills returned an impossible loan cap.");

  const sums: Record<Currency, bigint> = { USDC: 0n, EURC: 0n };
  for (const b of bills.value.bills) sums[b.currency] += BigInt(b.amountBaseUnits);
  const used = (Object.keys(sums) as Currency[]).filter((c) => sums[c] > 0n);
  const markets = await Promise.all(used.map((c) => readMarketPledge(c, sums[c], maxLtv)));

  const totalPledge = markets.reduce((t, m) => t + BigInt(m.pledgeSat), 0n);
  const usdcPrice = await usdcPriceRead;
  const usdPrice = usdcPrice.ok && usdcPrice.value > 0n ? usdcPrice.value : null;
  // The riskiest market sets the headline, so the distance to Morpho's line is never overstated.
  const worst = markets.reduce((a, b) => (BigInt(b.ltvWad) * a.lltv > BigInt(a.ltvWad) * b.lltv ? b : a));
  const fall = 1 - Number((BigInt(worst.ltvWad) * 1_000_000n) / worst.lltv) / 1_000_000;

  return {
    markets: markets.map(({ lltv: _lltv, ...m }) => m),
    totalPledgeSat: totalPledge.toString(),
    totalValueUsdBaseUnits: usdPrice ? ((totalPledge * usdPrice) / ORACLE_SCALE).toString() : null,
    usdPerBtcBaseUnits: usdPrice ? ((SAT_PER_BTC * usdPrice) / ORACLE_SCALE).toString() : null,
    headlineLtvWad: worst.ltvWad,
    maxLtvWad: maxLtv.toString(),
    lltvWad: worst.lltv.toString(),
    fallToLiquidation: fall,
    margin: "ceil(collateralNeeded x 1.05) + 1 satoshi",
  };
}

export async function readPledgeStage(): Promise<PledgeSnapshot> {
  const chain = settle(arcClient.getChainId());
  const head = settle(arcClient.getBlock());
  const maxLtv = settle(arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "MAX_LTV_WAD" }));
  const usdcPrice = settle(arcClient.readContract({ address: USDC_MARKET_ORACLE, abi: oracleAbi, functionName: "price" }));
  const paid = settle(readPaid());

  const bills = cell<StageBills>(
    `The ${SHOWN} newest paid bills from the BillPaid events of AdagBills ${ADAG_BILLS} and of the first deployment ${ADAG_BILLS_FIRST}; no reference is read`,
    chain,
    async () => stageBillsOf(await need(paid)),
  );
  const pledge = cell<Pledge>(
    `AdagBills ${ADAG_BILLS} collateralNeeded(0x0000000000000000000000000000000000000000, market, sum of that market's bills) x 1.05 + 1 sat; oracle price() on ${USDC_MARKET_ORACLE} and ${EURC_MARKET_ORACLE}; MAX_LTV_WAD(); Morpho idToMarketParams(market).lltv; fall = 1 - ltv / lltv`,
    chain,
    () => readPledge(bills, maxLtv, usdcPrice),
  );

  const [billsCell, pledgeCell, headResult] = await Promise.all([bills, pledge, head]);
  return {
    fetchedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    blockNumber: headResult.ok && headResult.value.number !== null ? String(headResult.value.number) : null,
    bills: billsCell,
    pledge: pledgeCell,
  };
}
