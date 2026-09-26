// Plain TypeScript with relative imports only, so the unit tests can load it under bare Node.
import { decodeFunctionData, encodeFunctionData, getAddress, isAddress, type Address, type Hex } from "viem";
import { MARKET_EURC, MARKET_USDC } from "../arc/constants";
import { protectAbi } from "./abi";
import { ADAG_GUARD, PROTECT_SELECTOR } from "./constants";

declare const protectCallBrand: unique symbol;
// The only thing the keeper wallet will sign: protect(borrower, market) to AdagGuard, with nothing attached (C39).
export type ProtectCall = { readonly to: Address; readonly data: Hex; readonly value: 0n; readonly [protectCallBrand]: true };

export class CallError extends Error {}

const ZERO = "0x0000000000000000000000000000000000000000";

function fixedMarket(value: unknown): Hex {
  const lower = typeof value === "string" ? value.toLowerCase() : "";
  if (lower === MARKET_USDC) return MARKET_USDC;
  if (lower === MARKET_EURC) return MARKET_EURC;
  throw new CallError("Only Adag's two markets can be protected.");
}

function fixedGuard(): Address {
  if (!ADAG_GUARD) throw new CallError("The loan guard is not deployed yet.");
  return ADAG_GUARD;
}

export function buildProtectCall(borrower: unknown, marketId: unknown): ProtectCall {
  if (typeof borrower !== "string" || !isAddress(borrower, { strict: false })) throw new CallError("The borrower is not an address.");
  const who = getAddress(borrower);
  if (who === ZERO) throw new CallError("The borrower is not an address.");
  const call = { to: fixedGuard(), data: encodeFunctionData({ abi: protectAbi, functionName: "protect", args: [who, fixedMarket(marketId)] }), value: 0n as const };
  assertProtectCall(call);
  return Object.freeze(call) as ProtectCall;
}

// Checked again right before signing, from the bytes themselves, so nothing that reshaped the object in between gets through.
export function assertProtectCall(call: { to: unknown; data: unknown; value: unknown }): asserts call is ProtectCall {
  if (typeof call.to !== "string" || call.to !== fixedGuard()) throw new CallError("The call is not to AdagGuard.");
  if (call.value !== 0n) throw new CallError("The call carries value.");
  if (typeof call.data !== "string" || !call.data.startsWith(PROTECT_SELECTOR)) throw new CallError("The call is not protect.");
  let decoded;
  try {
    decoded = decodeFunctionData({ abi: protectAbi, data: call.data as Hex });
  } catch {
    throw new CallError("The call is not protect.");
  }
  const [who, market] = decoded.args;
  fixedMarket(market);
  if (who === ZERO) throw new CallError("The borrower is not an address.");
  // A re-encoding must give the same bytes, so no trailing data rides along.
  const again = encodeFunctionData({ abi: protectAbi, functionName: "protect", args: [who, market] });
  if (again !== call.data.toLowerCase()) throw new CallError("The call carries extra bytes.");
}
