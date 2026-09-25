import { encodeAbiParameters, getAddress, isAddressEqual, keccak256, type Block } from "viem";
import { adagAbi, BILL_STATUS_PAID, irmAbi, morphoAbi } from "./abi";
import { arcClient } from "./client";
import {
  ADAG_BILLS,
  ADAG_DEPLOY_BLOCK,
  ADAPTIVE_CURVE_IRM,
  BILL_READ_CHUNK,
  CHAIN_ID,
  CIRBTC,
  EURC,
  EXPLORER,
  LOG_MAX_PAGES,
  LOG_PAGE_BLOCKS,
  MARKET_EURC,
  MARKET_USDC,
  MAX_BILL_READS,
  MORPHO,
  SECONDS_PER_YEAR,
  USDC,
  USDC_MARKET_LLTV,
  USDC_MARKET_ORACLE,
  WAD,
} from "./constants";
import type { BorrowRate, Cell, Liquidity, LiveSnapshot, LoanCap, PaidThroughAdag, PriceStatus } from "./types";

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

function reasonOf(error: unknown): string {
  const e = error as { shortMessage?: string; message?: string } | undefined;
  const text = e?.shortMessage || e?.message || "The read failed.";
  return text.split("\n")[0]!.slice(0, 160);
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

let deployBlockPromise: Promise<Block> | null = null;
function deployBlock(): Promise<Block> {
  deployBlockPromise ??= arcClient.getBlock({ blockNumber: ADAG_DEPLOY_BLOCK }).catch((error: unknown) => {
    deployBlockPromise = null;
    throw error;
  });
  return deployBlockPromise;
}

const clamp = (v: bigint, lo: bigint, hi: bigint) => (v < lo ? lo : v > hi ? hi : v);

// ARCHITECTURE.md section 5: find a paid bill's transaction by searching a window around its paidAt, never an open scan.
async function findBillPaidLog(billId: bigint, paidAt: bigint, head: Block) {
  const deploy = await deployBlock();
  if (head.number === null || deploy.number === null) throw new Error("Block numbers missing.");
  const spanBlocks = head.number - deploy.number;
  const spanSeconds = head.timestamp - deploy.timestamp;
  if (spanSeconds <= 0n) throw new Error("Chain clock went backwards.");

  const estimateFrom = (anchorNumber: bigint, anchorTime: bigint) =>
    clamp(anchorNumber + ((paidAt - anchorTime) * spanBlocks) / spanSeconds, deploy.number!, head.number!);
  let centre = estimateFrom(deploy.number, deploy.timestamp);
  const probe = await arcClient.getBlock({ blockNumber: centre });
  centre = estimateFrom(centre, probe.timestamp);

  const half = LOG_PAGE_BLOCKS / 2n;
  const windows: [bigint, bigint][] = [];
  let low = clamp(centre - half, deploy.number, head.number);
  let high = clamp(centre + half - 1n, deploy.number, head.number);
  windows.push([low, high]);
  while (windows.length < LOG_MAX_PAGES && (low > deploy.number || high < head.number)) {
    if (high < head.number) {
      const from = high + 1n;
      high = clamp(from + LOG_PAGE_BLOCKS - 1n, deploy.number, head.number);
      windows.push([from, high]);
    }
    if (windows.length < LOG_MAX_PAGES && low > deploy.number) {
      const to = low - 1n;
      low = clamp(to - LOG_PAGE_BLOCKS + 1n, deploy.number, head.number);
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
    // C16: only Adag's own event, for this exact bill, tied to a transaction hash and log index.
    const match = logs.find(
      (log) =>
        !log.removed &&
        isAddressEqual(log.address, ADAG_BILLS) &&
        log.args.id === billId &&
        log.transactionHash !== null &&
        log.logIndex !== null,
    );
    if (match) {
      return {
        billId: Number(billId),
        txHash: match.transactionHash!,
        logIndex: match.logIndex!,
        blockNumber: String(match.blockNumber),
        explorerUrl: `${EXPLORER}/tx/${match.transactionHash}`,
      };
    }
  }
  return null;
}

async function readPaid(billCountRead: Promise<Settled<bigint>>, headRead: Promise<Settled<Block>>): Promise<PaidThroughAdag> {
  const count = await need(billCountRead);
  if (count > BigInt(MAX_BILL_READS)) throw new Error(`More than ${MAX_BILL_READS} bills; summing from logs is not built yet.`);

  let usdc = 0n;
  let eurc = 0n;
  let billsPaid = 0;
  let latest: { id: bigint; paidAt: bigint } | null = null;

  for (let start = 1n; start <= count; start += BigInt(BILL_READ_CHUNK)) {
    const ids: bigint[] = [];
    for (let id = start; id <= count && id < start + BigInt(BILL_READ_CHUNK); id++) ids.push(id);
    const bills = await Promise.all(
      ids.map((id) => arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [id] })),
    );
    bills.forEach((b, i) => {
      if (b.status !== BILL_STATUS_PAID) return;
      const currency = getAddress(b.currency);
      if (isAddressEqual(currency, USDC)) usdc += b.amount;
      else if (isAddressEqual(currency, EURC)) eurc += b.amount;
      else throw new Error("A paid bill names a currency Adag does not support.");
      billsPaid++;
      const id = ids[i]!;
      if (!latest || b.paidAt > latest.paidAt || (b.paidAt === latest.paidAt && id > latest.id)) latest = { id, paidAt: b.paidAt };
    });
  }

  let latestPayment: PaidThroughAdag["latestPayment"] = null;
  let latestPaymentNote: PaidThroughAdag["latestPaymentNote"] = billsPaid === 0 ? "none" : "found";
  const newest = latest as { id: bigint; paidAt: bigint } | null;
  if (newest) {
    try {
      const head = await need(headRead);
      latestPayment = await findBillPaidLog(newest.id, newest.paidAt, head);
      if (!latestPayment) latestPaymentNote = "not-found";
    } catch {
      latestPaymentNote = "unavailable";
    }
  }

  return {
    billCount: Number(count),
    billsPaid,
    usdcBaseUnits: usdc.toString(),
    eurcBaseUnits: eurc.toString(),
    latestPayment,
    latestPaymentNote,
  };
}

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
  const billCount = settle(arcClient.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "billCount" }));

  const [liquidity, borrowRate, loanCap, paid, price, headResult] = await Promise.all([
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
    cell<PaidThroughAdag>(`AdagBills ${ADAG_BILLS} billCount(), then bill(id) for 1 to billCount summing amount where status is 2; latest BillPaid log by bill id around paidAt`, chain,
      () => readPaid(billCount, head),
    ),
    cell<PriceStatus>(`AdagBills ${ADAG_BILLS} priceStatus(MARKET_USDC), age measured against the latest block's timestamp`, chain, async () => {
      const [fresh, btcUsdUpdatedAt] = await need(priceStatus);
      const headRead = await head;
      const now = headRead.ok ? headRead.value.timestamp : BigInt(Math.floor(Date.now() / 1000));
      const age = now > btcUsdUpdatedAt ? now - btcUsdUpdatedAt : 0n;
      return { fresh, btcUsdUpdatedAt: Number(btcUsdUpdatedAt), ageSeconds: Number(age) };
    }),
    head,
  ]);

  return {
    fetchedAt: new Date().toISOString(),
    chainId: CHAIN_ID,
    blockNumber: headResult.ok && headResult.value.number !== null ? String(headResult.value.number) : null,
    liquidity,
    borrowRate,
    loanCap,
    paid,
    price,
  };
}
