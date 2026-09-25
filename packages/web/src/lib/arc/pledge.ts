import { encodeAbiParameters, getAddress, isAddressEqual, keccak256, zeroAddress, type Address, type Block, type Hex } from "viem";
import { adagAbi, BILL_STATUS_PAID, morphoAbi } from "./abi";
import { arcClient } from "./client";
import {
  ADAG_BILLS,
  ADAG_DEPLOY_BLOCK,
  ADAPTIVE_CURVE_IRM,
  CHAIN_ID,
  CIRBTC,
  EURC,
  EXPLORER,
  LOG_MAX_PAGES,
  LOG_PAGE_BLOCKS,
  MARKET_EURC,
  MARKET_USDC,
  MORPHO,
  USDC,
  USDC_MARKET_ORACLE,
  WAD,
} from "./constants";
import { adagPledgeAbi, oracleAbi } from "./pledgeAbi";

// ARCHITECTURE.md section 3. constants.ts does not carry it yet, and a fetched oracle address is never used in its place (C18).
const EURC_MARKET_ORACLE: Address = "0x6945246777DfdF4744D957323857F797Ec19Ca1e";

const BILL_STATUS_OPEN = 1;
const SCAN_LIMIT = 50;
const SHOWN = 3;
const SCAN_CHUNK = 10;
const ORACLE_SCALE = 10n ** 36n;
const SAT_PER_BTC = 10n ** 8n;

export type Currency = "USDC" | "EURC";

export type Cell<T> = { ok: true; value: T; source: string } | { ok: false; reason: string; source: string };

export type BillPayment = { txHash: string; logIndex: number; blockNumber: string; explorerUrl: string };

export type StageBill = {
  id: number;
  status: "paid" | "open";
  payee: string;
  currency: Currency;
  amountBaseUnits: string;
  due: number;
  createdAt: number;
  paidAt: number;
  // Plain text: decoded with replacement characters and stripped of direction controls (C14).
  reference: string;
  payment: BillPayment | null;
  paymentNote: "found" | "not-found" | "unavailable" | "open";
};

export type StageBills = {
  billCount: number;
  scanned: number;
  // "open" means no paid bill was found in the scan, so the stage shows the latest open ones and skips the stamps.
  mode: "paid" | "open" | "none";
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

function reasonOf(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage || e?.message || "The read failed.").split("\n")[0]!.slice(0, 160);
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

const DIRECTION_CONTROLS = /[؜‎‏‪-‮⁦-⁩]/g;
const CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F]/g;

export function plainReference(bytes: Hex): string {
  const raw = bytes.length > 2 ? Uint8Array.from(Buffer.from(bytes.slice(2), "hex")) : new Uint8Array();
  return new TextDecoder("utf-8", { fatal: false }).decode(raw).replace(DIRECTION_CONTROLS, "").replace(CONTROL_CHARS, " ");
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

function currencyOf(address: Address): Currency {
  if (isAddressEqual(address, USDC)) return "USDC";
  if (isAddressEqual(address, EURC)) return "EURC";
  throw new Error("A bill names a currency Adag does not support.");
}

let deployBlockPromise: Promise<Block> | null = null;
function deployBlock(): Promise<Block> {
  deployBlockPromise ??= arcClient.getBlock({ blockNumber: ADAG_DEPLOY_BLOCK }).catch((error: unknown) => {
    deployBlockPromise = null;
    throw error;
  });
  return deployBlockPromise;
}

const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);

// ARCHITECTURE.md section 5: the paying transaction is found in a window around paidAt, widening in bounded pages (C19).
async function findBillPaidLog(billId: bigint, paidAt: bigint, head: Block): Promise<BillPayment | null> {
  const deploy = await deployBlock();
  if (head.number === null || deploy.number === null) throw new Error("Block numbers missing.");
  const first = deploy.number;
  const last = head.number;
  const spanSeconds = head.timestamp - deploy.timestamp;
  if (spanSeconds <= 0n) throw new Error("Chain clock went backwards.");

  const estimateFrom = (anchorNumber: bigint, anchorTime: bigint) =>
    clamp(anchorNumber + ((paidAt - anchorTime) * (last - first)) / spanSeconds, first, last);
  let centre = estimateFrom(first, deploy.timestamp);
  const probe = await arcClient.getBlock({ blockNumber: centre });
  centre = estimateFrom(centre, probe.timestamp);

  const half = LOG_PAGE_BLOCKS / 2n;
  let low = clamp(centre - half, first, last);
  let high = clamp(centre + half - 1n, first, last);
  const windows: [bigint, bigint][] = [[low, high]];
  while (windows.length < LOG_MAX_PAGES && (low > first || high < last)) {
    if (high < last) {
      const from = high + 1n;
      high = clamp(from + LOG_PAGE_BLOCKS - 1n, first, last);
      windows.push([from, high]);
    }
    if (windows.length < LOG_MAX_PAGES && low > first) {
      const to = low - 1n;
      low = clamp(to - LOG_PAGE_BLOCKS + 1n, first, last);
      windows.push([low, to]);
    }
  }

  for (const [fromBlock, toBlock] of windows) {
    const logs = await arcClient.getContractEvents({
      address: ADAG_BILLS,
      abi: adagAbi,
      eventName: "BillPaid",
      args: { id: billId },
      fromBlock,
      toBlock,
      strict: true,
    });
    // C16: Adag's own event for this exact bill, tied to a transaction hash and log index.
    const match = logs.find(
      (log) => !log.removed && isAddressEqual(log.address, ADAG_BILLS) && log.args.id === billId && log.transactionHash !== null && log.logIndex !== null,
    );
    if (match) {
      return {
        txHash: match.transactionHash!,
        logIndex: match.logIndex!,
        blockNumber: String(match.blockNumber),
        explorerUrl: `${EXPLORER}/tx/${match.transactionHash}`,
      };
    }
  }
  return null;
}

type RawBill = Awaited<ReturnType<typeof readBill>>;
const readBill = (id: bigint) => arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [id] });

async function readStageBills(countRead: Promise<Settled<bigint>>, headRead: Promise<Settled<Block>>): Promise<StageBills> {
  const count = await need(countRead);
  const paid: { id: bigint; b: RawBill }[] = [];
  const open: { id: bigint; b: RawBill }[] = [];
  let scanned = 0;
  let next = count;

  while (next >= 1n && scanned < SCAN_LIMIT && paid.length < SHOWN) {
    const ids: bigint[] = [];
    while (ids.length < SCAN_CHUNK && next >= 1n && scanned + ids.length < SCAN_LIMIT) ids.push(next--);
    const read = await Promise.all(ids.map(readBill));
    scanned += ids.length;
    read.forEach((b, i) => {
      const id = ids[i]!;
      if (b.status === BILL_STATUS_PAID && paid.length < SHOWN) paid.push({ id, b });
      else if (b.status === BILL_STATUS_OPEN && open.length < SHOWN) open.push({ id, b });
    });
  }

  const mode: StageBills["mode"] = paid.length > 0 ? "paid" : open.length > 0 ? "open" : "none";
  const chosen = mode === "paid" ? paid : open;
  const head = mode === "paid" ? await headRead : null;

  const bills = await Promise.all(
    chosen.map(async ({ id, b }): Promise<StageBill> => {
      let payment: BillPayment | null = null;
      let paymentNote: StageBill["paymentNote"] = "open";
      if (b.status === BILL_STATUS_PAID) {
        try {
          if (!head || !head.ok) throw new Error("No head block.");
          payment = await findBillPaidLog(id, b.paidAt, head.value);
          paymentNote = payment ? "found" : "not-found";
        } catch {
          paymentNote = "unavailable";
        }
      }
      return {
        id: Number(id),
        status: b.status === BILL_STATUS_PAID ? "paid" : "open",
        payee: getAddress(b.payee),
        currency: currencyOf(getAddress(b.currency)),
        amountBaseUnits: b.amount.toString(),
        due: Number(b.due),
        createdAt: Number(b.createdAt),
        paidAt: Number(b.paidAt),
        reference: plainReference(b.ref),
        payment,
        paymentNote,
      };
    }),
  );

  return { billCount: Number(count), scanned, mode, bills };
}

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
  if (bills.value.bills.length === 0) throw new Error("No bills on Arc yet.");
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
  const count = settle(arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "billCount" }));
  const maxLtv = settle(arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "MAX_LTV_WAD" }));
  const usdcPrice = settle(arcClient.readContract({ address: USDC_MARKET_ORACLE, abi: oracleAbi, functionName: "price" }));

  const bills = cell<StageBills>(
    `AdagBills ${ADAG_BILLS} billCount(), then bill(id) walking down, at most ${SCAN_LIMIT} reads, the ${SHOWN} newest with status 2; BillPaid log by bill id around paidAt`,
    chain,
    () => readStageBills(count, head),
  );
  const pledge = cell<Pledge>(
    `AdagBills collateralNeeded(0x0000000000000000000000000000000000000000, market, sum of that market's bills) x 1.05 + 1 sat; oracle price() on ${USDC_MARKET_ORACLE} and ${EURC_MARKET_ORACLE}; MAX_LTV_WAD(); Morpho idToMarketParams(market).lltv; fall = 1 - ltv / lltv`,
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
