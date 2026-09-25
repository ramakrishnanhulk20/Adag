import { parseGwei, type Address, type Hex, type TransactionReceipt } from "viem";
import { arc } from "viem/chains";
import { getConnection, getPublicClient, sendTransaction, waitForTransactionReceipt } from "wagmi/actions";
import { decodeAdagError, type PlainError } from "@/lib/pay/errors";
import { wagmiConfig } from "./config";

// Arc drops transactions priced under 20 gwei without an error, so this is a floor, never a target.
const MIN_MAX_FEE = parseGwei("20");
const PRIORITY_FEE = parseGwei("1");
const RECEIPT_TIMEOUT_MS = 120_000;

export type TxStep = "checking" | "signing" | "confirming" | "rereading";

export type TxOutcome =
  | { ok: true; hash: Hex; receipt: TransactionReceipt }
  | { ok: false; stage: "refused"; error: PlainError }
  | { ok: false; stage: "declined" | "failed"; message: string; hash?: Hex };

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

export function publicArc() {
  const client = getPublicClient(wagmiConfig, { chainId: arc.id });
  if (!client) throw new Error("No Arc client is configured.");
  return client;
}

// Fees as prove-it sets them: twice the base fee plus the tip, never under Arc's 20 gwei floor.
export async function feesNow() {
  const block = await publicArc().getBlock();
  const base = block.baseFeePerGas ?? 0n;
  const doubled = 2n * base + PRIORITY_FEE;
  const maxFeePerGas = doubled > MIN_MAX_FEE ? doubled : MIN_MAX_FEE;
  const expected = base + PRIORITY_FEE < maxFeePerGas ? base + PRIORITY_FEE : maxFeePerGas;
  return { maxFeePerGas, maxPriorityFeePerGas: PRIORITY_FEE, expected };
}

type SendArgs = {
  account: Address;
  to: Address;
  data: Hex;
  onStep: (step: TxStep) => void;
};

// One path for every money action: check the wallet is on Arc (C4), simulate with eth_call and stop on any revert
// with plain words, then ask the wallet, then wait for Arc. Nothing reaches the wallet unless the simulation passed.
export async function simulateAndSend({ account, to, data, onStep }: SendArgs): Promise<TxOutcome> {
  const client = publicArc();
  onStep("checking");

  const connection = getConnection(wagmiConfig);
  if (connection.status !== "connected" || connection.chainId !== arc.id || connection.address?.toLowerCase() !== account.toLowerCase()) {
    return { ok: false, stage: "failed", message: "Your wallet is not on Arc mainnet with this address any more. Nothing was sent." };
  }

  let gas: bigint;
  try {
    await client.call({ account, to, data });
    gas = ((await client.estimateGas({ account, to, data })) * 125n) / 100n;
  } catch (error) {
    return { ok: false, stage: "refused", error: decodeAdagError(error) };
  }

  let fees: Awaited<ReturnType<typeof feesNow>>;
  try {
    fees = await feesNow();
  } catch {
    return { ok: false, stage: "failed", message: "Arc did not answer with the current fee. Nothing was sent. Try again." };
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
    return { ok: false, stage: "failed", hash, message: "Arc has not confirmed it yet. Check the transaction link before trying again, so you never pay twice." };
  }
  if (receipt.status !== "success") {
    return { ok: false, stage: "failed", hash, message: "The transaction reverted on Arc, so nothing moved apart from the fee." };
  }
  onStep("rereading");
  return { ok: true, hash, receipt };
}
