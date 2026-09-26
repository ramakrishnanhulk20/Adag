import { concat, decodeFunctionData, encodeFunctionData, encodePacked, getAddress, isAddressEqual, size, slice, hexToBigInt, hexToNumber, type Address, type Hex } from "viem";
import { erc20Abi, morphoAbi } from "../pay/abi";
import { ADAG_BILLS, CIRBTC, EURC, MORPHO, USDC } from "../pay/constants";
import { multiSendAbi } from "./abi";
import { MULTISEND_CALL_ONLY, ZERO_ADDRESS } from "./constants";

// One call inside a Safe batch: always a plain call (operation 0) with no value.
export type SafeInnerCall = { to: Address; value: 0n; data: Hex; operation: 0 };

// C51: inside a Safe batch, only these, all fixed at build time. No Memo and no Multicall3From: both need an ordinary
// wallet as the sender, and here the sender is the Safe.
const SAFE_TARGETS: readonly Address[] = [ADAG_BILLS, MORPHO, USDC, EURC, CIRBTC];
const SPENDERS: readonly Address[] = [MORPHO, ADAG_BILLS];
const APPROVE = "0x095ea7b3";

export function encodeMultiSend(calls: readonly SafeInnerCall[]): Hex {
  const packed = concat(
    calls.map((c) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [c.operation, c.to, c.value, BigInt(size(c.data)), c.data])),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

// The inverse of encodeMultiSend, strict: any leftover or short bytes throw.
export function decodeMultiSend(data: Hex): { operation: number; to: Address; value: bigint; data: Hex }[] {
  const { functionName, args } = decodeFunctionData({ abi: multiSendAbi, data });
  if (functionName !== "multiSend") throw new Error("The Safe batch is not a MultiSend call.");
  const packed = args[0];
  const total = size(packed);
  const out: { operation: number; to: Address; value: bigint; data: Hex }[] = [];
  let at = 0;
  while (at < total) {
    if (at + 85 > total) throw new Error("The Safe batch is cut short.");
    const operation = hexToNumber(slice(packed, at, at + 1));
    const to = getAddress(slice(packed, at + 1, at + 21));
    const value = hexToBigInt(slice(packed, at + 21, at + 53));
    const length = Number(hexToBigInt(slice(packed, at + 53, at + 85)));
    if (at + 85 + length > total) throw new Error("The Safe batch is cut short.");
    const inner = length === 0 ? "0x" : slice(packed, at + 85, at + 85 + length);
    out.push({ operation, to, value, data: inner });
    at += 85 + length;
  }
  return out;
}

// C51 on the inner calls, from their bytes: fixed targets only, plain calls, no value, approvals only to Morpho or
// AdagBills, and every Morpho onBehalf and receiver the Safe (C55). The builder runs this on its own output, and the
// server runs it again on whatever the browser sends before proposing anything.
export function assertSafeInnerCalls(safe: Address, calls: readonly { operation: number; to: Address; value: bigint; data: Hex }[]): void {
  if (calls.length === 0) throw new Error("The Safe batch is empty.");
  for (const c of calls) {
    if (c.operation !== 0) throw new Error("Refusing a Safe batch step that is not a plain call.");
    if (c.value !== 0n) throw new Error("Refusing a Safe batch step that sends value.");
    if (!SAFE_TARGETS.some((t) => isAddressEqual(t, c.to))) throw new Error(`Refusing a Safe batch that calls ${c.to}.`);
    const selector = c.data.slice(0, 10).toLowerCase();
    if (selector === APPROVE) {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: c.data });
      if (!SPENDERS.some((s) => isAddressEqual(s, args[0] as Address))) throw new Error(`Refusing an approval to ${String(args[0])}.`);
    }
    if (isAddressEqual(c.to, MORPHO)) {
      const decoded = decodeFunctionData({ abi: morphoAbi, data: c.data });
      const args = decoded.args as readonly unknown[];
      const accounts: unknown[] =
        decoded.functionName === "supplyCollateral" ? [args[2]] : decoded.functionName === "borrow" ? [args[3], args[4]] : decoded.functionName === "repay" ? [args[3]] : decoded.functionName === "withdrawCollateral" ? [args[2], args[3]] : ["refused"];
      if (accounts.some((a) => typeof a !== "string" || !isAddressEqual(a as Address, safe))) {
        throw new Error("Refusing a Morpho step whose account is not the Safe.");
      }
    }
  }
}

export type SafeTxFields = {
  to: Address;
  value: bigint;
  data: Hex;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
  nonce: bigint;
};

// C51 and C54 on the outer transaction: to the canonical MultiSendCallOnly by delegatecall and nothing else, no value,
// and every gas and refund field zero, so any inner failure reverts the whole execution without using the nonce.
export function assertSafeTxShape(safe: Address, tx: SafeTxFields): void {
  if (!isAddressEqual(tx.to, MULTISEND_CALL_ONLY)) throw new Error("A Safe payment must go through the canonical MultiSendCallOnly.");
  if (tx.operation !== 1) throw new Error("A Safe payment reaches MultiSendCallOnly by delegatecall only.");
  if (tx.value !== 0n || tx.safeTxGas !== 0n || tx.baseGas !== 0n || tx.gasPrice !== 0n) throw new Error("A Safe payment carries no value and no gas refund.");
  if (!isAddressEqual(tx.gasToken, ZERO_ADDRESS) || !isAddressEqual(tx.refundReceiver, ZERO_ADDRESS)) throw new Error("A Safe payment pays no refund to anyone.");
  if (tx.nonce < 0n) throw new Error("The Safe nonce is not valid.");
  assertSafeInnerCalls(safe, decodeMultiSend(tx.data));
}
