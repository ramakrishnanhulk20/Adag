import { isAddressEqual, type Address } from "viem";
import { adagAbi, erc20Abi, morphoAbi, oracleAbi } from "@/lib/pay/abi";
import { suggestPledge, type Batch } from "@/lib/pay/build";
import { CIRBTC, CURRENCIES, FX_GAS_CAP, MORPHO, USDC, requireDeployment, type Currency } from "@/lib/pay/constants";
import { formatUnitsExact } from "@/lib/pay/format";
import { lendCovers, readyToLend } from "@/lib/pay/lend";
import { debtFromShares, liquidationDropWad, ltvWad } from "@/lib/pay/loan";
import { EstimateError, amountToSell, loanCurrencyFor, readEurUsd, readLoanPriceFresh, worstCaseRate, type CurrencySymbol, type EurUsdReading } from "@/lib/fx/estimate";
import { checkAdapterPreflight, type Preflight } from "@/lib/fx/preflight";
import { EFFECTS_UNAVAILABLE, feesNow, publicArc } from "@/lib/wallet/send";

// One sentence for the screens' early warning and for the sender's refusal, so they cannot drift apart.
export { EFFECTS_UNAVAILABLE };

export type MarketState = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
export type Position = readonly [bigint, bigint, bigint];

// The cushion over the euro price that every conversion screen sizes the amount with, in basis points. It is fixed on
// purpose: a refusal from Circle never raises it, the payer presses again and sees the same figures (C70). The ceiling
// the builder enforces is 1.5%, so this leaves room under it.
export const CONVERT_BUFFER_BPS = 100n;
export const CIRCLE_FEE_BPS = 2n;

export const SAFE_CONVERT_LINE = "Converting is not available for Safe payments: Circle's quotes last 10 minutes and a Safe's owners sign later.";
export const TOO_LARGE = "This conversion is too large for one payment. Pay part from your balance or split the bill.";

const money = (v: bigint, symbol: string) => `${formatUnitsExact(v, 6)} ${symbol}`;

export const reasons = {
  otherConverts: (otherBill: string) =>
    `The ${otherBill} bills in this basket are already paid by converting. One signature runs one conversion, and never one in each direction.`,
  loanPaused: (loan: string) => `New ${loan} loans are paused until the bitcoin price updates, so borrowing ${loan} is off. Paying in the bill's own currency still works.`,
  loanUnknown: (loan: string) => `Adag could not read whether new ${loan} loans are open right now, so converting is off. Try again in a moment.`,
  cash: (ready: bigint, need: bigint, loan: string) =>
    `Morpho has ${money(ready, loan)} ready to lend right now, less than the ${money(need, loan)} this conversion borrows. Pay another way, or check back later.`,
  closeShort: (held: bigint, need: bigint, sold: string) => `You hold ${money(held, sold)}, and closing this way needs ${money(need, sold)}.`,
};

// What Circle's swap costs in its own words, worked out from the amount sold: 0.02%, rounded up.
const circleFee = (amountIn: bigint) => (amountIn * CIRCLE_FEE_BPS + 9_999n) / 10_000n;

// USD value of an amount of EURC at the euro price AdagBills reads, or the amount itself for USDC (6 decimals both).
export function dollarValue(amount: bigint, symbol: CurrencySymbol, eur: EurUsdReading): bigint {
  return symbol === "USDC" ? amount : (amount * eur.answer) / 10n ** BigInt(eur.decimals);
}

// 1 sold returns at least this many bought, from the plan's guaranteed minimum over what is sold.
export function rateText(total: bigint, amountIn: bigint, sold: string, bought: string): string {
  const rate = worstCaseRate(total, amountIn) / 10n ** 12n;
  return `1 ${sold} returns at least ${formatUnitsExact(rate, 6, 4)} ${bought}`;
}

export type BillConvertRead =
  | { state: "off"; reason: string }
  | {
      state: "ok";
      billSymbol: CurrencySymbol;
      loan: Currency;
      total: bigint;
      amountIn: bigint;
      eur: EurUsdReading;
      chainTime: bigint;
      blockNumber: bigint;
      loanFresh: boolean | null;
      preflight: Preflight;
      market: MarketState;
      position: Position;
      price: bigint;
      // collateralNeeded for this conversion's borrow alone, and for it together with the other group's loan when both
      // borrow in the same market (C69). null when there is no other group.
      neededAlone: bigint;
      neededWithOther: bigint | null;
      otherTotal: bigint;
      cirBtc: bigint;
      loanBalance: bigint;
      keepUpTo: bigint;
    };

// Everything the option shows, read once. The euro price, the loan market's totals, position and price, the pledge
// the contract asks for and the balances all come from one block (the euro price read pins it). The adapter's allowances,
// the loan market's price status and the fee ceiling are read as the code allows, at the latest block.
export async function readBillConvert(
  client: ReturnType<typeof publicArc>,
  a: { payer: Address; contract: string; billSymbol: CurrencySymbol; total: bigint; otherTotal: bigint },
): Promise<BillConvertRead> {
  const loan = loanCurrencyFor(a.billSymbol);
  let eur: Awaited<ReturnType<typeof readEurUsd>>;
  try {
    eur = await readEurUsd(client);
  } catch (error) {
    if (error instanceof EstimateError) return { state: "off", reason: error.message };
    throw error;
  }
  const amountIn = amountToSell(a.total, a.billSymbol, eur.reading, CONVERT_BUFFER_BPS);
  const at = eur.blockNumber;
  const { address } = requireDeployment(a.contract);
  const [neededAlone, neededWithOther, market, position, price, cirBtc, loanBalance, loanFresh, preflight, fees] = await Promise.all([
    client.readContract({ address, abi: adagAbi, functionName: "collateralNeeded", args: [a.payer, loan.marketId, amountIn], blockNumber: at }),
    a.otherTotal > 0n
      ? client.readContract({ address, abi: adagAbi, functionName: "collateralNeeded", args: [a.payer, loan.marketId, amountIn + a.otherTotal], blockNumber: at })
      : Promise.resolve(null),
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [loan.marketId], blockNumber: at }),
    client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [loan.marketId, a.payer], blockNumber: at }),
    client.readContract({ address: loan.params.oracle, abi: oracleAbi, functionName: "price", blockNumber: at }),
    client.readContract({ address: CIRBTC, abi: erc20Abi, functionName: "balanceOf", args: [a.payer], blockNumber: at }),
    client.readContract({ address: loan.address, abi: erc20Abi, functionName: "balanceOf", args: [a.payer], blockNumber: at }),
    readLoanPriceFresh(client, a.contract, a.billSymbol),
    checkAdapterPreflight(client, a.payer, loan.address),
    feesNow(),
  ]);
  return {
    state: "ok",
    billSymbol: a.billSymbol,
    loan,
    total: a.total,
    amountIn,
    eur: eur.reading,
    chainTime: eur.chainTime,
    blockNumber: at,
    loanFresh,
    preflight,
    market,
    position,
    price,
    neededAlone,
    neededWithOther,
    otherTotal: a.otherTotal,
    cirBtc,
    loanBalance,
    keepUpTo: fees.maxFeePerGas * FX_GAS_CAP,
  };
}

export type ConvertContext = {
  // The other group in the basket is paid by converting, so this one cannot be (one conversion, one direction).
  otherConverts: boolean;
  otherBill: CurrencySymbol | null;
  // What the other group borrows in this loan market when it is paid from bitcoin; 0 when it is not (C69).
  sharedBorrow: bigint;
};

export type Estimate = {
  billSymbol: CurrencySymbol;
  loan: Currency;
  bill: Currency;
  total: bigint;
  amountIn: bigint;
  usd: bigint;
  fee: bigint;
  pledge: bigint;
  sharedBorrow: bigint;
  ltvAfter: bigint;
  drop: bigint;
  ready: bigint;
  keepUpTo: bigint;
  blockNumber: bigint;
  cirBtc: bigint;
  loanBalance: bigint;
  eur: EurUsdReading;
};

// A conversion that is shown but cannot be chosen: the one sentence that says why, and, when Circle's adapter already
// holds access to the wallet, the batch that takes it back.
export type Off = { kind: "off"; reason: string; reset?: Batch };
export type ConvertView = Off | { kind: "ready"; estimate: Estimate };

const off = (reason: string, reset?: Batch): Off => (reset ? { kind: "off", reason, reset } : { kind: "off", reason });

const currencyBySymbol = (symbol: CurrencySymbol): Currency => {
  const found = CURRENCIES.find((c) => c.symbol === symbol);
  if (!found) throw new Error("The bill currency is not one Adag supports.");
  return found;
};

// Whether a conversion is offered, with the one sentence that says why not, or the figures it would run on (C69, C70).
export function billConvertView(read: BillConvertRead, ctx: ConvertContext): ConvertView {
  if (read.state === "off") return off(read.reason);
  const loan = read.loan.symbol;
  if (ctx.otherConverts) return off(reasons.otherConverts(ctx.otherBill ?? "other"));
  if (read.loanFresh === false) return off(reasons.loanPaused(loan));
  if (read.loanFresh === null) return off(reasons.loanUnknown(loan));
  if (read.preflight.state === "unreadable") return off(read.preflight.text);
  if (read.preflight.state === "blocked") return off(read.preflight.blockers.join(" "), read.preflight.reset);
  const borrowTotal = read.amountIn + ctx.sharedBorrow;
  const ready = readyToLend(read.market);
  if (!lendCovers(ready, borrowTotal)) return off(reasons.cash(ready, borrowTotal, loan));
  const needed = ctx.sharedBorrow > 0n ? read.neededWithOther : read.neededAlone;
  if (needed === null) return off("Adag could not size the pledge for this conversion, so it is off. Try again in a moment.");
  const pledge = suggestPledge(needed);
  const debt = debtFromShares(read.position[1], read.market[2], read.market[3]) + borrowTotal;
  const ltvAfter = ltvWad(debt, read.position[2] + pledge, read.price);
  return {
    kind: "ready",
    estimate: {
      billSymbol: read.billSymbol,
      loan: read.loan,
      bill: currencyBySymbol(read.billSymbol),
      total: read.total,
      amountIn: read.amountIn,
      usd: dollarValue(read.amountIn, loan, read.eur),
      fee: circleFee(read.amountIn),
      pledge,
      sharedBorrow: ctx.sharedBorrow,
      ltvAfter,
      drop: liquidationDropWad(ltvAfter, read.loan.params.lltv),
      ready,
      keepUpTo: read.keepUpTo,
      blockNumber: read.blockNumber,
      cirBtc: read.cirBtc,
      loanBalance: read.loanBalance,
      eur: read.eur,
    },
  };
}

export type CloseConvertRead =
  | { state: "off"; reason: string }
  | {
      state: "ok";
      loan: Currency;
      sold: Currency;
      approval: bigint;
      amountIn: bigint;
      eur: EurUsdReading;
      chainTime: bigint;
      blockNumber: bigint;
      preflight: Preflight;
      soldBalance: bigint;
      keepUpTo: bigint;
    };

// The same read for closing a loan with the other currency (C75): the amount of that currency to sell for at least the
// close approval, what the wallet holds of it, and what Circle's adapter may already do with the wallet.
export async function readCloseConvert(client: ReturnType<typeof publicArc>, a: { payer: Address; loan: Currency; approval: bigint }): Promise<CloseConvertRead> {
  const sold = loanCurrencyFor(a.loan.symbol);
  let eur: Awaited<ReturnType<typeof readEurUsd>>;
  try {
    eur = await readEurUsd(client);
  } catch (error) {
    if (error instanceof EstimateError) return { state: "off", reason: error.message };
    throw error;
  }
  const amountIn = amountToSell(a.approval, a.loan.symbol, eur.reading, CONVERT_BUFFER_BPS);
  const [soldBalance, preflight, fees] = await Promise.all([
    client.readContract({ address: sold.address, abi: erc20Abi, functionName: "balanceOf", args: [a.payer], blockNumber: eur.blockNumber }),
    checkAdapterPreflight(client, a.payer, sold.address),
    feesNow(),
  ]);
  return { state: "ok", loan: a.loan, sold, approval: a.approval, amountIn, eur: eur.reading, chainTime: eur.chainTime, blockNumber: eur.blockNumber, preflight, soldBalance, keepUpTo: fees.maxFeePerGas * FX_GAS_CAP };
}

export type CloseEstimate = {
  loan: Currency;
  sold: Currency;
  approval: bigint;
  amountIn: bigint;
  usd: bigint;
  fee: bigint;
  keepUpTo: bigint;
  blockNumber: bigint;
  soldBalance: bigint;
};

export type CloseView = Off | { kind: "ready"; estimate: CloseEstimate };

const UNIT = 10n ** 12n;

export function closeConvertView(read: CloseConvertRead): CloseView {
  if (read.state === "off") return off(read.reason);
  if (read.preflight.state === "unreadable") return off(read.preflight.text);
  if (read.preflight.state === "blocked") return off(read.preflight.blockers.join(" "), read.preflight.reset);
  // Native USDC pays the fee too, so selling USDC needs the sale and the most the fee can be.
  const need = read.amountIn + (isAddressEqual(read.sold.address, USDC) ? (read.keepUpTo + UNIT - 1n) / UNIT : 0n);
  if (read.soldBalance < need) return off(reasons.closeShort(read.soldBalance, need, read.sold.symbol));
  return {
    kind: "ready",
    estimate: {
      loan: read.loan,
      sold: read.sold,
      approval: read.approval,
      amountIn: read.amountIn,
      usd: dollarValue(read.amountIn, read.sold.symbol, read.eur),
      fee: circleFee(read.amountIn),
      keepUpTo: read.keepUpTo,
      blockNumber: read.blockNumber,
      soldBalance: read.soldBalance,
    },
  };
}
