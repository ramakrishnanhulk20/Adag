import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, isAddressEqual, isHex, numberToHex, size, type Address, type Hex } from "viem";
import { adagAbi, erc20Abi, memoAbi, morphoAbi, multicall3FromAbi } from "./abi";
import {
  ADAG_BILLS,
  BILL_STATUS,
  CIRBTC,
  EURC,
  MAX_REFERENCE_BYTES,
  MEMO,
  MORPHO,
  MULTICALL3_FROM,
  USDC,
  type Currency,
  type MarketParams,
} from "./constants";
import { assertMarketConstants, currencyOf, verifyMarketParams } from "./market";

// The fields of bill(id), exactly as the contract returns them, plus the id they were read for.
export type Bill = {
  id: bigint;
  payee: Address;
  status: number;
  due: bigint;
  currency: Address;
  createdAt: bigint;
  amount: bigint;
  payer: Address;
  paidAt: bigint;
  ref: Hex;
};

export type Call3 = { target: Address; allowFailure: false; callData: Hex };
export type Batch = { to: Address; data: Hex; calls: readonly Call3[] };
export type DirectCall = { to: Address; data: Hex };

// C3: a batch may only reach these, all fixed at build time. Nothing from a link or an RPC answer is ever added.
const TARGETS: readonly Address[] = [ADAG_BILLS, MORPHO, MEMO, MULTICALL3_FROM, USDC, EURC, CIRBTC];
const SPENDERS: readonly Address[] = [MORPHO, ADAG_BILLS];
const APPROVE_SELECTOR = "0x095ea7b3";

export const PLEDGE_MARGIN_PERCENT = 105n;

// C13: the contract's own figure plus 5%, rounded up, plus one satoshi for Morpho's share rounding. The contract's
// 40% check is the guard; this is only a suggestion. Zero stays zero, because Morpho refuses an empty pledge.
export function suggestPledge(collateralNeeded: bigint): bigint {
  if (collateralNeeded <= 0n) return 0n;
  return (collateralNeeded * PLEDGE_MARGIN_PERCENT + 99n) / 100n + 1n;
}

export const memoId = (billId: bigint): Hex => numberToHex(billId, { size: 32 });

function checkedPayer(payer: string): Address {
  if (!isAddress(payer, { strict: false })) throw new Error("The paying wallet address is not a valid address.");
  return getAddress(payer);
}

function payableCurrency(bill: Bill, payer: Address): Currency {
  if (typeof bill.id !== "bigint" || bill.id < 1n) throw new Error("A bill number must be a whole number of 1 or more.");
  if (bill.status !== BILL_STATUS.Open) throw new Error(`Bill #${bill.id} is not open for payment.`);
  if (typeof bill.amount !== "bigint" || bill.amount <= 0n) throw new Error(`Bill #${bill.id} has no amount to pay.`);
  if (isAddressEqual(bill.payee, payer)) throw new Error("You cannot pay a bill you wrote yourself.");
  if (!isHex(bill.ref, { strict: true }) || size(bill.ref) > MAX_REFERENCE_BYTES) throw new Error(`Bill #${bill.id} has an unreadable reference.`);
  const currency = currencyOf(bill.currency);
  if (!currency) throw new Error(`Bill #${bill.id} is not in USDC or EURC.`);
  return currency;
}

const call = (target: Address, callData: Hex): Call3 => ({ target, allowFailure: false, callData });

const approve = (token: Address, spender: Address, amount: bigint) =>
  call(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }));

// The bill's reference goes into Memo exactly as the chain stored it, never re-encoded from displayed text.
const memoPay = (bill: Bill) =>
  call(
    MEMO,
    encodeFunctionData({
      abi: memoAbi,
      functionName: "memo",
      args: [ADAG_BILLS, encodeFunctionData({ abi: adagAbi, functionName: "pay", args: [bill.id] }), memoId(bill.id), bill.ref],
    }),
  );

function assertCalls(calls: readonly Call3[]) {
  for (const c of calls) {
    if (!TARGETS.some((t) => isAddressEqual(t, c.target))) throw new Error(`Refusing a batch that calls ${c.target}.`);
    if (c.allowFailure !== false) throw new Error("Refusing a batch step that may fail on its own.");
    if (c.callData.slice(0, 10).toLowerCase() === APPROVE_SELECTOR) {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: c.callData });
      if (!SPENDERS.some((s) => isAddressEqual(s, args[0] as Address))) throw new Error(`Refusing an approval to ${String(args[0])}.`);
    }
  }
}

function batch(calls: Call3[]): Batch {
  assertCalls(calls);
  return { to: MULTICALL3_FROM, data: encodeFunctionData({ abi: multicall3FromAbi, functionName: "aggregate3", args: [calls] }), calls };
}

// ARCHITECTURE.md section 6, pay from balance: exact approval to Adag, then pay(N) through Memo.
export function buildPayFromBalance(bill: Bill, payer: string): Batch {
  const who = checkedPayer(payer);
  const currency = payableCurrency(bill, who);
  return batch([approve(currency.address, ADAG_BILLS, bill.amount), memoPay(bill)]);
}

// ARCHITECTURE.md section 6, pay from bitcoin. `marketParams` is what Morpho returned; it must hash to the fixed
// id and equal the fixed fields, and the calldata then carries the build-time copy of those same values (C3, C18).
export function buildPayFromBitcoin(bill: Bill, payer: string, pledgeCirBtc: bigint, marketParams: MarketParams): Batch {
  const who = checkedPayer(payer);
  const currency = payableCurrency(bill, who);
  if (typeof pledgeCirBtc !== "bigint" || pledgeCirBtc < 0n) throw new Error("The pledge must be zero or more satoshis.");
  verifyMarketParams(marketParams, currency.marketId);
  assertMarketConstants(marketParams, currency);
  const params: MarketParams = currency.params;

  const calls: Call3[] = [];
  if (pledgeCirBtc > 0n) {
    calls.push(
      approve(CIRBTC, MORPHO, pledgeCirBtc),
      call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [params, pledgeCirBtc, who, "0x"] })),
    );
  }
  calls.push(
    call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params, bill.amount, 0n, who, who] })),
    approve(currency.address, ADAG_BILLS, bill.amount),
    memoPay(bill),
  );
  return batch(calls);
}

// A direct transaction from the supplier's wallet, not a batch.
export function buildVoid(billId: bigint): DirectCall {
  if (typeof billId !== "bigint" || billId < 1n) throw new Error("A bill number must be a whole number of 1 or more.");
  return { to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "voidBill", args: [billId] }) };
}

export const APPROVAL_SPENDERS = SPENDERS;
export const BATCH_TARGETS = TARGETS;
