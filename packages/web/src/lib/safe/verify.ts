import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress, type Address, type Hex, type PublicClient } from "viem";
import { safeAbi, simulateTxAccessorAbi } from "./abi";
import { MIN_SAFE_VERSION, SIMULATE_TX_ACCESSOR } from "./constants";
import type { SafeTxFields } from "./multisend";
import { safeTxHash } from "./typedData";
import { CHAIN_ID } from "../pay/constants";

// A refusal worded here, safe to show; any other error from these reads is a library's and stays on the server (C62).
export class SafeCheckError extends Error {}

export type SafeInfo ={ address: Address; version: string; owners: Address[]; threshold: number; nonce: bigint };

function versionAtLeast(version: string, min: readonly [number, number, number]): boolean {
  const m = /^(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return false;
  const v = [Number(m[1]), Number(m[2]), Number(m[3])];
  for (let i = 0; i < 3; i++) {
    if (v[i]! > min[i]!) return true;
    if (v[i]! < min[i]!) return false;
  }
  return true;
}

// C52, read from the Safe contract itself on Arc: it is a Safe of version 1.3.0 or later, the connected account is an
// owner by isOwner, and the nonce is the contract's. Anything the service says about the Safe is only a hint.
export async function verifySafe(client: PublicClient, address: string, owner: string): Promise<SafeInfo> {
  if (!isAddress(address, { strict: false })) throw new SafeCheckError("That is not an address.");
  if (!isAddress(owner, { strict: false })) throw new SafeCheckError("The connected account is not a valid address.");
  const safe = getAddress(address);
  const who = getAddress(owner);
  let chain: number;
  let code: Hex | undefined;
  try {
    [chain, code] = await Promise.all([client.getChainId(), client.getCode({ address: safe })]);
  } catch {
    // viem's transport errors carry the full RPC URL, key included, so their text never leaves here (C62).
    throw new SafeCheckError("Arc did not answer, so this Safe could not be checked. Nothing was proposed.");
  }
  if (chain !== CHAIN_ID) throw new SafeCheckError("Arc did not answer as Arc mainnet, so this Safe could not be checked.");
  if (!code || code === "0x") throw new SafeCheckError("There is no contract at this address on Arc, so it is not a Safe.");
  let version: string;
  let owners: readonly Address[];
  let threshold: bigint;
  let nonce: bigint;
  let isOwner: boolean;
  try {
    [version, owners, threshold, nonce, isOwner] = await Promise.all([
      client.readContract({ address: safe, abi: safeAbi, functionName: "VERSION" }),
      client.readContract({ address: safe, abi: safeAbi, functionName: "getOwners" }),
      client.readContract({ address: safe, abi: safeAbi, functionName: "getThreshold" }),
      client.readContract({ address: safe, abi: safeAbi, functionName: "nonce" }),
      client.readContract({ address: safe, abi: safeAbi, functionName: "isOwner", args: [who] }),
    ]);
  } catch {
    throw new SafeCheckError("This address does not answer like a Safe, so Adag will not ask anyone to sign for it.");
  }
  if (!versionAtLeast(version, MIN_SAFE_VERSION)) throw new SafeCheckError(`This Safe is version ${version}. Adag needs Safe 1.3.0 or later.`);
  if (!isOwner) throw new SafeCheckError("Your connected wallet is not an owner of this Safe, so it cannot propose a payment from it. Nothing was signed.");
  if (threshold < 1n) throw new SafeCheckError("This Safe has no signing threshold set.");
  return { address: safe, version, owners: owners.map((o) => getAddress(o)), threshold: Number(threshold), nonce };
}

// C52: the hash the owner signs must equal the one the Safe contract computes for the same fields.
export async function onChainSafeTxHash(client: PublicClient, safe: Address, tx: SafeTxFields): Promise<Hex> {
  return client.readContract({
    address: safe,
    abi: safeAbi,
    functionName: "getTransactionHash",
    args: [tx.to, tx.value, tx.data, tx.operation, tx.safeTxGas, tx.baseGas, tx.gasPrice, tx.gasToken, tx.refundReceiver, tx.nonce],
  });
}

export async function checkedSafeTxHash(client: PublicClient, safe: Address, tx: SafeTxFields): Promise<Hex> {
  const local = safeTxHash(safe, tx);
  const chain = await onChainSafeTxHash(client, safe, tx);
  if (local.toLowerCase() !== chain.toLowerCase()) throw new SafeCheckError("The Safe computes a different hash for this payment, so it was not signed.");
  return local;
}

export type SafeSimulation = { ok: true } | { ok: false; returnData: Hex };

// C54: run the batch as the Safe would, now, on live state. Safe's simulateAndRevert delegatecalls the canonical
// SimulateTxAccessor, which runs the MultiSend by delegatecall in the Safe's own context, then reverts with the result.
// A plain eth_call from the Safe to MultiSend would not do: called directly, MultiSend becomes the sender.
export async function simulateFromSafe(client: PublicClient, safe: Address, tx: { to: Address; data: Hex }): Promise<SafeSimulation> {
  const payload = encodeSimulate(tx);
  let raw: Hex | null = null;
  try {
    await client.call({ to: safe, data: encodeSimulateAndRevert(payload) });
  } catch (error) {
    raw = revertData(error);
  }
  if (!raw || raw.length < 2 + 64 * 2) throw new SafeCheckError("The Safe did not return a simulation result.");
  // simulateAndRevert reverts with: the delegatecall's success word, the result length, then the result.
  const accessorOk = BigInt(`0x${raw.slice(2, 66)}`) === 1n;
  const result = `0x${raw.slice(130)}` as Hex;
  if (!accessorOk) return { ok: false, returnData: result };
  const [, success, returnData] = decodeFunctionResult({ abi: simulateTxAccessorAbi, functionName: "simulate", data: result });
  return success ? { ok: true } : { ok: false, returnData };
}

function encodeSimulate(tx: { to: Address; data: Hex }): Hex {
  return encodeFunctionData({ abi: simulateTxAccessorAbi, functionName: "simulate", args: [tx.to, 0n, tx.data, 1] });
}

function encodeSimulateAndRevert(payload: Hex): Hex {
  return encodeFunctionData({ abi: safeAbi, functionName: "simulateAndRevert", args: [SIMULATE_TX_ACCESSOR, payload] });
}

function revertData(error: unknown, depth = 0): Hex | null {
  if (depth > 6 || error == null || typeof error !== "object") return null;
  const e = error as { data?: unknown; cause?: unknown };
  if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data as Hex;
  if (e.data && typeof e.data === "object" && typeof (e.data as { data?: unknown }).data === "string") return (e.data as { data: Hex }).data;
  return revertData(e.cause, depth + 1);
}
