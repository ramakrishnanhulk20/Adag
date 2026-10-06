// Plain TypeScript with relative imports only: scripts/check-fx.mjs and the unit tests run this folder under bare Node.
// Everything that decides whether a swap plan from Circle may run inside the payer's batch lives here (C65 to C68, C71).
import { decodeFunctionData, encodeFunctionData, getAddress, hexToBigInt, isAddress, isAddressEqual, isHex, size, toEventSelector, toFunctionSelector, type Address, type Hex } from "viem";
import { circleAdapterAbi } from "../pay/abi";
import {
  CIRBTC,
  CIRCLE_SWAP_ADAPTER,
  FX_GAS_CAP,
  MORPHO,
  PLAN_MAX_CALLDATA_BYTES,
  PLAN_MAX_INSTRUCTIONS,
  PLAN_MIN_SECONDS_LEFT,
  USDC,
} from "../pay/constants";
import { matchBillPaid } from "../pay/receipt";

// Every refusal below is a sentence this code wrote, so a screen may show it as it is.
export class PlanError extends Error {}
const refuse = (message: string): never => {
  throw new PlanError(message);
};

export const EXECUTE_SELECTOR = toFunctionSelector(circleAdapterAbi[0]).toLowerCase() as Hex;

export type PlanInstruction = {
  target: Address;
  data: Hex;
  value: bigint;
  tokenIn: Address;
  amountToApprove: bigint;
  tokenOut: Address;
  minTokenOut: bigint;
};
export type PlanParams = {
  instructions: readonly PlanInstruction[];
  tokens: readonly { token: Address; beneficiary: Address }[];
  execId: bigint;
  deadline: bigint;
  metadata: Hex;
};
export type TokenInput = { permitType: number; token: Address; amount: bigint; permitCalldata: Hex };
export type DecodedPlan = { params: PlanParams; tokenInputs: readonly TokenInput[]; signature: Hex };

// The one place execute's calldata is written. The token input is this app's own: one token, the exact amount, no
// permit. Circle supplies only the params and the signature. checkPlan decodes with the same ABI and re-encodes
// through here, so the bytes that were checked are the bytes that are sent.
export function encodeExecute(params: PlanParams, tokenIn: Address, amountIn: bigint, signature: Hex): Hex {
  return encodeFunctionData({
    abi: circleAdapterAbi,
    functionName: "execute",
    args: [params, [{ permitType: 0, token: tokenIn, amount: amountIn, permitCalldata: "0x" }], signature],
  });
}

// What this payment needs from a plan. tokenIn is what the plan sells (the loan currency for a bill, the other
// currency for a close), tokenOut what it buys, minOut the least it may buy.
export type ExpectedPlan = {
  account: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  latestBlockTimestamp: bigint;
};

function assertExpected(e: ExpectedPlan) {
  if (typeof e.account !== "string" || !isAddress(e.account, { strict: false })) refuse("The paying wallet address is not a valid address.");
  for (const token of [e.tokenIn, e.tokenOut]) {
    if (typeof token !== "string" || !isAddress(token, { strict: false })) refuse("A token address in the swap request is not a valid address.");
  }
  if (isAddressEqual(e.tokenIn, e.tokenOut)) refuse("A swap needs two different currencies.");
  if (typeof e.amountIn !== "bigint" || e.amountIn <= 0n) refuse("The amount to swap must be more than zero.");
  if (typeof e.minOut !== "bigint" || e.minOut <= 0n) refuse("The least the swap may return must be more than zero.");
  if (typeof e.latestBlockTimestamp !== "bigint" || e.latestBlockTimestamp <= 0n) refuse("The chain time for the swap check is missing.");
}

// C65 and C66: decode the calldata with the fixed ABI, check what it says, re-encode it and refuse unless the bytes are
// identical. Returns what was decoded, or throws a PlanError. Inner targets are not listed on purpose: Circle's route
// changes weekly. What bounds them is that the adapter can only spend an allowance of exactly amountIn (C67) and that
// the batch fails unless the payer ends with at least minOut more of tokenOut (C68).
export function checkPlan(calldata: Hex, expected: ExpectedPlan): DecodedPlan {
  assertExpected(expected);
  if (typeof calldata !== "string" || !isHex(calldata, { strict: true }) || calldata.length % 2 !== 0) refuse("The swap plan is not readable bytes.");
  if (size(calldata) > PLAN_MAX_CALLDATA_BYTES) refuse(`The swap plan is over ${PLAN_MAX_CALLDATA_BYTES} bytes.`);
  if (calldata.slice(0, 10).toLowerCase() !== EXECUTE_SELECTOR) refuse("The swap plan is not a call to the adapter's execute.");

  const decoded = (() => {
    try {
      return decodeFunctionData({ abi: circleAdapterAbi, data: calldata });
    } catch {
      return refuse("The swap plan could not be read.");
    }
  })();
  const [params, tokenInputs, signature] = decoded.args as unknown as [PlanParams, readonly TokenInput[], Hex];
  const again = encodeFunctionData({ abi: circleAdapterAbi, functionName: "execute", args: decoded.args as never });
  if (again.toLowerCase() !== calldata.toLowerCase()) refuse("The swap plan has extra or reshaped bytes, so it is not the plan that was checked.");

  if (tokenInputs.length !== 1) refuse("The swap plan must pull exactly one token from your wallet.");
  const input = tokenInputs[0]!;
  if (input.permitType !== 0) refuse("The swap plan asks for a permit, which Adag never signs.");
  if (size(input.permitCalldata) !== 0) refuse("The swap plan carries permit data.");
  if (!isAddressEqual(input.token, expected.tokenIn)) refuse("The swap plan pulls a different currency than the one this payment sells.");
  if (input.amount !== expected.amountIn) refuse("The swap plan pulls a different amount than this payment sells.");

  if (params.instructions.length === 0 || params.instructions.length > PLAN_MAX_INSTRUCTIONS) {
    refuse(`The swap plan has ${params.instructions.length} steps; Adag accepts 1 to ${PLAN_MAX_INSTRUCTIONS}.`);
  }
  if (params.tokens.length === 0 || params.tokens.length > PLAN_MAX_INSTRUCTIONS) refuse("The swap plan lists an unusable number of tokens to send back.");
  for (const t of params.tokens) {
    if (!isAddressEqual(t.beneficiary, expected.account)) refuse("The swap plan would send money to an address that is not your wallet.");
  }
  if (!params.tokens.some((t) => isAddressEqual(t.token, expected.tokenOut))) refuse("The swap plan does not send the bought currency to your wallet.");
  for (const i of params.instructions) {
    if (i.value !== 0n) refuse("The swap plan forwards native value, which this payment never needs.");
  }
  if (!params.instructions.some((i) => isAddressEqual(i.tokenOut, expected.tokenOut) && i.minTokenOut >= expected.minOut)) {
    refuse("The swap plan does not guarantee at least the amount this payment needs.");
  }
  if (params.deadline < expected.latestBlockTimestamp + PLAN_MIN_SECONDS_LEFT) {
    refuse(`The swap plan expires in under ${PLAN_MIN_SECONDS_LEFT} seconds by Arc's clock.`);
  }
  return { params, tokenInputs, signature };
}

const UNIT = 10n ** 12n;

// C68 and C71: the most gas Arc can set aside up front for a conversion batch, in 6-decimal USDC units, rounded up.
// The builder takes it off a USDC floor and the sender signs with this gas limit and this fee, so the two cannot drift.
export function floorSlack(maxFeePerGas: bigint): bigint {
  if (typeof maxFeePerGas !== "bigint" || maxFeePerGas <= 0n) refuse("The fee ceiling for the swap batch is missing.");
  return (FX_GAS_CAP * maxFeePerGas + UNIT - 1n) / UNIT;
}

// C74: a plan is used for one signature request, whatever happens next. A failed, declined or abandoned attempt needs a
// new plan. Lives for the page's life, which is as long as a plan lasts.
const claimed = new Set<string>();
export function claimPlan(execId: bigint): boolean {
  const key = execId.toString();
  if (claimed.has(key)) return false;
  claimed.add(key);
  return true;
}

export type PaidBill = { contract: Address; id: bigint; token: Address; payee: Address; amount: bigint };

// Everything a conversion batch is allowed to do, fixed by the builder from the one funding decision. assertCalls checks
// the calls against it, the sender checks the bytes it is about to sign against it, and checkEffects checks the
// simulation's logs against it.
export type Conversion = {
  payer: Address;
  tokenIn: Address;
  tokenOut: Address;
  amountIn: bigint;
  minOut: bigint;
  floor: bigint;
  // The payer's balance of tokenOut that floor was worked out from (floor = outputBalance + minOut - gas slack on USDC).
  outputBalance: bigint;
  chainTime: bigint;
  execId: bigint;
  deadline: bigint;
  gas: bigint;
  maxFeePerGas: bigint;
  // The loan the conversion is funded from: the amount borrowed in this batch (a bill) or null (a close).
  borrow: bigint | null;
  // USDC borrowed earlier in this batch for the plan, the only USDC inflow C25 credits besides the plan's minimum.
  borrowedUsdc: bigint;
  // cirBTC the batch may move into Morpho, over every group.
  pledge: bigint;
  // A close repays Morpho from the plan's output; this is the most it may pull.
  repay: { token: Address; max: bigint } | null;
  bills: readonly PaidBill[];
  guardMarket: Hex | null;
};

// C25: USDC the wallet must hold up front for the conversion, beyond what the screen counts for the rest of the batch.
// USDC approved to the adapter leaves the wallet; the only credit is USDC this batch borrowed for it. USDC the plan
// returns is credited at its minimum and is spent only on this group's bills or the close's repayment, which equal that
// minimum, so it nets to zero and adds nothing.
export function conversionUsdcOut(c: Conversion): bigint {
  const approved = isAddressEqual(c.tokenIn, USDC) ? c.amountIn : 0n;
  return approved > c.borrowedUsdc ? approved - c.borrowedUsdc : 0n;
}

type LogShape = { address: Address; topics: readonly Hex[]; data: Hex };
const TRANSFER_TOPIC = toEventSelector("Transfer(address,address,uint256)").toLowerCase();
const wordAddress = (topic: Hex): Address => getAddress(`0x${topic.slice(26)}`);
const UNITS_PER_NATIVE_UNIT = 10n ** 12n;

// Asked to trace transfers, a node adds a Transfer log for every native-value move. Arc's USDC is native, so each USDC
// move shows twice: the token's own log in 6 decimals and one of these in 18. Reth-style nodes emit them from the
// system address of EIP-7708 (seen live from dRPC on Arc), geth-style nodes from the 0xEeee address.
const NATIVE_MIRRORS: readonly string[] = ["0xfffffffffffffffffffffffffffffffffffffffe", "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"];

// C71: one rule over every Transfer log in the simulation. Whatever leaves the payer must be the cirBTC pledge to Morpho,
// at most amountIn of the sold currency to the adapter, a repayment to Morpho in a close, a bill amount to that bill's
// payee, or the floor self-transfer. A native-value log must mirror one of those as a USDC token transfer. Every bill
// must show its BillPaid from its own AdagBills for this payer. It does not see tokens that move without a Transfer
// log, so C67 and C68 stay the guards and this is the early warning.
export function checkEffects(logs: readonly LogShape[], c: Conversion): void {
  let pledged = 0n;
  let sold = 0n;
  let repaid = 0n;
  let floors = 0;
  const unpaid = [...c.bills];
  const accepted: { token: Address; to: Address; amount: bigint; mirrored: boolean }[] = [];
  const natives: { to: Address; value: bigint }[] = [];
  for (const log of logs) {
    const t = log.topics;
    if (t.length < 3 || t[0]!.toLowerCase() !== TRANSFER_TOPIC) continue;
    if (!isAddressEqual(wordAddress(t[1]!), c.payer)) continue;
    const to = wordAddress(t[2]!);
    if (t.length !== 3 || size(log.data) !== 32) refuse("Something other than a plain token amount would leave your wallet in this payment.");
    const amount = hexToBigInt(log.data);
    const token = log.address;
    if (NATIVE_MIRRORS.includes(token.toLowerCase())) {
      natives.push({ to, value: amount });
      continue;
    }
    if (isAddressEqual(to, c.payer)) {
      if (!isAddressEqual(token, c.tokenOut) || amount !== c.floor) refuse("An unexpected transfer inside this payment would move money out of your wallet.");
      floors++;
    } else if (isAddressEqual(token, CIRBTC) && isAddressEqual(to, MORPHO)) {
      pledged += amount;
      if (pledged > c.pledge) refuse("More cirBTC than the pledge would leave your wallet in this payment.");
    } else if (isAddressEqual(token, c.tokenIn) && isAddressEqual(to, CIRCLE_SWAP_ADAPTER)) {
      sold += amount;
      if (sold > c.amountIn) refuse("More than the amount being converted would leave your wallet for the swap.");
    } else if (c.repay && isAddressEqual(token, c.repay.token) && isAddressEqual(to, MORPHO)) {
      repaid += amount;
      if (repaid > c.repay.max) refuse("More than the loan repayment would leave your wallet in this payment.");
    } else {
      const at = unpaid.findIndex((b) => isAddressEqual(token, b.token) && isAddressEqual(to, b.payee) && amount === b.amount);
      if (at < 0) refuse("A transfer that is not one of your bills would leave your wallet in this payment.");
      unpaid.splice(at, 1);
    }
    accepted.push({ token, to, amount, mirrored: false });
  }
  for (const n of natives) {
    const twin = accepted.find((a) => !a.mirrored && isAddressEqual(a.token, USDC) && isAddressEqual(a.to, n.to) && n.value === a.amount * UNITS_PER_NATIVE_UNIT);
    if (!twin) refuse("Native value would leave your wallet in this payment without a matching USDC transfer.");
    twin!.mirrored = true;
  }
  if (floors !== 1) refuse("The balance check at the end of the swap did not run as built.");
  if (unpaid.length > 0) refuse("A bill in this payment would not receive its amount.");
  for (const b of c.bills) {
    if (!logs.some((log) => matchBillPaid(log, b.contract, b.id, c.payer) !== null)) refuse(`Bill #${b.id} would not show a payment from your wallet on its own contract.`);
  }
}
