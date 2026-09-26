import { parseGwei, type Address, type Hex, type TransactionReceipt } from "viem";
import { arc } from "viem/chains";
import { getConnection, getPublicClient, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { adagAbi } from "@/lib/pay/abi";
import { requireDeployment } from "@/lib/pay/constants";
import { decodeAdagError, type PlainError } from "@/lib/pay/errors";
import { formatUnitsExact } from "@/lib/pay/format";
import { wagmiConfig } from "./config";

// Arc drops transactions priced under 20 gwei without an error, so this is a floor, never a target.
const MIN_MAX_FEE = parseGwei("20");
const PRIORITY_FEE = parseGwei("1");
const RECEIPT_TIMEOUT_MS = 60_000;
const WATCH_TIMEOUT_MS = 120_000;
const WATCH_EVERY_MS = 3_000;

export type TxStep = "checking" | "signing" | "confirming" | "watching" | "rereading";

export type TxOutcome =
  | { ok: true; hash: Hex; receipt: TransactionReceipt }
  | { ok: false; stage: "refused"; error: PlainError }
  | { ok: false; stage: "declined" | "failed"; message: string; hash?: Hex }
  // Sent, but Arc gave no receipt in time. The caller checks the bill itself before saying anything, so nobody pays twice.
  | { ok: false; stage: "unconfirmed"; message: string; hash: Hex };

function firstLine(error: unknown) {
  const e = error as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage || e?.message || "The wallet did not answer.").split("\n")[0]!.slice(0, 160);
}

function isUserRejection(error: unknown): boolean {
  for (let e = error as { code?: number; name?: string; cause?: unknown } | undefined, i = 0; e && i < 6; e = e.cause as typeof e, i++) {
    if (e.code === 4001 || e.name === "UserRejectedRequestError") return true;
  }
  return /reject|denied|cancel/i.test(firstLine(error));
}

// Native USDC has 18 decimals; four are enough to read a fee. Needs round up and balances down, so a sentence never
// makes a gap look smaller than it is.
export function usdc4(wei: bigint, direction: "up" | "down"): string {
  const step = 10n ** 14n;
  const units = direction === "up" ? (wei + step - 1n) / step : wei / step;
  return formatUnitsExact(units * step, 18, 4);
}

export function publicArc() {
  const client = getPublicClient(wagmiConfig, { chainId: arc.id });
  if (!client) throw new Error("No Arc client is configured.");
  return client;
}

type Fees = { maxFeePerGas: bigint; maxPriorityFeePerGas: bigint; expected: bigint };

// Fees as prove-it sets them: twice the base fee plus the tip, never under Arc's 20 gwei floor.
export async function feesNow(): Promise<Fees> {
  const block = await publicArc().getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const doubled = 2n * base + PRIORITY_FEE;
  const maxFeePerGas = doubled > MIN_MAX_FEE ? doubled : MIN_MAX_FEE;
  const expected = base + PRIORITY_FEE < maxFeePerGas ? base + PRIORITY_FEE : maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, expected };
}

export type FeeFigures = {
  // The gas limit sent: the estimate plus 25%.
  gasLimit: bigint;
  // What the transaction should cost, in 18-decimal native USDC.
  about: bigint;
  // The most Arc can set aside for it: the gas limit at the highest fee sent. The balance check uses this.
  keepUpTo: bigint;
};

// The one place both fee numbers come from, so the figure a screen quotes and the figure the check enforces agree.
export function feeFigures(gasEstimate: bigint, fees: Fees): FeeFigures {
  const gasLimit = (gasEstimate * 125n) / 100n;
  return { gasLimit, about: gasEstimate * fees.expected, keepUpTo: gasLimit * fees.maxFeePerGas };
}

export async function estimateFee({ account, to, data }: { account: Address; to: Address; data: Hex }): Promise<FeeFigures> {
  const [gas, fees] = await Promise.all([publicArc().estimateGas({ account, to, data }), feesNow()]);
  return feeFigures(gas, fees);
}

type SendArgs = {
  account: Address;
  to: Address;
  data: Hex;
  onStep: (step: TxStep) => void;
  // The 6-decimal USDC this batch moves out of the wallet. On Arc it comes from the same balance that prepays gas.
  usdcOut?: bigint;
};

const USDC_TO_NATIVE = 10n ** 12n;

// One path for every money action: check the wallet is on Arc (C4), simulate with eth_call and stop on any revert
// with plain words, then ask the wallet, then wait for Arc. Nothing reaches the wallet unless the simulation passed.
export async function simulateAndSend({ account, to, data, onStep, usdcOut = 0n }: SendArgs): Promise<TxOutcome> {
  const client = publicArc();
  onStep("checking");

  const connection = getConnection(wagmiConfig);
  if (connection.status !== "connected" || connection.chainId !== arc.id || connection.address?.toLowerCase() !== account.toLowerCase()) {
    return { ok: false, stage: "failed", message: "Your wallet is not on Arc mainnet with this address any more. Nothing was sent." };
  }

  let estimate: bigint;
  try {
    await client.call({ account, to, data });
    estimate = await client.estimateGas({ account, to, data });
  } catch (error) {
    return { ok: false, stage: "refused", error: decodeAdagError(error) };
  }

  let fees: Fees;
  try {
    fees = await feesNow();
  } catch {
    return { ok: false, stage: "failed", message: "Arc did not answer with the current fee. Nothing was sent. Try again." };
  }
  const figures = feeFigures(estimate, fees);

  // Arc prepays gas from the wallet's native balance, which is also its USDC. A wallet that cannot cover the most the
  // fee can be, plus the USDC the batch moves, is told here, before signing, instead of paying for a batch that reverts.
  const principal = usdcOut > 0n ? usdcOut * USDC_TO_NATIVE : 0n;
  const need = figures.keepUpTo + principal;
  let native: bigint;
  try {
    native = await client.getBalance({ address: account });
  } catch {
    return { ok: false, stage: "failed", message: "Arc did not answer with your balance. Nothing was sent. Try again." };
  }
  if (native < need) {
    const message =
      principal === 0n
        ? `Your wallet needs about ${usdc4(figures.keepUpTo, "up")} USDC for the network fee and holds ${usdc4(native, "down")}. Nothing was sent.`
        : `Your wallet needs about ${usdc4(need, "up")} USDC, ${usdc4(principal, "up")} for this payment plus about ${usdc4(figures.keepUpTo, "up")} for the network fee, and holds ${usdc4(native, "down")}. Nothing was sent.`;
    return { ok: false, stage: "failed", message };
  }

  onStep("signing");
  let hash: Hex;
  try {
    // chainId makes the wallet prove it is still on Arc at the moment of signing (C4).
    hash = await sendTransaction(wagmiConfig, {
      account,
      chainId: arc.id,
      to,
      data,
      gas: figures.gasLimit,
      maxFeePerGas: fees.maxFeePerGas,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
    });
  } catch (error) {
    if (isUserRejection(error)) return { ok: false, stage: "declined", message: "You declined in your wallet. Nothing was sent." };
    return { ok: false, stage: "failed", message: `The wallet could not send it: ${firstLine(error)}` };
  }

  onStep("confirming");
  let receipt: TransactionReceipt;
  try {
    receipt = await waitForTransactionReceipt(wagmiConfig, { hash, chainId: arc.id, timeout: RECEIPT_TIMEOUT_MS });
  } catch {
    return { ok: false, stage: "unconfirmed", hash, message: "Arc has not confirmed it yet. Do not pay again: check the transaction link first." };
  }
  if (receipt.status !== "success") {
    return { ok: false, stage: "failed", hash, message: "The transaction reverted on Arc, so nothing moved apart from the fee." };
  }
  onStep("rereading");
  return { ok: true, hash, receipt };
}

// After a receipt timeout: read bill(id) on the bills' own contract every few seconds for up to two minutes until
// every bill reaches the status wanted. That record is proof (C16, C53), so the page can show the real outcome.
export async function watchBills(contract: string, ids: readonly bigint[], wantedStatus: number, expectedPayer?: Address): Promise<boolean> {
  const client = publicArc();
  const { address } = requireDeployment(contract);
  const until = Date.now() + WATCH_TIMEOUT_MS;
  while (Date.now() < until) {
    try {
      const records = await Promise.all(ids.map((id) => client.readContract({ address, abi: adagAbi, functionName: "bill", args: [id] })));
      const done = records.every((r) => r.status === wantedStatus && (!expectedPayer || r.payer.toLowerCase() === expectedPayer.toLowerCase()));
      if (done) return true;
    } catch {
      // A missed read is not an answer; try again on the next tick.
    }
    await new Promise((r) => setTimeout(r, WATCH_EVERY_MS));
  }
  return false;
}
