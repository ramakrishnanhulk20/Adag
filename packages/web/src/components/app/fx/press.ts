import { encodeFunctionData, type Address, type Hex } from "viem";
import { requestPlan } from "@/lib/fx/circle";
import { EstimateError, readEurUsd, type EurUsdReading } from "@/lib/fx/estimate";
import { checkAdapterPreflight, exposureIsClear, readAdapterExposure } from "@/lib/fx/preflight";
import { erc20Abi } from "@/lib/pay/abi";
import { USDC, EXPLORER, type Currency } from "@/lib/pay/constants";
import { feesNow, publicArc, sendAdapterReset, type TxOutcome } from "@/lib/wallet/send";
import type { TxState } from "../TxProgress";
import { TOO_LARGE } from "./figures";

type Client = ReturnType<typeof publicArc>;

// What the builders need beside the plan, read together right after Circle answers: the euro price AdagBills reads, the
// chain's clock at that block, the payer's balance of the currency the swap buys at that same block, and the fee
// ceiling the balance check's gas slack is worked out from (C66, C68, C70).
export type Pinned = { plan: Hex; chainTime: bigint; outputBalance: bigint; maxFeePerGas: bigint; rate: EurUsdReading };

// C73: the one request per press. requestPlan may repeat the identical request twice when Circle reports no route or rate
// limiting. Nothing here raises the cushion or tries a second route; a refusal comes back as Circle's fixed sentence and
// the payer has to press again. Never called on load or refresh.
export async function askCircle(
  client: Client,
  a: { payer: Address; sell: Currency; buy: Currency; amountIn: bigint; minOut: bigint },
): Promise<{ ok: true; pinned: Pinned } | { ok: false; message: string }> {
  const asked = await requestPlan({ tokenIn: a.sell.address, amountIn: a.amountIn, tokenOut: a.buy.address, minOut: a.minOut, account: a.payer });
  if (!asked.ok) return { ok: false, message: asked.error };
  let eur: Awaited<ReturnType<typeof readEurUsd>>;
  try {
    eur = await readEurUsd(client);
  } catch (error) {
    return { ok: false, message: error instanceof EstimateError ? `${error.message} Nothing was sent.` : "Adag could not read the euro price from Arc. Nothing was sent. Try again." };
  }
  try {
    const [outputBalance, fees] = await Promise.all([
      client.readContract({ address: a.buy.address, abi: erc20Abi, functionName: "balanceOf", args: [a.payer], blockNumber: eur.blockNumber }),
      feesNow(),
    ]);
    return { ok: true, pinned: { plan: asked.plan.calldata, chainTime: eur.chainTime, outputBalance, maxFeePerGas: fees.maxFeePerGas, rate: eur.reading } };
  } catch {
    return { ok: false, message: "Arc did not answer with your balance. Nothing was sent. Try again." };
  }
}

// C71 fails closed twice. The sender refuses a conversion whenever its own trace of the transfers is unavailable. This is
// the early warning: the screen asks first whether the connection can trace them at all, and stops with the same sentence
// before the sender is reached.
export async function effectsCanBeChecked(client: Client): Promise<boolean> {
  try {
    const data = encodeFunctionData({ abi: erc20Abi, functionName: "balanceOf", args: [USDC] });
    await client.simulateBlocks({ blocks: [{ calls: [{ to: USDC, data }] }], traceTransfers: true });
    return true;
  } catch {
    return false;
  }
}

// Every refusal the sender writes itself is already a full sentence, so it is shown as one, not as an Arc dry run. The
// gas one is replaced by the sentence this screen promises for a conversion that is too large for one signature.
export function conversionFailure(out: Exclude<TxOutcome, { ok: true }>): TxState {
  if (out.stage === "refused") {
    // The sender's own gas check, or the node's out-of-gas answer when the batch needs more than the fixed ceiling.
    if (out.error.name === "gas" || /out of gas/i.test(out.error.name)) return { kind: "failed", message: TOO_LARGE };
    if (OWN_REFUSALS.has(out.error.name)) return { kind: "failed", message: out.error.text };
    return { kind: "refused", error: out.error };
  }
  return { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` };
}

const OWN_REFUSALS = new Set(["conversion bytes", "plan expired", "fee moved", "simulation", "effects", "effects unavailable", "plan used", "conversion"]);

// C67, read back after the batch: all three allowances to Circle's adapter and its Morpho authorisation are 0 again.
// null when the read fails, which a screen says out loud and never counts as clear.
export async function adapterReadBack(client: Client, payer: Address): Promise<boolean | null> {
  const exposure = await readAdapterExposure(client, payer);
  return exposure === null ? null : exposureIsClear(exposure);
}

// The one transaction that may name Circle's adapter without a conversion: it only takes access away (every allowance to
// the adapter back to 0, and its Morpho authorisation withdrawn). The same builder rebuilds the batch from a fresh read, and
// send.ts's sendAdapterReset sends it: it refuses any call but those two kinds, then runs the sender's own wallet, chain and
// dry-run checks before the wallet is asked.
export async function resetAdapterAccess(a: { account: Address; loanToken: Address }): Promise<{ ok: true; hash: Hex | null } | { ok: false; message: string }> {
  const pre = await checkAdapterPreflight(publicArc(), a.account, a.loanToken);
  if (pre.state === "clear") return { ok: true, hash: null };
  if (pre.state === "unreadable") return { ok: false, message: pre.text };
  const { reset } = pre;
  const out = await sendAdapterReset({ account: a.account, to: reset.to, data: reset.data });
  if (out.ok) return { ok: true, hash: out.hash };
  if (out.stage === "refused") return { ok: false, message: out.error.text };
  if (out.stage === "unconfirmed") return { ok: false, message: "Arc has not confirmed the reset yet. Check the transaction before trying again." };
  if (out.stage === "failed" && out.hash) return { ok: false, message: "The reset reverted on Arc, so nothing changed apart from the fee." };
  return { ok: false, message: out.message };
}
