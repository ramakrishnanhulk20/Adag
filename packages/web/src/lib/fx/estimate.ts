// Plain TypeScript with relative imports only. How much of the other currency a payment converts, priced from the euro
// price AdagBills itself reads, and the ceiling that holds it (C69, C70).
import type { Address, PublicClient } from "viem";
import { adagAbi, chainlinkFeedAbi, oracleFeedsAbi } from "../pay/abi";
import { BPS, CURRENCIES, EUR_USD_MAX_AGE_SECONDS, EURC_MARKET_ORACLE, MAX_BUFFER_BPS, WAD, requireDeployment, type Currency } from "../pay/constants";

export class EstimateError extends Error {}
const refuse = (message: string): never => {
  throw new EstimateError(message);
};

export type CurrencySymbol = "USDC" | "EURC";

// C69: the loan currency is decided once, here: the other of the two fixed currencies. Every figure that is tied to a
// loan market (the pledge, the borrow, free cash, price status, the loan-to-value afterwards) reads this one answer.
export function loanCurrencyFor(billSymbol: CurrencySymbol): Currency {
  const other = billSymbol === "USDC" ? "EURC" : "USDC";
  const found = CURRENCIES.find((c) => c.symbol === other);
  if (!found) refuse("The loan currency for this payment is not one Adag supports.");
  return found!;
}

// A Chainlink answer as AdagBills reads it: the answer, its decimals and when it was last updated.
export type EurUsdReading = { answer: bigint; decimals: number; updatedAt: bigint };

// The same test as AdagBills._readFeed with its 96-hour limit for the euro feed: a positive answer, not dated in the
// future, no older than the window, measured on the chain's clock and never the browser's. Past it, nothing is offered.
export function assertEurUsdFresh(reading: EurUsdReading, chainTime: bigint): void {
  if (typeof reading.answer !== "bigint" || reading.answer <= 0n) refuse("The euro price Adag reads from Arc is not positive, so converting is off.");
  if (!Number.isInteger(reading.decimals) || reading.decimals < 0 || reading.decimals > 36) refuse("The euro price Adag reads from Arc has an unusable scale, so converting is off.");
  if (typeof chainTime !== "bigint" || typeof reading.updatedAt !== "bigint" || reading.updatedAt > chainTime) refuse("The euro price Adag reads from Arc is dated in the future, so converting is off.");
  if (chainTime - reading.updatedAt > EUR_USD_MAX_AGE_SECONDS) {
    refuse("The euro price Adag reads from Arc is more than 96 hours old (the feed pauses over weekends), so converting between dollars and euros is off. Paying in the bill's own currency still works.");
  }
}

function assertBuffer(bufferBps: bigint) {
  if (typeof bufferBps !== "bigint" || bufferBps < 0n || bufferBps > MAX_BUFFER_BPS) {
    refuse(`The buffer must be between 0 and ${MAX_BUFFER_BPS} basis points.`);
  }
}

// How much of the other currency to sell to end up with `wanted`, at the euro price AdagBills reads, plus a buffer for
// what the swap costs, rounded up. USD per euro is answer / 10^decimals. Wanting dollars sells euros at wanted / price;
// wanting euros sells dollars at wanted x price. Both currencies have 6 decimals, so no unit conversion is needed.
export function amountToSell(wanted: bigint, wantedSymbol: CurrencySymbol, reading: EurUsdReading, bufferBps: bigint): bigint {
  if (typeof wanted !== "bigint" || wanted <= 0n) refuse("The amount to convert must be more than zero.");
  assertBuffer(bufferBps);
  if (reading.answer <= 0n) refuse("The euro price Adag reads from Arc is not positive, so converting is off.");
  const scale = 10n ** BigInt(reading.decimals);
  const factor = BPS + bufferBps;
  const num = wantedSymbol === "USDC" ? wanted * scale * factor : wanted * reading.answer * factor;
  const den = wantedSymbol === "USDC" ? reading.answer * BPS : scale * BPS;
  return (num + den - 1n) / den;
}

// The ceiling: the same amount at the largest buffer there is. The builder refuses anything above it (C70).
export function maxAmountToSell(wanted: bigint, wantedSymbol: CurrencySymbol, reading: EurUsdReading): bigint {
  return amountToSell(wanted, wantedSymbol, reading, MAX_BUFFER_BPS);
}

// The worst case the payer can end up with, as a rate: what the plan must return divided by what it sells, in WAD,
// rounded down. The plan's minimum is at least `wanted`, so the real rate is never below this.
export function worstCaseRate(wanted: bigint, amountIn: bigint): bigint {
  if (typeof wanted !== "bigint" || wanted <= 0n || typeof amountIn !== "bigint" || amountIn <= 0n) refuse("The rate needs two amounts above zero.");
  return (wanted * WAD) / amountIn;
}

type Reader = Pick<PublicClient, "readContract" | "getBlock">;

// The euro price the way AdagBills reads it for the EURC market: the market oracle's QUOTE_FEED_1, then that Chainlink
// feed's latestRoundData, all at one block. Throws an EstimateError (a sentence of ours) when the read fails or the feed
// is past AdagBills' window. The chain time returned is that block's, for every later freshness and expiry check.
export async function readEurUsd(client: Reader): Promise<{ reading: EurUsdReading; chainTime: bigint; blockNumber: bigint }> {
  let out: { reading: EurUsdReading; chainTime: bigint; blockNumber: bigint };
  try {
    const block = await client.getBlock();
    const blockNumber = block.number;
    const feed = (await client.readContract({ address: EURC_MARKET_ORACLE, abi: oracleFeedsAbi, functionName: "QUOTE_FEED_1", blockNumber })) as Address;
    const [round, decimals] = await Promise.all([
      client.readContract({ address: feed, abi: chainlinkFeedAbi, functionName: "latestRoundData", blockNumber }),
      client.readContract({ address: feed, abi: chainlinkFeedAbi, functionName: "decimals", blockNumber }),
    ]);
    out = { reading: { answer: round[1], decimals: Number(decimals), updatedAt: round[3] }, chainTime: block.timestamp, blockNumber };
  } catch {
    return refuse("Adag could not read the euro price from Arc, so converting is off. Try again in a moment.");
  }
  assertEurUsdFresh(out.reading, out.chainTime);
  return out;
}

// C69: AdagBills.priceStatus for the loan market, read before the option is offered. The euro market pauses over weekends.
// null when the read fails, which a screen treats as "not known", never as fresh.
export async function readLoanPriceFresh(client: Pick<PublicClient, "readContract">, contract: string, billSymbol: CurrencySymbol): Promise<boolean | null> {
  try {
    const { address } = requireDeployment(contract);
    const [fresh] = await client.readContract({ address, abi: adagAbi, functionName: "priceStatus", args: [loanCurrencyFor(billSymbol).marketId] });
    return fresh === true;
  } catch {
    return null;
  }
}
