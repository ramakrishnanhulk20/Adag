import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, isAddressEqual, isHex, numberToHex, size, stringToHex, type Abi, type Address, type Hex } from "viem";
import { adagAbi, erc20Abi, memoAbi, morphoAbi, multicall3FromAbi } from "./abi";
import {
  ADAG_BILLS,
  ADAG_BILLS_FIRST,
  BILL_STATUS,
  CURRENCIES,
  CIRBTC,
  CIRCLE_SWAP_ADAPTER,
  EURC,
  FX_GAS_CAP,
  MAX_REFERENCE_BYTES,
  MEMO,
  MORPHO,
  MULTICALL3_FROM,
  USDC,
  requireDeployment,
  type Currency,
  type MarketParams,
} from "./constants";
import { assertMarketConstants, currencyOf, verifyMarketParams } from "./market";
import { MULTISEND_CALL_ONLY } from "../safe/constants";
import { assertSafeInnerCalls, assertSafeTxShape, encodeMultiSend, type SafeInnerCall } from "../safe/multisend";
import { safeTxFor } from "../safe/typedData";
import { guardAbi } from "../guard/abi";
import { ADAG_GUARD } from "../guard/constants";
import { assertEurUsdFresh, loanCurrencyFor, maxAmountToSell, type EurUsdReading } from "../fx/estimate";
import { EXECUTE_SELECTOR, checkPlan, floorSlack, type Conversion, type PaidBill } from "../fx/plan";

export type { Conversion } from "../fx/plan";

// The fields of bill(id), exactly as the contract returns them, plus the contract and id they were read from (C33).
export type Bill = {
  contract: Address;
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

type BillRecord = {
  payee: string;
  status: number;
  due: bigint;
  currency: string;
  createdAt: bigint;
  amount: bigint;
  payer: string;
  paidAt: bigint;
  ref: Hex;
};

// The one way a bill(id) answer becomes a Bill: tied to the contract it was read from, which must be one of ours.
export function billFromRecord(contract: string, id: bigint, b: BillRecord): Bill {
  return {
    contract: requireDeployment(contract).address,
    id,
    payee: getAddress(b.payee),
    status: b.status,
    due: b.due,
    currency: getAddress(b.currency),
    createdAt: b.createdAt,
    amount: b.amount,
    payer: getAddress(b.payer),
    paidAt: b.paidAt,
    ref: b.ref,
  };
}

export type Call3 = { target: Address; allowFailure: false; callData: Hex };
// `conversion` is present only when the batch runs a swap through Circle's adapter. It carries everything the sender
// needs to check the bytes it signs and the simulation it ran (C65 to C71).
export type Batch = { to: Address; data: Hex; calls: readonly Call3[]; conversion?: Conversion };
export type DirectCall = { to: Address; data: Hex };

// C3: a batch may only reach these, all fixed at build time. Nothing from a link or an RPC answer is ever added.
// Both AdagBills deployments are here, and each bill's pay and approval go to that bill's own contract.
const TARGETS: readonly Address[] = [ADAG_BILLS, ADAG_BILLS_FIRST, MORPHO, MEMO, MULTICALL3_FROM, USDC, EURC, CIRBTC];
const SPENDERS: readonly Address[] = [MORPHO, ADAG_BILLS, ADAG_BILLS_FIRST];
const APPROVE_SELECTOR = "0x095ea7b3";
const BILLS_CONTRACTS: readonly Address[] = [ADAG_BILLS, ADAG_BILLS_FIRST];
const PAY_SELECTOR = encodeFunctionData({ abi: adagAbi, functionName: "pay", args: [1n] }).slice(0, 10).toLowerCase();
const CLEAR_RULE_SELECTOR = encodeFunctionData({ abi: guardAbi, functionName: "clearRule", args: [`0x${"00".repeat(32)}`] }).slice(0, 10).toLowerCase();

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
  requireDeployment(bill.contract);
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

// The bill's reference goes into Memo exactly as the chain stored it, never re-encoded from displayed text. The pay
// goes to the contract the bill was read from.
const memoPay = (bill: Bill) =>
  call(
    MEMO,
    encodeFunctionData({
      abi: memoAbi,
      functionName: "memo",
      args: [requireDeployment(bill.contract).address, encodeFunctionData({ abi: adagAbi, functionName: "pay", args: [bill.id] }), memoId(bill.id), bill.ref],
    }),
  );

// A basket or a Safe payment covers bills of one contract; the approvals go to that contract alone.
function oneContract(bills: readonly Bill[]): Address {
  const contract = requireDeployment(bills[0]!.contract).address;
  if (bills.some((b) => !isAddressEqual(b.contract, contract))) {
    throw new Error("These bills sit on two different AdagBills contracts. One signature pays bills of one contract.");
  }
  return contract;
}

const TRANSFER_SELECTOR = "0xa9059cbb";
const TOKEN_ADDRESSES: readonly Address[] = [USDC, EURC, CIRBTC];

const selectorOf = (c: Call3) => c.callData.slice(0, 10).toLowerCase();

function approvalOf(c: Call3): { spender: Address; amount: bigint } | null {
  if (selectorOf(c) !== APPROVE_SELECTOR) return null;
  try {
    const { args } = decodeFunctionData({ abi: erc20Abi, data: c.callData });
    return { spender: args[0] as Address, amount: args[1] as bigint };
  } catch {
    throw new Error("Refusing an approval that is not readable.");
  }
}

function morphoCallOf(c: Call3) {
  try {
    return decodeFunctionData({ abi: morphoAbi, data: c.callData });
  } catch {
    return null;
  }
}

const isMarketOf = (params: MarketParams, marketId: Hex) => {
  try {
    verifyMarketParams(params, marketId);
    return true;
  } catch {
    return false;
  }
};

// Whether any of these calls reaches Circle's adapter: a call to it, an approval to it, or either of those made in the
// payer's name through Memo or a batch inside the batch, which run the same way. A Memo or nested batch that cannot be
// read counts as reaching it, because nothing can then be said about where it goes.
function reachesAdapter(calls: readonly Call3[], depth: number): boolean {
  if (depth > 3) return true;
  return calls.some((c) => {
    try {
      if (isAddressEqual(c.target, CIRCLE_SWAP_ADAPTER)) return true;
      const approved = approvalOf(c);
      if (approved && isAddressEqual(approved.spender, CIRCLE_SWAP_ADAPTER)) return true;
      if (isAddressEqual(c.target, MEMO)) {
        const { args } = decodeFunctionData({ abi: memoAbi, data: c.callData });
        return reachesAdapter([{ target: args[0] as Address, allowFailure: false, callData: args[1] as Hex }], depth + 1);
      }
      if (isAddressEqual(c.target, MULTICALL3_FROM)) {
        const inner = decodeBatch(c.callData);
        return inner === null ? true : reachesAdapter(inner, depth + 1);
      }
      return false;
    } catch {
      return true;
    }
  });
}

// C65 to C69: the rules for the one swap a batch may contain. The adapter is never on the target or spender lists; a
// batch reaches it only through this rule, which is checked against what the builder decided (the Conversion), not
// against anything read from the batch itself. Every other call is held to the rules in assertCalls as well.
function assertSwapCalls(calls: readonly Call3[], s: Conversion) {
  const adapterAt = calls.flatMap((c, i) => (isAddressEqual(c.target, CIRCLE_SWAP_ADAPTER) ? [i] : []));
  if (adapterAt.length !== 1) {
    throw new Error(adapterAt.length === 0 ? "Refusing a conversion batch with no swap call." : `Refusing a batch with ${adapterAt.length} swap calls. One signature runs exactly one.`);
  }
  const k = adapterAt[0]!;
  const execute = calls[k]!;
  if (selectorOf(execute) !== EXECUTE_SELECTOR) throw new Error("Refusing a call to the swap adapter other than execute.");
  const plan = checkPlan(execute.callData, { account: s.payer, tokenIn: s.tokenIn, tokenOut: s.tokenOut, amountIn: s.amountIn, minOut: s.minOut, latestBlockTimestamp: s.chainTime });
  if (plan.params.execId !== s.execId || plan.params.deadline !== s.deadline) throw new Error("Refusing a swap whose plan is not the one this batch was built for.");

  // The balance check: a self-transfer of the plan's output token, right after the swap, reverts the whole batch unless
  // the payer's balance rose by what the plan was meant to fund (C68). Its floor may be lower than the funded amount by
  // the gas slack on USDC and by nothing else.
  if (s.gas !== FX_GAS_CAP) throw new Error("Refusing a conversion that is not set up to be sent with the fixed gas ceiling.");
  const owed = isAddressEqual(s.tokenOut, USDC) ? floorSlack(s.maxFeePerGas) : 0n;
  if (s.floor <= 0n || s.outputBalance < 0n || s.floor !== s.outputBalance + s.minOut - owed) {
    throw new Error("Refusing a conversion whose balance check is not the balance it started from plus what it funds, less the gas slack on USDC.");
  }
  const floorCall = calls[k + 1];
  if (!floorCall || !isAddressEqual(floorCall.target, s.tokenOut) || selectorOf(floorCall) !== TRANSFER_SELECTOR) {
    throw new Error("Refusing a swap that is not followed by the balance check on the currency it buys.");
  }
  const floorArgs = decodeFunctionData({ abi: erc20Abi, data: floorCall.callData }).args;
  if (!isAddressEqual(floorArgs[0] as Address, s.payer) || floorArgs[1] !== s.floor) throw new Error("Refusing a balance check that does not send the exact floor back to the payer.");

  // The adapter's only power over the payer: an allowance of exactly the amount, set right before the swap, back to 0 after.
  const before = k > 0 ? approvalOf(calls[k - 1]!) : null;
  if (!before || !isAddressEqual(calls[k - 1]!.target, s.tokenIn) || !isAddressEqual(before.spender, CIRCLE_SWAP_ADAPTER) || before.amount !== s.amountIn) {
    throw new Error("Refusing a swap that is not preceded by an approval of exactly the amount being converted.");
  }
  let last: { at: number; amount: bigint } | null = null;
  for (let i = 0; i < calls.length; i++) {
    const a = approvalOf(calls[i]!);
    if (!a || !isAddressEqual(a.spender, CIRCLE_SWAP_ADAPTER)) continue;
    if (!isAddressEqual(calls[i]!.target, s.tokenIn)) throw new Error("Refusing an approval to the swap adapter for any currency but the one being converted.");
    if (a.amount === 0n) {
      if (i < k) throw new Error("Refusing a reset of the swap adapter's approval before the swap.");
    } else if (i !== k - 1 || a.amount !== s.amountIn) {
      throw new Error("Refusing an approval to the swap adapter of more than the amount being converted, or one not set right before the swap.");
    }
    last = { at: i, amount: a.amount };
  }
  if (!last || last.at < k || last.amount !== 0n) throw new Error("Refusing a batch that leaves the swap adapter with an approval at the end.");

  // Tokens: approvals and the balance check only. A transfer in any other form would be a way to move the payer's money.
  // No batch inside the batch either: the builder never writes one.
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    if (i !== k + 1 && TOKEN_ADDRESSES.some((t) => isAddressEqual(t, c.target)) && selectorOf(c) !== APPROVE_SELECTOR) {
      throw new Error("Refusing a token call in a conversion batch other than approvals and the balance check.");
    }
    if (isAddressEqual(c.target, MULTICALL3_FROM)) throw new Error("Refusing a batch inside a conversion batch.");
  }

  // Morpho: only the four loan calls, on Adag's two markets, for the payer, and when a loan funds the swap, a borrow of
  // exactly the amount converted before it (C66, C69).
  let funded = s.borrow === null;
  const loanMarket = CURRENCIES.find((c) => isAddressEqual(c.address, s.tokenIn))?.marketId;
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    if (!isAddressEqual(c.target, MORPHO)) continue;
    const m = morphoCallOf(c);
    if (!m || !["supplyCollateral", "repay", "borrow", "withdrawCollateral"].includes(m.functionName)) throw new Error("Refusing a Morpho call this app does not make.");
    const args = m.args as readonly unknown[];
    const params = args[0] as MarketParams;
    if (!CURRENCIES.some((x) => isMarketOf(params, x.marketId))) throw new Error("Refusing a Morpho call on a market that is not one of Adag's two.");
    const onBehalf = (m.functionName === "borrow" || m.functionName === "repay" ? args[3] : args[2]) as Address;
    if (!isAddressEqual(onBehalf, s.payer)) throw new Error("Refusing a Morpho call made for anyone but the payer.");
    if (m.functionName === "borrow" || m.functionName === "withdrawCollateral") {
      const receiver = (m.functionName === "borrow" ? args[4] : args[3]) as Address;
      if (!isAddressEqual(receiver, s.payer)) throw new Error("Refusing a Morpho call that sends money to anyone but the payer.");
    }
    if (m.functionName === "borrow" && i < k && loanMarket && isMarketOf(params, loanMarket) && args[1] === s.borrow && args[2] === 0n) funded = true;
  }
  if (!funded) throw new Error("Refusing a conversion that is not funded by a borrow of exactly the amount being converted.");

  // Bills: only through Memo, only for the bills this batch was built for, each once, all after the swap (C65, C67).
  const wanted = new Map<string, PaidBill>(s.bills.map((b) => [`${b.contract.toLowerCase()}:${b.id}`, b]));
  for (let i = 0; i < calls.length; i++) {
    const c = calls[i]!;
    if (BILLS_CONTRACTS.some((t) => isAddressEqual(t, c.target))) throw new Error("Refusing a direct call to AdagBills in a conversion batch. Bills are paid through Memo.");
    if (!isAddressEqual(c.target, MEMO)) continue;
    if (i < k) throw new Error("Refusing a payment that comes before the swap.");
    let target: Address;
    let id: bigint;
    try {
      const { args } = decodeFunctionData({ abi: memoAbi, data: c.callData });
      target = args[0] as Address;
      const inner = args[1] as Hex;
      if (!BILLS_CONTRACTS.some((t) => isAddressEqual(t, target)) || inner.slice(0, 10).toLowerCase() !== PAY_SELECTOR) throw new Error("not a payment");
      id = decodeFunctionData({ abi: adagAbi, data: inner }).args![0] as bigint;
    } catch {
      throw new Error("Refusing a Memo call that is not a bill payment.");
    }
    const key = `${target.toLowerCase()}:${id}`;
    if (!wanted.delete(key)) throw new Error("Refusing a payment for a bill this batch was not built for, or one paid twice.");
  }
  if (wanted.size > 0) throw new Error("Refusing a conversion batch that leaves a bill unpaid.");
}

// What a batch's builder decided it is for: the wallet it runs as and the bills it pays. A Multicall3From batch pays
// through Memo; a Safe pays AdagBills directly, because Memo needs an ordinary wallet as the sender.
export type BatchIntent = { payer: Address; bills: readonly Pick<Bill, "contract" | "id">[]; sender: "wallet" | "safe" };

// A call read with one of the fixed ABIs, or null. Re-encoding must give back the same bytes, so a call cannot be read
// one way here and run another way: viem's decoder ignores trailing bytes and dirty padding, this does not.
function readCall(abi: Abi, data: Hex): { functionName: string; args: readonly unknown[] } | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi, data });
    const again = encodeFunctionData({ abi, functionName, args } as never);
    return again.toLowerCase() === data.toLowerCase() ? { functionName, args: args ?? [] } : null;
  } catch {
    return null;
  }
}

const billKey = (contract: string, id: bigint) => `${contract.toLowerCase()}:${id}`;
const isBillsContract = (a: Address) => BILLS_CONTRACTS.some((t) => isAddressEqual(t, a));
const MORPHO_CALLS: readonly string[] = ["supplyCollateral", "borrow", "repay", "withdrawCollateral"];
const ENROL_CALL = encodeFunctionData({ abi: adagAbi, functionName: "enrol" }).toLowerCase();

// C3 by shape, for every batch: each call must be one the builders in this file write. Tokens: approvals only, plus a
// conversion's balance check. Memo: only pay(id) on the bill's own contract, for a bill this batch pays, each once, under
// that bill's memo id. Morpho: the four loan calls on Adag's two markets, for the payer, with no callback data. AdagBills
// directly: only from a Safe, to pay its bills or, alone, to enrol. AdagGuard: only the exact clearRule of the loan being
// closed and its token's approval at 0. No batch inside the batch. The swap call, its approvals and the balance check are
// held by assertSwapCalls. Amounts are not checked here: the builders size them, and the contracts and the simulation are
// the guards on those.
function assertCallShapes(calls: readonly Call3[], guardMarket: Hex | null, swap: Conversion | null, intent: BatchIntent | null) {
  const scope: BatchIntent | null = swap ? { payer: swap.payer, bills: swap.bills, sender: "wallet" } : intent;
  const payer = scope?.payer ?? null;
  const fromSafe = scope?.sender === "safe";
  const bills = scope?.bills ?? [];
  const unpaid = new Set(bills.map((b) => billKey(b.contract, b.id)));
  const swapAt = swap ? calls.findIndex((c) => isAddressEqual(c.target, CIRCLE_SWAP_ADAPTER)) : -1;
  const closing = guardMarket === null ? undefined : CURRENCIES.find((x) => x.marketId.toLowerCase() === guardMarket.toLowerCase());

  // The id a pay(id) call settles, once, for a bill this batch was built for; null when the bytes are not exactly pay(id).
  const settles = (contract: Address, data: Hex): bigint | null => {
    const inner = readCall(adagAbi, data);
    if (inner?.functionName !== "pay") return null;
    const id = inner.args[0] as bigint;
    if (!unpaid.delete(billKey(contract, id))) throw new Error("Refusing a payment for a bill this batch was not built for, or one paid twice.");
    return id;
  };

  calls.forEach((c, i) => {
    const t = c.target;
    if (swap && isAddressEqual(t, CIRCLE_SWAP_ADAPTER)) return;
    if (isAddressEqual(t, MULTICALL3_FROM)) throw new Error("Refusing a batch inside the batch.");

    if (TOKEN_ADDRESSES.some((x) => isAddressEqual(x, t))) {
      const r = readCall(erc20Abi, c.callData);
      if (r?.functionName === "transfer" && swapAt >= 0 && i === swapAt + 1) return;
      if (r?.functionName !== "approve") throw new Error("Refusing a token call other than an approval.");
      const spender = r.args[0] as Address;
      if (isAddressEqual(spender, MORPHO)) return;
      if (swap && isAddressEqual(spender, CIRCLE_SWAP_ADAPTER)) return;
      if (isBillsContract(spender)) {
        if (isAddressEqual(t, CIRBTC) || !bills.some((b) => isAddressEqual(b.contract, spender))) {
          throw new Error("Refusing a cirBTC approval to AdagBills, or one to a contract no bill in this batch is on.");
        }
        return;
      }
      if (ADAG_GUARD !== null && isAddressEqual(spender, ADAG_GUARD) && closing && isAddressEqual(t, closing.address) && r.args[1] === 0n) return;
      throw new Error(`Refusing an approval to ${spender}.`);
    }

    if (isAddressEqual(t, MEMO)) {
      if (fromSafe) throw new Error("Refusing a Memo call in a Safe batch. A Safe pays AdagBills directly.");
      const m = readCall(memoAbi, c.callData);
      const target = m?.args[0] as Address | undefined;
      const id = m && target && isBillsContract(target) ? settles(target, m.args[1] as Hex) : null;
      if (id === null) throw new Error("Refusing a Memo call that is not a bill payment.");
      if (String(m!.args[2]).toLowerCase() !== memoId(id).toLowerCase()) throw new Error("Refusing a Memo payment filed under another bill's memo id.");
      return;
    }

    if (isAddressEqual(t, MORPHO)) {
      const m = readCall(morphoAbi, c.callData);
      if (!m || !MORPHO_CALLS.includes(m.functionName)) throw new Error("Refusing a Morpho call this app does not make.");
      const a = m.args;
      if (!CURRENCIES.some((x) => isMarketOf(a[0] as MarketParams, x.marketId))) throw new Error("Refusing a Morpho call on a market that is not one of Adag's two.");
      const onBehalf = (m.functionName === "borrow" || m.functionName === "repay" ? a[3] : a[2]) as Address;
      if (payer === null || !isAddressEqual(onBehalf, payer)) throw new Error("Refusing a Morpho call made for anyone but the payer.");
      if (m.functionName === "borrow" || m.functionName === "withdrawCollateral") {
        if (!isAddressEqual((m.functionName === "borrow" ? a[4] : a[3]) as Address, payer)) throw new Error("Refusing a Morpho call that sends money to anyone but the payer.");
      }
      const callback = m.functionName === "supplyCollateral" ? a[3] : m.functionName === "repay" ? a[4] : "0x";
      if (callback !== "0x") throw new Error("Refusing a Morpho call that asks Morpho to call back into the batch.");
      return;
    }

    if (isBillsContract(t)) {
      if (!fromSafe) throw new Error("Refusing a direct call to AdagBills in a batch. Bills are paid through Memo.");
      if (calls.length === 1 && isAddressEqual(t, ADAG_BILLS) && c.callData.toLowerCase() === ENROL_CALL) return;
      if (settles(t, c.callData) === null) throw new Error("Refusing an AdagBills call from a Safe other than paying one of its bills, or recording its loan on its own.");
      return;
    }

    if (ADAG_GUARD !== null && isAddressEqual(t, ADAG_GUARD)) {
      const stop = closing ? encodeFunctionData({ abi: guardAbi, functionName: "clearRule", args: [closing.marketId] }).toLowerCase() : null;
      if (c.callData.toLowerCase() !== stop) throw new Error("Refusing a loan guard call other than exactly stopping this loan's rule.");
      return;
    }

    throw new Error(`Refusing a batch that calls ${t}.`);
  });
  if (unpaid.size > 0) throw new Error("Refusing a batch that leaves a bill it was built for unpaid.");
}

// One rule for AdagGuard, rather than a place on the lists: a close may call it only to clear the rule of the market
// it closes, and may approve it only to 0. No other batch may touch it at all (C60).
// A swap through Circle's adapter is allowed only for a batch that carries its Conversion: with it, assertSwapCalls
// holds the call, its approvals and the balance check to C65 to C69. Without it, the adapter is just another address
// that is on neither list.
// Then every call is held to its shape (assertCallShapes) against the intent the builder passes, or the Conversion's
// payer and bills when there is one. With neither, no Morpho call and no payment can pass.
export function assertCalls(calls: readonly Call3[], guardMarket: Hex | null = null, swap: Conversion | null = null, intent: BatchIntent | null = null) {
  if (swap) assertSwapCalls(calls, swap);
  for (const c of calls) {
    if (c.allowFailure !== false) throw new Error("Refusing a batch step that may fail on its own.");
    if (isAddressEqual(c.target, CIRCLE_SWAP_ADAPTER)) {
      if (!swap) throw new Error(`Refusing a batch that calls ${c.target}.`);
      continue;
    }
    if (!swap && (isAddressEqual(c.target, MEMO) || isAddressEqual(c.target, MULTICALL3_FROM)) && reachesAdapter([c], 1)) {
      throw new Error("Refusing a batch that reaches the swap adapter through another call.");
    }
    const toGuard = ADAG_GUARD !== null && isAddressEqual(c.target, ADAG_GUARD);
    if (toGuard) {
      if (!guardMarket || c.callData.slice(0, 10).toLowerCase() !== CLEAR_RULE_SELECTOR) throw new Error("Refusing a loan guard call other than stopping this loan's rule.");
      const { args } = decodeFunctionData({ abi: guardAbi, data: c.callData });
      if (String(args[0]).toLowerCase() !== guardMarket.toLowerCase()) throw new Error("Refusing to stop the guard of another market.");
      continue;
    }
    if (!TARGETS.some((t) => isAddressEqual(t, c.target))) throw new Error(`Refusing a batch that calls ${c.target}.`);
    if (c.callData.slice(0, 10).toLowerCase() === APPROVE_SELECTOR) {
      const { args } = decodeFunctionData({ abi: erc20Abi, data: c.callData });
      if (isAddressEqual(args[0] as Address, CIRCLE_SWAP_ADAPTER)) {
        if (!swap) throw new Error(`Refusing an approval to ${String(args[0])}.`);
        continue;
      }
      if (ADAG_GUARD !== null && isAddressEqual(args[0] as Address, ADAG_GUARD)) {
        const loanToken = CURRENCIES.find((x) => guardMarket !== null && x.marketId.toLowerCase() === guardMarket.toLowerCase())?.address;
        if (!loanToken || args[1] !== 0n || !isAddressEqual(c.target, loanToken)) throw new Error("Refusing an approval to the loan guard other than setting this loan's token to 0.");
        continue;
      }
      if (!SPENDERS.some((s) => isAddressEqual(s, args[0] as Address))) throw new Error(`Refusing an approval to ${String(args[0])}.`);
    }
  }
  assertCallShapes(calls, guardMarket, swap, intent);
}

function batch(calls: Call3[], intent: BatchIntent, guardMarket: Hex | null = null, conversion: Conversion | null = null): Batch {
  assertCalls(calls, guardMarket, conversion, intent);
  const data = encodeFunctionData({ abi: multicall3FromAbi, functionName: "aggregate3", args: [calls] });
  return conversion ? { to: MULTICALL3_FROM, data, calls, conversion } : { to: MULTICALL3_FROM, data, calls };
}

// The calls inside an aggregate3 batch, or null when these bytes are anything else. The bytes must be exactly what this
// ABI would write for the calls it finds, so a batch cannot be read one way here and run another way.
export function decodeBatch(data: Hex): Call3[] | null {
  try {
    const { functionName, args } = decodeFunctionData({ abi: multicall3FromAbi, data });
    if (functionName !== "aggregate3") return null;
    const calls = (args[0] as readonly { target: Address; allowFailure: boolean; callData: Hex }[]).map((c) => ({ target: c.target, allowFailure: c.allowFailure as false, callData: c.callData }));
    const again = encodeFunctionData({ abi: multicall3FromAbi, functionName: "aggregate3", args: [calls] });
    return again.toLowerCase() === data.toLowerCase() ? calls : null;
  } catch {
    return null;
  }
}

// Whether a transaction would reach Circle's adapter in any way: sent to it directly, or as a call, an approval, or either
// of those wrapped in Memo or a nested batch, inside a batch. Bytes that are not a batch reach it only if sent to it.
export function reachesSwapAdapter(to: Address, data: Hex): boolean {
  if (isAddressEqual(to, CIRCLE_SWAP_ADAPTER)) return true;
  const calls = decodeBatch(data);
  return calls !== null && reachesAdapter(calls, 0);
}

// The sender's own check of the exact bytes it is about to ask a wallet to sign (C70, C71): a Multicall3From batch from the
// connected account whose calls pass the same rules as at build time, against the same Conversion.
export function assertConversionBatch(to: Address, data: Hex, conversion: Conversion, account: Address): void {
  if (!isAddressEqual(to, MULTICALL3_FROM)) throw new Error("Refusing a conversion that is not sent through Multicall3From.");
  if (!isAddressEqual(conversion.payer, account)) throw new Error("Refusing a conversion that was built for another wallet.");
  const calls = decodeBatch(data);
  if (!calls) throw new Error("Refusing a conversion whose bytes are not a plain batch of calls.");
  assertCalls(calls, conversion.guardMarket, conversion);
}

// ARCHITECTURE.md section 6, pay from balance: exact approval to Adag, then pay(N) through Memo.
export function buildPayFromBalance(bill: Bill, payer: string): Batch {
  const who = checkedPayer(payer);
  const currency = payableCurrency(bill, who);
  return batch([approve(currency.address, bill.contract, bill.amount), memoPay(bill)], { payer: who, bills: [bill], sender: "wallet" });
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
    approve(currency.address, bill.contract, bill.amount),
    memoPay(bill),
  );
  return batch(calls, { payer: who, bills: [bill], sender: "wallet" });
}

export const MAX_BASKET_BILLS = 10;

// C65 to C69: a currency group paid from a loan in the other currency, converted by one swap through Circle's adapter.
export type ConvertGroupPlan = {
  from: "convert";
  // The loan currency: the other of the two fixed currencies, never the bill's own (C69).
  loan: "USDC" | "EURC";
  // X: the amount of the loan currency that is borrowed, approved to the adapter and sold.
  amountIn: bigint;
  pledge: bigint;
  marketParams: MarketParams;
  // execute's calldata as circle.ts wrote it. checkPlan runs on it here and again inside assertCalls.
  plan: Hex;
  // The payer's balance of the bill currency at the block `chainTime` belongs to (C68).
  outputBalance: bigint;
  // The fee ceiling the transaction is sent with. The balance check's gas slack is worked out from it (C71).
  maxFeePerGas: bigint;
  chainTime: bigint;
  // The euro price X was sized from. The builder holds X to it and to the 96-hour window (C70).
  rate: EurUsdReading;
};

export type GroupPlan = { from: "balance" } | { from: "bitcoin"; pledge: bigint; marketParams: MarketParams } | ConvertGroupPlan;
export type BasketPlan = Partial<Record<"USDC" | "EURC", GroupPlan>>;

const supplyCollateralCall = (params: MarketParams, assets: bigint, who: Address) =>
  call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [params, assets, who, "0x"] }));
const borrowCall = (params: MarketParams, assets: bigint, who: Address) =>
  call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [params, assets, 0n, who, who] }));
const transferCall = (token: Address, to: Address, amount: bigint) => call(token, encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }));

// The balance check's floor (C68): what the payer held of the output currency at the pinned block, plus what the plan
// funds, less the gas slack when the output is USDC (Arc takes gas from the same balance). A floor at or under zero
// would check nothing, so such a conversion is not offered.
function floorOf(output: Address, outputBalance: bigint, funded: bigint, maxFeePerGas: bigint): bigint {
  if (typeof outputBalance !== "bigint" || outputBalance < 0n) throw new Error("The balance the conversion starts from reads as negative, so nothing was built.");
  const slack = floorSlack(maxFeePerGas);
  const floor = outputBalance + funded - (isAddressEqual(output, USDC) ? slack : 0n);
  if (floor <= 0n) throw new Error("This amount is too small for the balance check that protects a conversion, so it is not offered. Pay it from your balance.");
  return floor;
}

// Everything about one converting group that can be decided without the other groups: the loan market proven by hash
// (C69), X held to the euro price and window (C70), the plan checked as bytes (C65, C66) and the floor (C68).
function prepareConvert(who: Address, c: Currency, p: ConvertGroupPlan, billTotal: bigint) {
  const loan = loanCurrencyFor(c.symbol);
  if (p.loan !== loan.symbol) throw new Error(`A ${c.symbol} bill is paid by converting a ${loan.symbol} loan, never a ${String(p.loan)} one.`);
  if (typeof p.amountIn !== "bigint" || p.amountIn <= 0n) throw new Error("The amount to convert must be more than zero.");
  if (typeof p.pledge !== "bigint" || p.pledge < 0n) throw new Error("The pledge must be zero or more satoshis.");
  verifyMarketParams(p.marketParams, loan.marketId);
  assertMarketConstants(p.marketParams, loan);
  assertEurUsdFresh(p.rate, p.chainTime);
  if (p.amountIn > maxAmountToSell(billTotal, c.symbol, p.rate)) {
    throw new Error("The amount to convert is more than these bills are worth at the euro price Adag reads, plus the 1.5% buffer. Nothing was built.");
  }
  const floor = floorOf(c.address, p.outputBalance, billTotal, p.maxFeePerGas);
  const plan = checkPlan(p.plan, { account: who, tokenIn: loan.address, tokenOut: c.address, amountIn: p.amountIn, minOut: billTotal, latestBlockTimestamp: p.chainTime });
  return { c, p, loan, plan, floor, billTotal };
}

// ARCHITECTURE.md section 6, several bills in one signature. Pledge and borrow per bitcoin group, then one exact
// approval per currency, then each bill's own Memo-wrapped pay in the order given. One failure undoes all (C20).
// One group may instead be paid from a loan in the other currency, converted by a Circle swap plan: pledge and borrow
// X on the loan market, approve X to the adapter, run the plan, the balance check, then the same approvals and pays,
// and the adapter's approval back to 0. At most one such group per batch, so a batch never converts in both directions.
export function buildPayMany(bills: Bill[], payer: string, plan: BasketPlan): Batch {
  const who = checkedPayer(payer);
  if (bills.length === 0) throw new Error("Add at least one bill to pay.");
  if (bills.length > MAX_BASKET_BILLS) throw new Error(`One signature pays at most ${MAX_BASKET_BILLS} bills.`);
  const contract = oneContract(bills);
  const seen = new Set<bigint>();
  const totals = new Map<Currency, bigint>();
  const paid: PaidBill[] = [];
  for (const b of bills) {
    if (seen.has(b.id)) throw new Error(`Bill #${b.id} is in the basket twice; paying it twice would undo the whole batch.`);
    seen.add(b.id);
    const c = payableCurrency(b, who);
    totals.set(c, (totals.get(c) ?? 0n) + b.amount);
    paid.push({ contract: b.contract, id: b.id, token: c.address, payee: b.payee, amount: b.amount });
  }

  const groups = CURRENCIES.filter((c) => totals.has(c));
  const plans = new Map<Currency, GroupPlan>();
  let converting: { c: Currency; p: ConvertGroupPlan } | null = null;
  for (const c of groups) {
    const p = plan[c.symbol];
    if (!p) throw new Error(`Choose how to pay the ${c.symbol} bills.`);
    if (p.from === "bitcoin") {
      if (typeof p.pledge !== "bigint" || p.pledge < 0n) throw new Error("The pledge must be zero or more satoshis.");
      verifyMarketParams(p.marketParams, c.marketId);
      assertMarketConstants(p.marketParams, c);
    } else if (p.from === "convert") {
      if (converting) throw new Error("One signature converts in one direction only: two groups converting, in opposite directions, are never built together.");
      converting = { c, p };
    } else if (p.from !== "balance") {
      throw new Error(`Choose how to pay the ${c.symbol} bills.`);
    }
    plans.set(c, p);
  }
  const swap = converting ? prepareConvert(who, converting.c, converting.p, totals.get(converting.c)!) : null;

  const calls: Call3[] = [];
  if (!swap) {
    for (const c of groups) {
      const p = plans.get(c)!;
      if (p.from !== "bitcoin") continue;
      if (p.pledge > 0n) calls.push(approve(CIRBTC, MORPHO, p.pledge), supplyCollateralCall(c.params, p.pledge, who));
      calls.push(borrowCall(c.params, totals.get(c)!, who));
    }
  } else {
    // Every pledge before every borrow: the converting group's loan market can be the market another group borrows from.
    for (const c of groups) {
      const p = plans.get(c)!;
      if (p.from === "balance" || p.pledge <= 0n) continue;
      calls.push(approve(CIRBTC, MORPHO, p.pledge), supplyCollateralCall(p.from === "convert" ? swap.loan.params : c.params, p.pledge, who));
    }
    for (const c of groups) {
      const p = plans.get(c)!;
      if (p.from === "bitcoin") calls.push(borrowCall(c.params, totals.get(c)!, who));
      else if (p.from === "convert") calls.push(borrowCall(swap.loan.params, p.amountIn, who));
    }
    calls.push(
      approve(swap.loan.address, CIRCLE_SWAP_ADAPTER, swap.p.amountIn),
      call(CIRCLE_SWAP_ADAPTER, swap.p.plan),
      transferCall(swap.c.address, who, swap.floor),
    );
  }
  for (const c of groups) calls.push(approve(c.address, contract, totals.get(c)!));
  for (const b of bills) calls.push(memoPay(b));
  const intent: BatchIntent = { payer: who, bills, sender: "wallet" };
  if (!swap) return batch(calls, intent);

  calls.push(approve(swap.loan.address, CIRCLE_SWAP_ADAPTER, 0n));
  let pledge = 0n;
  for (const p of plans.values()) if (p.from !== "balance") pledge += p.pledge;
  const conversion: Conversion = {
    payer: who,
    tokenIn: swap.loan.address,
    tokenOut: swap.c.address,
    amountIn: swap.p.amountIn,
    minOut: swap.billTotal,
    floor: swap.floor,
    outputBalance: swap.p.outputBalance,
    chainTime: swap.p.chainTime,
    execId: swap.plan.params.execId,
    deadline: swap.plan.params.deadline,
    gas: FX_GAS_CAP,
    maxFeePerGas: swap.p.maxFeePerGas,
    borrow: swap.p.amountIn,
    borrowedUsdc: isAddressEqual(swap.loan.address, USDC) ? swap.p.amountIn : 0n,
    pledge,
    repay: null,
    bills: paid,
    guardMarket: null,
  };
  return batch(calls, intent, null, conversion);
}

// One bill paid from a loan in the other currency: the single-bill form of buildPayMany with a converting group.
export function buildPayConverted(bill: Bill, payer: string, funding: ConvertGroupPlan): Batch {
  const who = checkedPayer(payer);
  const currency = payableCurrency(bill, who);
  return buildPayMany([bill], who, { [currency.symbol]: funding });
}

// A direct transaction from the supplier's wallet, not a batch, to the contract the bill lives on.
export function buildVoid(bill: Pick<Bill, "contract" | "id">): DirectCall {
  const { address } = requireDeployment(bill.contract);
  if (typeof bill.id !== "bigint" || bill.id < 1n) throw new Error("A bill number must be a whole number of 1 or more.");
  return { to: address, data: encodeFunctionData({ abi: adagAbi, functionName: "voidBill", args: [bill.id] }) };
}

const MAX_UINT64 = 2n ** 64n;

// The one encoding of a reference: its UTF-8 bytes. The form's byte counter, the preview and the transaction all use
// this, so what the supplier sees is exactly what goes on chain (C14, C15).
export function referenceBytes(refText: string): Hex {
  return refText === "" ? "0x" : stringToHex(refText);
}

function fixedCurrency(currency: Currency): Currency {
  const match = CURRENCIES.find((c) => isAddressEqual(c.address, currency.address) && c.marketId === currency.marketId);
  if (!match) throw new Error("Bills can only be written in USDC or EURC.");
  return match;
}

// C8 as a courtesy before the contract's own checks: a positive amount, a real currency, a due date that fits.
// New bills are only ever written on the current contract.
export function buildCreateBill(currency: Currency, amount: bigint, due: bigint, refText: string): DirectCall {
  const c = fixedCurrency(currency);
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("The amount must be more than zero.");
  if (typeof due !== "bigint" || due < 0n || due >= MAX_UINT64) throw new Error("The due date is not a date Arc can store.");
  const ref = referenceBytes(refText);
  if (size(ref) > MAX_REFERENCE_BYTES) {
    throw new Error(`The reference is ${size(ref)} bytes; the limit is ${MAX_REFERENCE_BYTES}. Some characters take more than one byte.`);
  }
  return { to: ADAG_BILLS, data: encodeFunctionData({ abi: adagAbi, functionName: "createBill", args: [c.address, amount, due, ref] }) };
}

function verifiedParams(currency: Currency, marketParams: MarketParams): { c: Currency; params: MarketParams } {
  const c = fixedCurrency(currency);
  verifyMarketParams(marketParams, c.marketId);
  assertMarketConstants(marketParams, c);
  return { c, params: c.params };
}

// Pledge more cirBTC to a market. No borrow, so no price freshness is needed.
export function buildAddCollateral(payer: string, currency: Currency, amount: bigint, marketParams: MarketParams): Batch {
  const who = checkedPayer(payer);
  const { params } = verifiedParams(currency, marketParams);
  if (typeof amount !== "bigint" || amount <= 0n) throw new Error("The amount of cirBTC to add must be more than zero.");
  return batch(
    [approve(CIRBTC, MORPHO, amount), call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [params, amount, who, "0x"] }))],
    { payer: who, bills: [], sender: "wallet" },
  );
}

// ARCHITECTURE.md section 6, close a loan: repay by the live share count (repaying by assets leaves dust that blocks
// the withdrawal), take every satoshi back, and reset the approval so none outlives the batch (C3).
// Bring a loan down by an exact amount of the loan token, straight to Morpho, not through Adag. `cap` is repaySomeCap
// from the caller's fresh read (C36); a builder that reads nothing cannot know it. A full repayment is Close loan,
// which repays by shares. The approval equals the amount and Morpho pulls exactly that, so none is left over.
export function buildRepaySome(payer: string, currency: Currency, assets: bigint, marketParams: MarketParams, cap: bigint): Batch {
  const who = checkedPayer(payer);
  const { c, params } = verifiedParams(currency, marketParams);
  if (typeof assets !== "bigint" || assets <= 0n) throw new Error("The amount to repay must be more than zero.");
  if (typeof cap !== "bigint" || assets > cap) {
    throw new Error("That is more than this way of repaying can take. Use Close loan to repay everything.");
  }
  return batch(
    [approve(c.address, MORPHO, assets), call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params, assets, 0n, who, "0x"] }))],
    { payer: who, bills: [], sender: "wallet" },
  );
}

// The loan guard's state for the market being closed, read by the caller: whether a rule exists, and the approval.
export type GuardStop = { hasRule: boolean; allowance: bigint };

// The calls of a close: repay by shares, take every satoshi back after that full repay, reset the approval. When a guard
// rule or approval exists for this market, the same transaction also stops the guard (C60): clearRule for that market
// (only if there is a rule), then the loan token's approval to AdagGuard set to 0.
function closeCalls(
  who: Address,
  c: Currency,
  params: MarketParams,
  position: { shares: bigint; collateral: bigint },
  repayApproval: bigint,
  guardStop: GuardStop,
): { calls: Call3[]; stops: boolean } {
  const { shares, collateral } = position;
  if (shares < 0n || collateral < 0n) throw new Error("The loan position reads as negative, so nothing was built.");
  if (shares === 0n && collateral === 0n) throw new Error("There is no loan and no pledged cirBTC in this market.");
  if (typeof guardStop.allowance !== "bigint" || guardStop.allowance < 0n) throw new Error("The loan guard's approval reads as negative, so nothing was built.");
  const withdraw = call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "withdrawCollateral", args: [params, collateral, who, who] }));
  const calls: Call3[] = [];
  if (shares === 0n) {
    calls.push(withdraw);
  } else {
    if (typeof repayApproval !== "bigint" || repayApproval <= 0n) throw new Error("The repay approval must be more than zero.");
    calls.push(
      approve(c.address, MORPHO, repayApproval),
      call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "repay", args: [params, 0n, shares, who, "0x"] })),
    );
    if (collateral > 0n) calls.push(withdraw);
    calls.push(approve(c.address, MORPHO, 0n));
  }
  const stops = guardStop.hasRule || guardStop.allowance > 0n;
  if (stops) {
    if (!ADAG_GUARD) throw new Error("The loan guard is not deployed, so its rule cannot be stopped.");
    if (guardStop.hasRule) calls.push(call(ADAG_GUARD, encodeFunctionData({ abi: guardAbi, functionName: "clearRule", args: [c.marketId] })));
    calls.push(approve(c.address, ADAG_GUARD, 0n));
  }
  return { calls, stops };
}

export function buildCloseLoan(
  payer: string,
  currency: Currency,
  position: { shares: bigint; collateral: bigint },
  repayApproval: bigint,
  marketParams: MarketParams,
  guardStop: GuardStop = { hasRule: false, allowance: 0n },
): Batch {
  const who = checkedPayer(payer);
  const { c, params } = verifiedParams(currency, marketParams);
  const { calls, stops } = closeCalls(who, c, params, position, repayApproval, guardStop);
  return batch(calls, { payer: who, bills: [], sender: "wallet" }, stops ? c.marketId : null);
}

// C75: what a close needs to pay its loan with the other currency instead.
export type CloseConversion = {
  // Y: the amount of the other currency that is sold.
  amountIn: bigint;
  plan: Hex;
  // The payer's balance of the loan currency at the block `chainTime` belongs to.
  outputBalance: bigint;
  maxFeePerGas: bigint;
  chainTime: bigint;
  rate: EurUsdReading;
};

// C75: closing a loan with the other currency. Sell Y of that currency for at least the close approval, check the
// balance rose by it, then repay by shares exactly as buildCloseLoan does, take the collateral back only after that
// full repay, and set the adapter's approval back to 0. Y may not exceed the close approval at the euro price Adag reads,
// plus the 1.5% buffer. The loan guard is stopped in the same batch when it has a rule or an approval (C60).
export function buildCloseWithOtherCurrency(
  payer: string,
  currency: Currency,
  position: { shares: bigint; collateral: bigint },
  repayApproval: bigint,
  marketParams: MarketParams,
  funding: CloseConversion,
  guardStop: GuardStop = { hasRule: false, allowance: 0n },
): Batch {
  const who = checkedPayer(payer);
  const { c, params } = verifiedParams(currency, marketParams);
  if (position.shares <= 0n) throw new Error("There is no loan in this market to close with a conversion.");
  if (typeof repayApproval !== "bigint" || repayApproval <= 0n) throw new Error("The repay approval must be more than zero.");
  if (typeof funding.amountIn !== "bigint" || funding.amountIn <= 0n) throw new Error("The amount to convert must be more than zero.");
  const sold = loanCurrencyFor(c.symbol);
  assertEurUsdFresh(funding.rate, funding.chainTime);
  if (funding.amountIn > maxAmountToSell(repayApproval, c.symbol, funding.rate)) {
    throw new Error("The amount to convert is more than the close approval is worth at the euro price Adag reads, plus the 1.5% buffer. Nothing was built.");
  }
  const floor = floorOf(c.address, funding.outputBalance, repayApproval, funding.maxFeePerGas);
  const plan = checkPlan(funding.plan, { account: who, tokenIn: sold.address, tokenOut: c.address, amountIn: funding.amountIn, minOut: repayApproval, latestBlockTimestamp: funding.chainTime });
  const { calls: closing, stops } = closeCalls(who, c, params, position, repayApproval, guardStop);
  const calls = [
    approve(sold.address, CIRCLE_SWAP_ADAPTER, funding.amountIn),
    call(CIRCLE_SWAP_ADAPTER, funding.plan),
    transferCall(c.address, who, floor),
    ...closing,
    approve(sold.address, CIRCLE_SWAP_ADAPTER, 0n),
  ];
  const guardMarket = stops ? c.marketId : null;
  const conversion: Conversion = {
    payer: who,
    tokenIn: sold.address,
    tokenOut: c.address,
    amountIn: funding.amountIn,
    minOut: repayApproval,
    floor,
    outputBalance: funding.outputBalance,
    chainTime: funding.chainTime,
    execId: plan.params.execId,
    deadline: plan.params.deadline,
    gas: FX_GAS_CAP,
    maxFeePerGas: funding.maxFeePerGas,
    borrow: null,
    borrowedUsdc: 0n,
    pledge: 0n,
    repay: { token: c.address, max: repayApproval },
    bills: [],
    guardMarket,
  };
  return batch(calls, { payer: who, bills: [], sender: "wallet" }, guardMarket, conversion);
}

// Records the caller's existing Morpho loans as they stand on the current AdagBills, so later payments are judged only
// on new borrowing (C32). The first deployment has no enrol, so it is refused here.
export function buildEnrol(contract: string): DirectCall {
  const d = requireDeployment(contract);
  if (d.label !== "current") throw new Error("Only the current AdagBills contract can record an existing loan. This bill is on the first deployment.");
  return { to: d.address, data: encodeFunctionData({ abi: adagAbi, functionName: "enrol" }) };
}

export type SafeBatch = { to: Address; data: Hex; operation: 1; value: 0n; inner: SafeInnerCall[] };

export const SAFE_NO_CONVERSION = "Paying through a conversion between dollars and euros is not available from a Safe, because Circle's quote lasts 10 minutes and a Safe's signatures take longer. Pay in the bill's own currency, or pay from a wallet.";

// C74: any plan that asks for a conversion, however it is spelled, is refused before anything is built.
const asksForConversion = (p: unknown): boolean =>
  typeof p === "object" && p !== null && (String((p as { from?: unknown }).from).toLowerCase() === "convert" || "plan" in p || "amountIn" in p || "loan" in p);

export const SAFE_CURRENT_ONLY = "Paying from a Safe works for bills on the current AdagBills contract. This bill is on the first deployment, so pay it from a wallet.";

// A payment from a Safe: the same plan rules as buildPayMany, but the Safe itself is the payer, so every bill is
// paid by calling AdagBills.pay(id) directly (no Memo, no Multicall3From: both need an ordinary wallet as sender).
// The calls run inside one MultiSendCallOnly batch that the Safe reaches by delegatecall. Adag's own BillPaid still
// names each bill. Asserts C51 and C55 on its own output before returning it.
export function buildSafeBatch(safe: Address, bills: Bill[], plan: BasketPlan): SafeBatch {
  const who = checkedPayer(safe);
  if (Object.values(plan ?? {}).some(asksForConversion)) throw new Error(SAFE_NO_CONVERSION);
  if (bills.length === 0) throw new Error("Add at least one bill to pay.");
  if (bills.length > MAX_BASKET_BILLS) throw new Error(`One Safe payment pays at most ${MAX_BASKET_BILLS} bills.`);
  if (bills.some((b) => !isAddressEqual(requireDeployment(b.contract).address, ADAG_BILLS))) throw new Error(SAFE_CURRENT_ONLY);
  const seen = new Set<bigint>();
  const totals = new Map<Currency, bigint>();
  for (const b of bills) {
    if (seen.has(b.id)) throw new Error(`Bill #${b.id} is in the payment twice; paying it twice would undo the whole batch.`);
    seen.add(b.id);
    const c = payableCurrency(b, who);
    totals.set(c, (totals.get(c) ?? 0n) + b.amount);
  }
  const groups = CURRENCIES.filter((c) => totals.has(c));
  const plans = new Map<Currency, GroupPlan>();
  for (const c of groups) {
    const p = plan[c.symbol];
    if (!p) throw new Error(`Choose how the Safe pays the ${c.symbol} bills.`);
    if (p.from === "bitcoin") {
      if (typeof p.pledge !== "bigint" || p.pledge < 0n) throw new Error("The pledge must be zero or more satoshis.");
      verifiedParams(c, p.marketParams);
    } else if (p.from !== "balance") {
      throw new Error(`Choose how the Safe pays the ${c.symbol} bills.`);
    }
    plans.set(c, p);
  }

  const inner: SafeInnerCall[] = [];
  const plain = (to: Address, data: Hex): SafeInnerCall => ({ to, value: 0n, data, operation: 0 });
  const approveInner = (token: Address, spender: Address, amount: bigint) => plain(token, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }));
  for (const c of groups) {
    const p = plans.get(c)!;
    if (p.from !== "bitcoin") continue;
    if (p.pledge > 0n) {
      inner.push(
        approveInner(CIRBTC, MORPHO, p.pledge),
        plain(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "supplyCollateral", args: [c.params, p.pledge, who, "0x"] })),
      );
    }
    inner.push(plain(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "borrow", args: [c.params, totals.get(c)!, 0n, who, who] })));
  }
  for (const c of groups) inner.push(approveInner(c.address, ADAG_BILLS, totals.get(c)!));
  for (const b of bills) inner.push(plain(ADAG_BILLS, encodeFunctionData({ abi: adagAbi, functionName: "pay", args: [b.id] })));

  if (inner.some((i) => isAddressEqual(i.to, CIRCLE_SWAP_ADAPTER) || (i.data.slice(0, 10).toLowerCase() === APPROVE_SELECTOR && i.data.toLowerCase().includes(CIRCLE_SWAP_ADAPTER.slice(2).toLowerCase())))) {
    throw new Error(SAFE_NO_CONVERSION);
  }
  // The same shape rule as a wallet's batch, with the Safe as the payer (C3, C51).
  assertCalls(inner.map((i) => call(i.to, i.data)), null, null, { payer: who, bills, sender: "safe" });
  assertSafeInnerCalls(who, inner);
  const batch: SafeBatch = { to: MULTISEND_CALL_ONLY, data: encodeMultiSend(inner), operation: 1, value: 0n, inner };
  // The outer shape too, with a placeholder nonce: the real nonce is read from the Safe right before signing (C52).
  assertSafeTxShape(who, safeTxFor(batch, 0n));
  return batch;
}

// C55: a Safe records its own existing loan as itself, in a Safe transaction of its own: one inner call, enrol() on
// the current AdagBills, by the same MultiSendCallOnly delegatecall with every gas field 0 (C51). A payment is
// proposed separately, once this one has executed.
export function buildSafeEnrol(safe: Address): SafeBatch {
  const who = checkedPayer(safe);
  const inner: SafeInnerCall[] = [{ to: ADAG_BILLS, value: 0n, data: encodeFunctionData({ abi: adagAbi, functionName: "enrol" }), operation: 0 }];
  assertCalls(inner.map((i) => call(i.to, i.data)), null, null, { payer: who, bills: [], sender: "safe" });
  assertSafeInnerCalls(who, inner);
  const out: SafeBatch = { to: MULTISEND_CALL_ONLY, data: encodeMultiSend(inner), operation: 1, value: 0n, inner };
  assertSafeTxShape(who, safeTxFor(out, 0n));
  return out;
}

function assertResetCalls(calls: readonly Call3[]) {
  for (const c of calls) {
    if (c.allowFailure !== false) throw new Error("Refusing a batch step that may fail on its own.");
    const a = approvalOf(c);
    if (a) {
      if (!TOKEN_ADDRESSES.some((t) => isAddressEqual(t, c.target)) || !isAddressEqual(a.spender, CIRCLE_SWAP_ADAPTER) || a.amount !== 0n) {
        throw new Error("Refusing a reset step that is not setting a swap approval to 0.");
      }
      continue;
    }
    const m = isAddressEqual(c.target, MORPHO) ? morphoCallOf(c) : null;
    const args = m?.args as readonly unknown[] | undefined;
    if (m?.functionName === "setAuthorization" && args && isAddressEqual(args[0] as Address, CIRCLE_SWAP_ADAPTER) && args[1] === false) continue;
    throw new Error("Refusing a reset step that is not one of the two the reset allows.");
  }
}

// C67: the one batch the swap adapter may appear in apart from a conversion. It takes an open allowance to the adapter
// back to 0 and withdraws the adapter's Morpho authorization, and nothing else: zeroing can only take power away.
export function buildAdapterReset(payer: string, reset: { tokens: readonly Address[]; deauthorize: boolean }): Batch {
  checkedPayer(payer);
  const calls: Call3[] = [];
  const seen = new Set<string>();
  for (const token of reset.tokens) {
    if (!TOKEN_ADDRESSES.some((t) => isAddressEqual(t, token))) throw new Error("Only USDC, EURC and cirBTC approvals to the swap adapter can be reset here.");
    if (seen.has(token.toLowerCase())) throw new Error("Each approval is reset once.");
    seen.add(token.toLowerCase());
    calls.push(approve(token, CIRCLE_SWAP_ADAPTER, 0n));
  }
  if (reset.deauthorize) calls.push(call(MORPHO, encodeFunctionData({ abi: morphoAbi, functionName: "setAuthorization", args: [CIRCLE_SWAP_ADAPTER, false] })));
  if (calls.length === 0) throw new Error("There is nothing to reset.");
  assertResetCalls(calls);
  return { to: MULTICALL3_FROM, data: encodeFunctionData({ abi: multicall3FromAbi, functionName: "aggregate3", args: [calls] }), calls };
}

export const APPROVAL_SPENDERS = SPENDERS;
export const BATCH_TARGETS = TARGETS;
