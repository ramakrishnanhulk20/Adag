import { encodeFunctionData, isAddressEqual, parseGwei, type Address, type Hex, type TransactionReceipt } from "viem";
import { arc } from "viem/chains";
import { getConnection, getPublicClient, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { adagAbi, erc20Abi, morphoAbi } from "@/lib/pay/abi";
import { assertConversionBatch, decodeBatch, reachesSwapAdapter } from "@/lib/pay/build";
import { CIRBTC, CIRCLE_SWAP_ADAPTER, EURC, FX_GAS_CAP, MORPHO, MULTICALL3_FROM, PLAN_MIN_SECONDS_LEFT, USDC, requireDeployment } from "@/lib/pay/constants";
import { decodeAdagError, type PlainError } from "@/lib/pay/errors";
import { formatUnitsExact } from "@/lib/pay/format";
import { PlanError, checkEffects, claimPlan, conversionUsdcOut, type Conversion } from "@/lib/fx/plan";
import { wagmiConfig } from "./config";

// The gas slack on a USDC balance check is worked out in lib/fx/plan.ts from FX_GAS_CAP and the fee ceiling the batch
// carries. The builder and this file both use it, so what the floor allows and what is signed cannot drift (C68, C71).
export { floorSlack } from "@/lib/fx/plan";

// Arc drops transactions priced under 20 gwei without an error, so this is a floor, never a target.
const MIN_MAX_FEE = parseGwei("20");
const PRIORITY_FEE = parseGwei("1");
const RECEIPT_TIMEOUT_MS = 60_000;
const WATCH_TIMEOUT_MS = 120_000;
const WATCH_EVERY_MS = 3_000;

export type TxStep = "checking" | "signing" | "confirming" | "watching" | "rereading";

export type TxOutcome =
  // `effects` is "checked" when the simulation's transfers were held to the conversion's rules. "unavailable" is only for a
  // send that does not require the check: every conversion requires it and is refused instead (C71).
  | { ok: true; hash: Hex; receipt: TransactionReceipt; effects?: "checked" | "unavailable" }
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
  // For a conversion batch, pass only what the rest of the batch moves: the conversion's own USDC is counted here (C25).
  usdcOut?: bigint;
  // Present when the batch runs a swap through Circle's adapter: the Batch's own `conversion`, passed through untouched.
  conversion?: Conversion;
};

const USDC_TO_NATIVE = 10n ** 12n;

const refusal = (name: string, message: string, next: string): TxOutcome => ({ ok: false, stage: "refused", error: { name, message, next, text: `${message} ${next}` } });

// No answer to the simulation at all: a node without eth_simulateV1 (Arc's own endpoint answers "method not supported"; dRPC
// has it), or one that could not be reached in time. Different from a node that ran it and found the batch failing, which
// is a refusal. Without the simulation only the batch's own balance check and one-amount allowance protect the payment, and
// the outcome says so.
function simulationUnavailable(error: unknown): boolean {
  for (let e = error as { code?: number; name?: string; message?: string; cause?: unknown } | undefined, i = 0; e && i < 6; e = e.cause as typeof e, i++) {
    if (e.code === -32601 || e.code === -32004 || e.name === "HttpRequestError" || e.name === "TimeoutError") return true;
    if (/method.{0,40}(not found|not supported|does not exist|not available|unsupported)|unsupported method/i.test(e.message ?? "")) return true;
  }
  return false;
}

// Shown when a conversion cannot be double-checked. The screens use the same sentence for their early warning.
export const EFFECTS_UNAVAILABLE = "We could not double-check this conversion just now. Nothing was sent. Try again in a minute.";

export type SimulationVerdict = "revert" | "refuse" | "go on unchecked";

// What a failed transfer-tracing simulation means for the signature. A node that ran the batch and found it failing has
// given an answer, so that is shown as a refusal. A node that gave no answer (no such method, unreachable, too slow) leaves
// the transfers unchecked: a conversion that requires the check is refused and the wallet is never asked, and only a send
// that does not require it goes on, with the outcome saying so.
export function simulationVerdict(error: unknown, requireEffects: boolean): SimulationVerdict {
  if (!simulationUnavailable(error)) return "revert";
  return requireEffects ? "refuse" : "go on unchecked";
}

const effectsUnavailable = (): TxOutcome => ({ ok: false, stage: "refused", error: { name: "effects unavailable", message: EFFECTS_UNAVAILABLE, next: "", text: EFFECTS_UNAVAILABLE } });

// Our own sentences reach the page; anything else a library says does not.
const ownSentence = (error: unknown): string =>
  error instanceof PlanError || (error instanceof Error && error.constructor === Error && /^Refusing /.test(error.message))
    ? error.message
    : "Adag's own check of this payment's calls refused it.";

type SimCall = { status: "success" | "failure"; gasUsed: bigint; logs?: readonly { address: Address; topics: readonly Hex[]; data: Hex }[]; error?: unknown; data?: Hex };

// C65 to C71, the sending side of a conversion. The bytes about to be signed are checked again against what the builder
// decided; the plan must still have time on Arc's clock; the batch is simulated at the latest block with its fixed gas
// ceiling and the fee ceiling its floor was worked out from; every transfer out of the wallet must be one the batch is
// allowed to make; each bill must show a payment from this wallet on its own contract. Only then is a signature asked for,
// and a plan is spent the moment it is (C74). With `requireEffects`, a node that cannot trace transfers, or does not answer
// in time, ends in a refusal and the wallet is never asked. The RPC is not trusted: the batch's own balance check (C68) and
// the one-amount allowance (C67) are the guards, and this is the early warning.
async function sendConversion({ client, account, to, data, onStep, usdcOut, conversion, requireEffects }: { client: ReturnType<typeof publicArc>; account: Address; to: Address; data: Hex; onStep: (step: TxStep) => void; usdcOut: bigint; conversion: Conversion; requireEffects: boolean }): Promise<TxOutcome> {
  try {
    assertConversionBatch(to, data, conversion, account);
  } catch (error) {
    return refusal("conversion bytes", ownSentence(error), "Nothing was sent. Start the payment again.");
  }

  let head;
  try {
    head = await client.getBlock();
  } catch {
    return { ok: false, stage: "failed", message: "Arc did not answer with the latest block. Nothing was sent. Try again." };
  }
  if (conversion.deadline < head.timestamp + PLAN_MIN_SECONDS_LEFT) {
    return refusal("plan expired", "Circle's swap quote for this payment has expired or is about to.", "Nothing was sent. Start the payment again to get a fresh one.");
  }
  const base = head.baseFeePerGas ?? 0n;
  if (conversion.maxFeePerGas < MIN_MAX_FEE || conversion.maxFeePerGas < base + PRIORITY_FEE) {
    return refusal("fee moved", "Arc's fee has risen past the ceiling this payment was built with.", "Nothing was sent. Start the payment again so the balance check is worked out from the current fee.");
  }
  const fees: Fees = { maxFeePerGas: conversion.maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, expected: base + PRIORITY_FEE < conversion.maxFeePerGas ? base + PRIORITY_FEE : conversion.maxFeePerGas };

  // C25: the wallet must cover the most the fee can be plus the USDC this batch moves out, counting USDC approved to the
  // adapter as leaving and crediting only USDC borrowed for it.
  const keepUpTo = FX_GAS_CAP * fees.maxFeePerGas;
  const principal = (usdcOut + conversionUsdcOut(conversion)) * USDC_TO_NATIVE;
  let native: bigint;
  try {
    native = await client.getBalance({ address: account });
  } catch {
    return { ok: false, stage: "failed", message: "Arc did not answer with your balance. Nothing was sent. Try again." };
  }
  if (native < keepUpTo + principal) {
    const need = keepUpTo + principal;
    const message =
      principal === 0n
        ? `Your wallet needs about ${usdc4(keepUpTo, "up")} USDC for the network fee and holds ${usdc4(native, "down")}. Nothing was sent.`
        : `Your wallet needs about ${usdc4(need, "up")} USDC, ${usdc4(principal, "up")} for this payment plus about ${usdc4(keepUpTo, "up")} for the network fee, and holds ${usdc4(native, "down")}. Nothing was sent.`;
    return { ok: false, stage: "failed", message };
  }

  let effects: "checked" | "unavailable" = "checked";
  let gasUsed: bigint;
  try {
    const sim = await client.simulateBlocks({
      blockNumber: head.number,
      blocks: [{ blockOverrides: head.baseFeePerGas == null ? undefined : { baseFeePerGas: head.baseFeePerGas }, calls: [{ account, to, data, gas: FX_GAS_CAP, maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }] }],
      traceTransfers: true,
      validation: true,
    });
    const result = sim[0]?.calls[0] as unknown as SimCall | undefined;
    if (!result) return refusal("simulation", "Arc's simulation of this payment came back empty.", "Nothing was sent. Try again.");
    if (result.status !== "success") return { ok: false, stage: "refused", error: decodeAdagError(result.error ?? result.data) };
    gasUsed = result.gasUsed;
    try {
      checkEffects(result.logs ?? [], conversion);
    } catch (error) {
      return refusal("effects", ownSentence(error), "Nothing was sent.");
    }
  } catch (error) {
    const verdict = simulationVerdict(error, requireEffects);
    if (verdict === "revert") return { ok: false, stage: "refused", error: decodeAdagError(error) };
    if (verdict === "refuse") return effectsUnavailable();
    effects = "unavailable";
    try {
      await client.call({ account, to, data, gas: FX_GAS_CAP });
      gasUsed = await client.estimateGas({ account, to, data });
    } catch (fallbackError) {
      return { ok: false, stage: "refused", error: decodeAdagError(fallbackError) };
    }
  }
  if ((gasUsed * 125n) / 100n > FX_GAS_CAP) {
    return refusal("gas", "This conversion would use more gas than Adag allows for one signature.", "Nothing was sent. Pay a smaller amount, or pay in the bill's own currency.");
  }
  if (!claimPlan(conversion.execId)) {
    return refusal("plan used", "This Circle quote was already used for a signature request.", "Nothing was sent. Start the payment again to get a fresh one.");
  }
  return signAndConfirm({ account, to, data, gas: FX_GAS_CAP, fees, onStep, effects });
}

// The wallet must be connected on Arc as this very account (C4). The refusal is the same wherever it is raised.
function walletOffArc(account: Address): TxOutcome | null {
  const connection = getConnection(wagmiConfig);
  if (connection.status !== "connected" || connection.chainId !== arc.id || connection.address?.toLowerCase() !== account.toLowerCase()) {
    return { ok: false, stage: "failed", message: "Your wallet is not on Arc mainnet with this address any more. Nothing was sent." };
  }
  return null;
}

// The exact bytes of the only two calls an adapter reset may hold. Comparing whole call data, not decoded fields, leaves no
// room for trailing bytes or another amount (C67).
const RESET_APPROVE = encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [CIRCLE_SWAP_ADAPTER, 0n] });
const RESET_DEAUTHORIZE = encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [CIRCLE_SWAP_ADAPTER, false] });
const RESET_TOKENS: readonly Address[] = [USDC, EURC, CIRBTC];

// Throws a sentence unless this is exactly a Multicall3From batch that sets some of USDC, EURC and cirBTC allowances to
// Circle's adapter back to 0, and withdraws the adapter's Morpho authorisation, each at most once and nothing else.
export function assertAdapterReset(to: Address, data: Hex): void {
  if (!isAddressEqual(to, MULTICALL3_FROM)) throw new Error("A reset of Circle's adapter must go through Multicall3From.");
  const calls = decodeBatch(data);
  if (!calls || calls.length === 0 || calls.length > RESET_TOKENS.length + 1) throw new Error("This is not a batch of the reset's own calls.");
  const seen = new Set<string>();
  for (const c of calls) {
    const key = c.target.toLowerCase();
    const isApproval = RESET_TOKENS.some((t) => isAddressEqual(t, c.target)) && c.callData.toLowerCase() === RESET_APPROVE;
    const isDeauthorize = isAddressEqual(c.target, MORPHO) && c.callData.toLowerCase() === RESET_DEAUTHORIZE;
    if (c.allowFailure !== false || (!isApproval && !isDeauthorize) || seen.has(key)) throw new Error("This batch holds a call that the adapter reset does not allow.");
    seen.add(key);
  }
}

// The one way to send Circle's adapter an allowance of 0 or take away its Morpho authorisation. simulateAndSend refuses
// anything that reaches the adapter without a conversion, so a reset comes through here, which holds the batch to the reset's
// two calls and then runs the same gates: the wallet is on Arc as this account (C4), an eth_call and gas estimate on Arc
// pass, and the wallet proves it is still on Arc when it signs.
export async function sendAdapterReset({ account, to, data, onStep = () => {} }: { account: Address; to: Address; data: Hex; onStep?: (step: TxStep) => void }): Promise<TxOutcome> {
  try {
    assertAdapterReset(to, data);
  } catch (error) {
    return refusal("adapter reset", (error as Error).message, "Nothing was sent.");
  }
  const client = publicArc();
  onStep("checking");
  const off = walletOffArc(account);
  if (off) return off;

  let estimate: bigint;
  let fees: Fees;
  try {
    await client.call({ account, to, data });
    estimate = await client.estimateGas({ account, to, data });
    fees = await feesNow();
  } catch {
    return { ok: false, stage: "failed", message: "Arc's dry run of the reset did not pass, so nothing was sent. Try again in a moment." };
  }
  return signAndConfirm({ account, to, data, gas: feeFigures(estimate, fees).gasLimit, fees, onStep });
}

// One path for every money action: check the wallet is on Arc (C4), simulate with eth_call and stop on any revert
// with plain words, then ask the wallet, then wait for Arc. Nothing reaches the wallet unless the simulation passed.
export async function simulateAndSend({ account, to, data, onStep, usdcOut = 0n, conversion }: SendArgs): Promise<TxOutcome> {
  const client = publicArc();
  onStep("checking");

  const off = walletOffArc(account);
  if (off) return off;

  // Anything that reaches Circle's adapter goes through the conversion path, and a batch that does so without carrying its
  // Conversion is refused: the rules below cannot be skipped by leaving the description out.
  let reaches: boolean;
  try {
    reaches = reachesSwapAdapter(to, data);
  } catch {
    reaches = true;
  }
  if (conversion || reaches) {
    if (!conversion) return refusal("conversion", "This payment reaches Circle's swap adapter without saying what it converts, so Adag will not send it.", "Nothing was sent. Reload the page and try again.");
    return sendConversion({ client, account, to, data, onStep, usdcOut, conversion, requireEffects: true });
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

  return signAndConfirm({ account, to, data, gas: figures.gasLimit, fees, onStep });
}

async function signAndConfirm({ account, to, data, gas, fees, onStep, effects }: { account: Address; to: Address; data: Hex; gas: bigint; fees: Fees; onStep: (step: TxStep) => void; effects?: "checked" | "unavailable" }): Promise<TxOutcome> {
  onStep("signing");
  let hash: Hex;
  try {
    // chainId makes the wallet prove it is still on Arc at the moment of signing (C4).
    hash = await sendTransaction(wagmiConfig, {
      account,
      chainId: arc.id,
      to,
      data,
      gas,
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
  return effects ? { ok: true, hash, receipt, effects } : { ok: true, hash, receipt };
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
