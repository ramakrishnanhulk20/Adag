import { concat, decodeFunctionData, encodeFunctionData, encodePacked, getAddress, isAddressEqual, size, slice, hexToBigInt, hexToNumber, type Address, type Hex } from "viem";
import { adagAbi, erc20Abi, morphoAbi } from "../pay/abi";
import { assertCallShapes } from "../pay/build";
import { ADAG_BILLS, CIRBTC, EURC, MARKET_EURC, MARKET_USDC, MORPHO, USDC, type MarketParams } from "../pay/constants";
import { verifyMarketParams } from "../pay/market";
import { multiSendAbi } from "./abi";
import { MULTISEND_CALL_ONLY, ZERO_ADDRESS } from "./constants";

// Every refusal below is a sentence this codebase wrote, so the propose route may pass it on (C62).
export class SafeShapeError extends Error {}

// One call inside a Safe batch: always a plain call (operation 0) with no value.
export type SafeInnerCall = { to: Address; value: 0n; data: Hex; operation: 0 };

// C51: inside a Safe batch, only these, all fixed at build time. No Memo and no Multicall3From: both need an ordinary
// wallet as the sender, and here the sender is the Safe. ADAG_BILLS is the current contract only: the first deployment
// is paid from a wallet, so the propose route refuses a Safe payment to it.
const SAFE_TARGETS: readonly Address[] = [ADAG_BILLS, MORPHO, USDC, EURC, CIRBTC];
const SPENDERS: readonly Address[] = [MORPHO, ADAG_BILLS];
const APPROVE = "0x095ea7b3";
const ENROL = encodeFunctionData({ abi: adagAbi, functionName: "enrol" }).toLowerCase();
const PAY = encodeFunctionData({ abi: adagAbi, functionName: "pay", args: [1n] }).slice(0, 10).toLowerCase();

export function encodeMultiSend(calls: readonly SafeInnerCall[]): Hex {
  const packed = concat(
    calls.map((c) => encodePacked(["uint8", "address", "uint256", "uint256", "bytes"], [c.operation, c.to, c.value, BigInt(size(c.data)), c.data])),
  );
  return encodeFunctionData({ abi: multiSendAbi, functionName: "multiSend", args: [packed] });
}

// The inverse of encodeMultiSend, strict: any leftover or short bytes throw.
export function decodeMultiSend(data: Hex): { operation: number; to: Address; value: bigint; data: Hex }[] {
  const { functionName, args } = decodeFunctionData({ abi: multiSendAbi, data });
  if (functionName !== "multiSend") throw new SafeShapeError("The Safe batch is not a MultiSend call.");
  const packed = args[0];
  const total = size(packed);
  const out: { operation: number; to: Address; value: bigint; data: Hex }[] = [];
  let at = 0;
  while (at < total) {
    if (at + 85 > total) throw new SafeShapeError("The Safe batch is cut short.");
    const operation = hexToNumber(slice(packed, at, at + 1));
    const to = getAddress(slice(packed, at + 1, at + 21));
    const value = hexToBigInt(slice(packed, at + 21, at + 53));
    const length = Number(hexToBigInt(slice(packed, at + 53, at + 85)));
    if (at + 85 + length > total) throw new SafeShapeError("The Safe batch is cut short.");
    const inner = length === 0 ? "0x" : slice(packed, at + 85, at + 85 + length);
    out.push({ operation, to, value, data: inner });
    at += 85 + length;
  }
  return out;
}

// C51 on the inner calls, from their bytes: fixed targets only, plain calls, no value, approvals only to Morpho or
// AdagBills, and every Morpho onBehalf and receiver the Safe (C55). The builder runs this on its own output, and the
// server runs it again on whatever the browser sends before proposing anything.
// AdagBills may be called only to pay a bill, or to enrol the Safe's existing loan (C55). Enrol is allowed only as
// the one and only inner call: a payment in the same execution would revert EnrolledThisBlock, and an enrol after a
// borrow in one batch is exactly what the contract forbids.
function isAdagMarket(params: MarketParams): boolean {
  return [MARKET_USDC, MARKET_EURC].some((id) => {
    try {
      verifyMarketParams(params, id);
      return true;
    } catch {
      return false;
    }
  });
}

export function assertSafeInnerCalls(safe: Address, calls: readonly { operation: number; to: Address; value: bigint; data: Hex }[]): void {
  if (calls.length === 0) throw new SafeShapeError("The Safe batch is empty.");
  for (const c of calls) {
    if (c.operation !== 0) throw new SafeShapeError("Refusing a Safe batch step that is not a plain call.");
    if (c.value !== 0n) throw new SafeShapeError("Refusing a Safe batch step that sends value.");
    if (!SAFE_TARGETS.some((t) => isAddressEqual(t, c.to))) throw new SafeShapeError(`Refusing a Safe batch that calls ${c.to}.`);
    const selector = c.data.slice(0, 10).toLowerCase();
    if (isAddressEqual(c.to, ADAG_BILLS)) {
      if (selector === ENROL) {
        if (calls.length !== 1 || c.data.toLowerCase() !== ENROL) throw new SafeShapeError("Refusing a Safe batch that records the loan alongside anything else.");
      } else if (selector !== PAY) {
        throw new SafeShapeError("Refusing an AdagBills call other than paying a bill or recording the Safe's loan.");
      }
    }
    if (selector === APPROVE) {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: c.data });
      if (!SPENDERS.some((s) => isAddressEqual(s, args[0] as Address))) throw new SafeShapeError(`Refusing an approval to ${String(args[0])}.`);
    }
    if (isAddressEqual(c.to, MORPHO)) {
      const decoded = decodeFunctionData({ abi: morphoAbi, data: c.data });
      const args = decoded.args as readonly unknown[];
      const accounts: unknown[] =
        decoded.functionName === "supplyCollateral" ? [args[2]] : decoded.functionName === "borrow" ? [args[3], args[4]] : decoded.functionName === "repay" ? [args[3]] : decoded.functionName === "withdrawCollateral" ? [args[2], args[3]] : ["refused"];
      if (accounts.some((a) => typeof a !== "string" || !isAddressEqual(a as Address, safe))) {
        throw new SafeShapeError("Refusing a Morpho step whose account is not the Safe.");
      }
      // C51: the pledge and the borrow must name one of Adag's two markets by hash, so no field, oracle or rate model
      // included, can point the Safe's bitcoin at a market the app never chose.
      if (decoded.functionName === "borrow" || decoded.functionName === "supplyCollateral") {
        if (!isAdagMarket(args[0] as MarketParams)) throw new SafeShapeError("Refusing a Morpho step on a market that is not one of Adag's two.");
      }
    }
  }
  // C3 and C51: then the very rule the browser's builder holds a Safe batch to, so the server refuses every call shape
  // the browser refuses. The server is sent only the batch, so its bills are the ones its own pay(id) calls name, each
  // to be paid once; assertSafeAmounts then holds them to AdagBills' records.
  try {
    const bills = payIds(calls).map((id) => ({ contract: ADAG_BILLS, id }));
    assertCallShapes(calls.map((c) => ({ target: c.to, allowFailure: false, callData: c.data })), null, null, { payer: safe, bills, sender: "safe" });
  } catch (error) {
    // Only build.ts's own plain-Error sentences are passed on (C62). A decoder error stays a library error, which the
    // route answers with its own fixed sentence.
    if (error instanceof Error && error.constructor === Error) throw new SafeShapeError(error.message);
    throw error;
  }
}

export type BillAmount = { currency: Address; amount: bigint };

export const AMOUNTS_MISMATCH = "The amounts in this Safe batch do not match the bills it pays, so nothing was proposed.";

export function payIds(calls: readonly { to: Address; data: Hex }[]): bigint[] {
  return calls
    .filter((c) => isAddressEqual(c.to, ADAG_BILLS) && c.data.slice(0, 10).toLowerCase() === PAY)
    .map((c) => decodeFunctionData({ abi: adagAbi, data: c.data }).args[0] as bigint);
}

// C51 on the server, amounts as well as shapes: `bills` is read from AdagBills for every pay(id) in the batch, never
// taken from the browser. Each approval to AdagBills must equal the sum of that token's bills, each borrow the sum of
// that currency's bills, by assets and with no shares, and no other token may be approved to AdagBills.
export function assertSafeAmounts(calls: readonly { to: Address; data: Hex }[], bills: ReadonlyMap<bigint, BillAmount>): void {
  const owed = new Map<string, bigint>();
  for (const id of payIds(calls)) {
    const bill = bills.get(id);
    if (!bill) throw new SafeShapeError(AMOUNTS_MISMATCH);
    const token = bill.currency.toLowerCase();
    owed.set(token, (owed.get(token) ?? 0n) + bill.amount);
  }
  // The cirBTC approval to Morpho is exact too: each one is spent in full by the very next pledge, before any other
  // cirBTC approval, and none is left standing at the end of the batch.
  let pledgeApproval: bigint | null = null;
  for (const c of calls) {
    if (c.data.slice(0, 10).toLowerCase() === APPROVE) {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: c.data });
      if (isAddressEqual(args[0] as Address, ADAG_BILLS) && owed.get(c.to.toLowerCase()) !== args[1]) throw new SafeShapeError(AMOUNTS_MISMATCH);
      if (isAddressEqual(c.to, CIRBTC) && isAddressEqual(args[0] as Address, MORPHO)) {
        if (pledgeApproval !== null) throw new SafeShapeError(AMOUNTS_MISMATCH);
        pledgeApproval = args[1] as bigint;
      }
    }
    if (isAddressEqual(c.to, MORPHO)) {
      const decoded = decodeFunctionData({ abi: morphoAbi, data: c.data });
      if (decoded.functionName === "supplyCollateral") {
        if (pledgeApproval === null || decoded.args[1] !== pledgeApproval) throw new SafeShapeError(AMOUNTS_MISMATCH);
        pledgeApproval = null;
        continue;
      }
      if (decoded.functionName !== "borrow") continue;
      const [params, assets, shares] = decoded.args as readonly [MarketParams, bigint, bigint, Address, Address];
      if (shares !== 0n || owed.get(params.loanToken.toLowerCase()) !== assets) throw new SafeShapeError(AMOUNTS_MISMATCH);
    }
  }
  if (pledgeApproval !== null) throw new SafeShapeError(AMOUNTS_MISMATCH);
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
  if (!isAddressEqual(tx.to, MULTISEND_CALL_ONLY)) throw new SafeShapeError("A Safe payment must go through the canonical MultiSendCallOnly.");
  if (tx.operation !== 1) throw new SafeShapeError("A Safe payment reaches MultiSendCallOnly by delegatecall only.");
  if (tx.value !== 0n || tx.safeTxGas !== 0n || tx.baseGas !== 0n || tx.gasPrice !== 0n) throw new SafeShapeError("A Safe payment carries no value and no gas refund.");
  if (!isAddressEqual(tx.gasToken, ZERO_ADDRESS) || !isAddressEqual(tx.refundReceiver, ZERO_ADDRESS)) throw new SafeShapeError("A Safe payment pays no refund to anyone.");
  if (tx.nonce < 0n) throw new SafeShapeError("The Safe nonce is not valid.");
  assertSafeInnerCalls(safe, decodeMultiSend(tx.data));
}
