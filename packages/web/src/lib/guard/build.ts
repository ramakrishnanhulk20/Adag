// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node. Browser-safe.
import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, isAddressEqual, toFunctionSelector, type Address, type Hex } from "viem";
import { EURC, MARKET_EURC, MARKET_USDC, USDC } from "../arc/constants";
import { erc20Abi, multicall3FromAbi } from "../pay/abi";
import { MULTICALL3_FROM } from "../pay/constants";
import { guardAbi } from "./abi";
import { ADAG_GUARD } from "./constants";

export type Call3 = { target: Address; allowFailure: false; callData: Hex };
export type GuardBatch = { to: Address; data: Hex; calls: readonly Call3[] };
export type RuleInput = { market: Hex; triggerWad: bigint; targetWad: bigint; expiry: bigint };

export class GuardBuildError extends Error {}

const LOAN_TOKEN: Record<string, Address> = { [MARKET_USDC]: USDC, [MARKET_EURC]: EURC };
const MAX_UINT64 = 2n ** 64n;
// A billion tokens in 6-decimal units: anything above is not an amount anyone typed.
const MAX_APPROVAL = 10n ** 15n;
const APPROVE = "0x095ea7b3";
const SET_RULE = encodeFunctionData({ abi: guardAbi, functionName: "setRule", args: [MARKET_USDC, 1n, 0n, 0n] }).slice(0, 10);
const CLEAR_RULE = encodeFunctionData({ abi: guardAbi, functionName: "clearRule", args: [MARKET_USDC] }).slice(0, 10);

function guard(): Address {
  if (!ADAG_GUARD) throw new GuardBuildError("The loan guard is not deployed, so nothing was built.");
  return ADAG_GUARD;
}

function market(value: unknown): Hex {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  if (lower === MARKET_USDC || lower === MARKET_EURC) return lower as Hex;
  throw new GuardBuildError("Only Adag's USDC and EURC markets can be protected.");
}

function wallet(value: unknown): Address {
  if (typeof value !== "string" || !isAddress(value, { strict: false })) throw new GuardBuildError("The wallet address is not valid.");
  return getAddress(value);
}

// The same checks setRule makes, in the same order, with plain words, before anything is built (C41).
export function ruleProblem(rule: RuleInput, lltv: bigint, nowSeconds: bigint): string | null {
  if (rule.targetWad <= 0n) return "Choose a target above 0%.";
  if (rule.targetWad >= rule.triggerWad) return "The target must be below the trigger: the guard repays from the trigger down to the target.";
  if (rule.triggerWad >= lltv) return "The trigger must be below Morpho's liquidation line.";
  if (rule.triggerWad >= MAX_UINT64 || rule.targetWad >= MAX_UINT64) return "Those percentages are out of range.";
  if (rule.expiry !== 0n && rule.expiry <= nowSeconds) return "The end date must be in the future.";
  if (rule.expiry >= MAX_UINT64) return "The end date is not a date Arc can store.";
  return null;
}

const step = (target: Address, callData: Hex): Call3 => ({ target, allowFailure: false, callData });

// C3 for this path only: a copy of the target list with AdagGuard in it. A guard batch may reach AdagGuard and the
// market's own loan token, approve only AdagGuard, for exactly the amount given, and call nothing else.
function assertGuardCalls(calls: readonly Call3[], m: Hex, approval: bigint) {
  const g = guard();
  const token = LOAN_TOKEN[m]!;
  for (const c of calls) {
    if (c.allowFailure !== false) throw new GuardBuildError("Refusing a batch step that may fail on its own.");
    const selector = c.callData.slice(0, 10).toLowerCase();
    if (isAddressEqual(c.target, token)) {
      if (selector !== APPROVE) throw new GuardBuildError("Refusing a token call that is not an approval.");
      const { args } = decodeFunctionData({ abi: erc20Abi, data: c.callData });
      if (!isAddressEqual(args[0] as Address, g)) throw new GuardBuildError(`Refusing an approval to ${String(args[0])}.`);
      if (args[1] !== approval) throw new GuardBuildError("Refusing an approval other than the amount you chose.");
    } else if (isAddressEqual(c.target, g)) {
      if (selector !== SET_RULE && selector !== CLEAR_RULE) throw new GuardBuildError("Refusing a guard call other than setting or clearing a rule.");
      const { args } = decodeFunctionData({ abi: guardAbi, data: c.callData });
      if (String(args[0]).toLowerCase() !== m) throw new GuardBuildError("Refusing a rule for another market.");
    } else {
      throw new GuardBuildError(`Refusing a batch that calls ${c.target}.`);
    }
  }
}

function batch(calls: Call3[], m: Hex, approval: bigint): GuardBatch {
  assertGuardCalls(calls, m, approval);
  return { to: MULTICALL3_FROM, data: encodeFunctionData({ abi: multicall3FromAbi, functionName: "aggregate3", args: [calls] }), calls };
}

// Save: approve exactly the amount typed, never more and never unlimited (C38), then set the rule, in one signature.
export function buildSaveRule(owner: string, rule: RuleInput, approval: bigint, lltv: bigint, nowSeconds: bigint): GuardBatch {
  wallet(owner);
  const m = market(rule.market);
  const problem = ruleProblem(rule, lltv, nowSeconds);
  if (problem) throw new GuardBuildError(problem);
  if (typeof approval !== "bigint" || approval <= 0n) throw new GuardBuildError("Choose how much it may use, more than zero.");
  if (approval > MAX_APPROVAL) throw new GuardBuildError("That approval is larger than any amount this page will build.");
  const g = guard();
  return batch(
    [
      step(LOAN_TOKEN[m]!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [g, approval] })),
      step(g, encodeFunctionData({ abi: guardAbi, functionName: "setRule", args: [m, rule.triggerWad, rule.targetWad, rule.expiry] })),
    ],
    m,
    approval,
  );
}

// Stop: clear the rule and set the approval to 0 in the same transaction (C60). With no rule left, only the approval goes.
export function buildStopRule(owner: string, marketId: Hex, hasRule: boolean): GuardBatch {
  wallet(owner);
  const m = market(marketId);
  const g = guard();
  const calls: Call3[] = [];
  if (hasRule) calls.push(step(g, encodeFunctionData({ abi: guardAbi, functionName: "clearRule", args: [m] })));
  calls.push(step(LOAN_TOKEN[m]!, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [g, 0n] })));
  return batch(calls, m, 0n);
}

export type ProtectNowTx = { to: Address; data: Hex; value: 0n };

const PROTECT = toFunctionSelector("protect(address,bytes32)");
// "0x", the selector and two 32-byte words: protect's calldata has one exact length.
const PROTECT_LENGTH = 2 + 8 + 64 * 2;

// C3 for "Repay it now": one plain transaction to AdagGuard, calling protect, for the signer's own loan in one of the
// two fixed markets, with no value. protect is open to anyone, but this page only ever sets off the signer's own guard.
export function assertProtectNow(signer: string, tx: ProtectNowTx): void {
  const g = guard();
  const who = wallet(signer);
  if (!isAddressEqual(tx.to, g)) throw new GuardBuildError(`Refusing a repayment sent to ${tx.to} instead of AdagGuard.`);
  if (tx.value !== 0n) throw new GuardBuildError("Refusing a repayment that sends value.");
  if (tx.data.slice(0, 10).toLowerCase() !== PROTECT) throw new GuardBuildError("Refusing a guard call other than protect.");
  if (tx.data.length !== PROTECT_LENGTH) throw new GuardBuildError("Refusing protect calldata of the wrong length.");
  const { args } = decodeFunctionData({ abi: guardAbi, data: tx.data });
  if (!isAddressEqual(args[0] as Address, who)) throw new GuardBuildError("Refusing to set off another wallet's guard.");
  market(args[1]);
}

export function buildProtectNow(signer: string, borrower: string, marketId: Hex): ProtectNowTx {
  const who = wallet(signer);
  if (!isAddressEqual(wallet(borrower), who)) throw new GuardBuildError("This page only repays the connected wallet's own loan.");
  const tx: ProtectNowTx = { to: guard(), data: encodeFunctionData({ abi: guardAbi, functionName: "protect", args: [who, market(marketId)] }), value: 0n };
  assertProtectNow(who, tx);
  return tx;
}

export const guardLoanToken = (marketId: Hex): Address => LOAN_TOKEN[market(marketId)]!;
