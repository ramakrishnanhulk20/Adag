import { encodeAbiParameters, isAddressEqual, keccak256, parseAbi } from "viem";
import { ADAG_BILLS, ADAG_BILLS_FIRST, DEPLOYMENTS } from "../pay/constants";
import { adagAbi, irmAbi, morphoAbi } from "./abi";
import { arcClient } from "./client";
import {
  ADAPTIVE_CURVE_IRM,
  CHAIN_ID,
  CIRBTC,
  EXPLORER,
  MARKET_EURC,
  MARKET_USDC,
  MORPHO,
  SECONDS_PER_YEAR,
  USDC,
  USDC_MARKET_LLTV,
  USDC_MARKET_ORACLE,
  WAD,
} from "./constants";
import { findBillPaid, readPaid, type PaidRead } from "./paidIndex";
import type { BorrowRate, BtcPrice, Cell, LatestBills, Liquidity, LiveSnapshot, LoanCap, PaidEntry, PaidThroughAdag, PriceStatus, ProofBill } from "./types";

const oracleAbi = parseAbi(["function price() view returns (uint256)"]);

// The live proof payment on the current contract (packages/contracts/deployments/prove-it-2026-09-26.md).
const PROOF_BILL_ID = 1n;

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

// Shared reads are awaited by several cells; wrapping them means a rejection is never left unhandled.
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

// A cell's source note may depend on what the read found (the paid figures say how far they counted).
async function cell<T>(source: string | ((value: T) => string), chain: Promise<Settled<number>>, run: () => Promise<T>): Promise<Cell<T>> {
  const fixed = typeof source === "string" ? source : null;
  try {
    const id = await need(chain);
    if (id !== CHAIN_ID) throw new Error(`The RPC answered for chain ${id}, not Arc mainnet (${CHAIN_ID}).`);
    const value = await run();
    return { ok: true, value, source: fixed ?? (source as (v: T) => string)(value) };
  } catch (error) {
    return { ok: false, reason: reasonOf(error), source: fixed ?? "BillPaid events of both AdagBills deployments" };
  }
}

type MarketTuple = readonly [bigint, bigint, bigint, bigint, bigint, bigint];
type ParamsTuple = readonly [`0x${string}`, `0x${string}`, `0x${string}`, `0x${string}`, bigint];

function liquidityOf(m: MarketTuple): bigint {
  const [totalSupplyAssets, , totalBorrowAssets] = m;
  if (totalBorrowAssets > totalSupplyAssets) throw new Error("Morpho reported more borrowed than supplied.");
  return totalSupplyAssets - totalBorrowAssets;
}

// The fetched params only feed a view call here, but they are still held to the fixed market id and constants.
function verifiedUsdcParams(p: ParamsTuple) {
  const id = keccak256(
    encodeAbiParameters([{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }], p),
  );
  const [loanToken, collateralToken, oracle, irm, lltv] = p;
  const matches =
    id.toLowerCase() === MARKET_USDC.toLowerCase() &&
    isAddressEqual(loanToken, USDC) &&
    isAddressEqual(collateralToken, CIRBTC) &&
    isAddressEqual(oracle, USDC_MARKET_ORACLE) &&
    isAddressEqual(irm, ADAPTIVE_CURVE_IRM) &&
    lltv === USDC_MARKET_LLTV;
  if (!matches) throw new Error("Morpho's USDC market params do not match the fixed market.");
  return { loanToken, collateralToken, oracle, irm, lltv };
}

const currencyName = (address: string): "USDC" | "EURC" => (isAddressEqual(address as `0x${string}`, USDC) ? "USDC" : "EURC");

function entriesOf(paid: PaidRead): PaidEntry[] {
  return paid.latest.map((r) => ({
    contract: r.contract,
    first: isAddressEqual(r.contract, ADAG_BILLS_FIRST),
    id: r.id.toString(),
    currency: currencyName(r.currency),
    amountBaseUnits: r.amount.toString(),
    payer: r.payer,
    payee: r.payee,
    txHash: r.txHash,
    logIndex: r.logIndex,
    blockNumber: r.blockNumber.toString(),
    paidAt: Number(r.paidAt),
    loanChecked: r.loanChecked,
    explorerUrl: `${EXPLORER}/tx/${r.txHash}`,
  }));
}

const how = (paid: PaidRead) =>
  `${paid.source === "index" ? "an index of those events kept in the server store" : "bill(id) for the newest bills, read straight from Arc"}, through block ${paid.throughBlock}${paid.note ? `. ${paid.note.replace(/\.$/, "")}` : ""}`;

export async function readLive(): Promise<LiveSnapshot> {
  const chain = settle(arcClient.getChainId());
  const head = settle(arcClient.getBlock());
  const marketUsdc = settle(arcClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [MARKET_USDC] }));
  const marketEurc = settle(arcClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "market", args: [MARKET_EURC] }));
  const params = settle(
    arcClient.readContract({ address: MORPHO, abi: morphoAbi, functionName: "idToMarketParams", args: [MARKET_USDC] }),
  );
  const maxLtv = settle(arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "MAX_LTV_WAD" }));
  const priceStatus = settle(
    arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "priceStatus", args: [MARKET_USDC] }),
  );
  const billCounts = settle(Promise.all(DEPLOYMENTS.map((d) => arcClient.readContract({ address: d.address, abi: adagAbi, functionName: "billCount" }))));
  const oraclePrice = settle(arcClient.readContract({ address: USDC_MARKET_ORACLE, abi: oracleAbi, functionName: "price" }));
  const paidRead = settle(readPaid());
  const proofBill = settle(arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [PROOF_BILL_ID] }));

  const [liquidity, borrowRate, loanCap, paid, price, btcPrice, latestBills, proof, headResult] = await Promise.all([
    cell<Liquidity>(`Morpho ${MORPHO} market(MARKET_USDC) and market(MARKET_EURC): totalSupplyAssets minus totalBorrowAssets`, chain, async () => {
      const usdc = liquidityOf(await need(marketUsdc));
      const eurcRead = await marketEurc;
      let eurc: string | null = null;
      if (eurcRead.ok) {
        try {
          eurc = liquidityOf(eurcRead.value).toString();
        } catch {
          eurc = null;
        }
      }
      return { usdcBaseUnits: usdc.toString(), eurcBaseUnits: eurc };
    }),
    cell<BorrowRate>(`AdaptiveCurveIrm ${ADAPTIVE_CURVE_IRM} borrowRateView(idToMarketParams(MARKET_USDC), market(MARKET_USDC)), APY = e^(rate x ${SECONDS_PER_YEAR} / 1e18) - 1`, chain,
      async () => {
        const p = verifiedUsdcParams(await need(params));
        const m = await need(marketUsdc);
        const rate = await arcClient.readContract({
          address: ADAPTIVE_CURVE_IRM,
          abi: irmAbi,
          functionName: "borrowRateView",
          args: [
            p,
            {
              totalSupplyAssets: m[0],
              totalSupplyShares: m[1],
              totalBorrowAssets: m[2],
              totalBorrowShares: m[3],
              lastUpdate: m[4],
              fee: m[5],
            },
          ],
        });
        const apy = Math.expm1((Number(rate) * SECONDS_PER_YEAR) / Number(WAD));
        if (!Number.isFinite(apy) || apy < 0) throw new Error("The rate model returned an unusable rate.");
        return { perSecondWad: rate.toString(), apy };
      },
    ),
    cell<LoanCap>(`AdagBills ${ADAG_BILLS} MAX_LTV_WAD(), and Morpho idToMarketParams(MARKET_USDC).lltv`, chain, async () => {
      const cap = await need(maxLtv);
      if (cap <= 0n || cap >= WAD) throw new Error("AdagBills returned an impossible loan cap.");
      const paramsRead = await params;
      let lltv: string | null = null;
      if (paramsRead.ok) {
        try {
          lltv = verifiedUsdcParams(paramsRead.value).lltv.toString();
        } catch {
          lltv = null;
        }
      }
      return { maxLtvWad: cap.toString(), morphoLltvWad: lltv };
    }),
    cell<PaidThroughAdag & { how: string }>(
      (v) =>
        `Paid bills: BillPaid events of AdagBills ${ADAG_BILLS} and of the first deployment ${ADAG_BILLS_FIRST}, from ${v.how}. Bills written: billCount() on both, added together`,
      chain,
      async () => {
        const [p, counts] = await Promise.all([need(paidRead), need(billCounts)]);
        const newest = p.latest[0];
        return {
          billCount: Number(counts.reduce((t, n) => t + n, 0n)),
          billsPaid: p.totals.count,
          usdcBaseUnits: p.totals.usdc.toString(),
          eurcBaseUnits: p.totals.eurc.toString(),
          latestPayment: newest
            ? { billId: Number(newest.id), txHash: newest.txHash, logIndex: newest.logIndex, blockNumber: newest.blockNumber.toString(), explorerUrl: `${EXPLORER}/tx/${newest.txHash}` }
            : null,
          latestPaymentNote: newest ? "found" : p.totals.count === 0 ? "none" : "not-found",
          source: p.source,
          throughBlock: p.throughBlock.toString(),
          note: p.note,
          how: how(p),
        };
      },
    ),
    cell<PriceStatus>(`AdagBills ${ADAG_BILLS} priceStatus(MARKET_USDC), age measured against the latest block's timestamp`, chain, async () => {
      const [fresh, btcUsdUpdatedAt] = await need(priceStatus);
      const headRead = await head;
      const now = headRead.ok ? headRead.value.timestamp : BigInt(Math.floor(Date.now() / 1000));
      const age = now > btcUsdUpdatedAt ? now - btcUsdUpdatedAt : 0n;
      return { fresh, btcUsdUpdatedAt: Number(btcUsdUpdatedAt), ageSeconds: Number(age) };
    }),
    cell<BtcPrice>(`Oracle ${USDC_MARKET_ORACLE} price() / 1e34 (36 + 6 - 8 decimals), dollars per cirBTC, display only`, chain, async () => {
      const raw = await need(oraclePrice);
      // price() is USDC base units per cirBTC base unit, scaled 1e36: dividing by 1e34 gives dollars per whole cirBTC.
      const cents = raw / 10n ** 32n;
      const usdPerCirbtc = Number(cents) / 100;
      if (!Number.isFinite(usdPerCirbtc) || usdPerCirbtc <= 0 || usdPerCirbtc > 100_000_000) throw new Error("The oracle returned an unusable price.");
      return { usdPerCirbtc };
    }),
    cell<LatestBills & { how: string }>(
      (v) => `The newest paid bills from the BillPaid events of both AdagBills deployments, from ${v.how}. No bill's reference is read or shown here`,
      chain,
      async () => {
        const p = await need(paidRead);
        return { billsPaid: p.totals.count, bills: entriesOf(p), how: how(p) };
      },
    ),
    cell<ProofBill>(`AdagBills ${ADAG_BILLS} bill(${PROOF_BILL_ID}), and that bill's own BillPaid event found around its paidAt`, chain, async () => {
      const b = await need(proofBill);
      if (b.status !== 1 && b.status !== 2 && b.status !== 3) throw new Error(`Bill ${PROOF_BILL_ID} does not exist on the current AdagBills.`);
      const base = {
        id: PROOF_BILL_ID.toString(),
        status: b.status as ProofBill["status"],
        currency: currencyName(b.currency),
        amountBaseUnits: b.amount.toString(),
        paidAt: Number(b.paidAt),
      };
      if (b.status !== 2) return { ...base, payment: null, paymentNote: "not-paid" as const };
      const row = await findBillPaid(ADAG_BILLS, PROOF_BILL_ID, b.paidAt);
      if (!row) return { ...base, payment: null, paymentNote: "not-found" as const };
      return {
        ...base,
        payment: {
          txHash: row.txHash,
          logIndex: row.logIndex,
          blockNumber: row.blockNumber.toString(),
          explorerUrl: `${EXPLORER}/tx/${row.txHash}`,
          loanChecked: row.loanChecked,
        },
        paymentNote: "found" as const,
      };
    }),
    head,
  ]);

  // The "how" line lives only in each cell's source note, not in the value the page reads.
  const strip = <T extends { how: string }>(c: Cell<T>): Cell<Omit<T, "how">> => {
    if (!c.ok) return c;
    const { how: _how, ...value } = c.value;
    return { ok: true, value, source: c.source };
  };

  return {
    fetchedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    blockNumber: headResult.ok && headResult.value.number !== null ? String(headResult.value.number) : null,
    liquidity,
    borrowRate,
    loanCap,
    paid: strip(paid),
    price,
    btcPrice,
    latestBills: strip(latestBills),
    proof,
  };
}
