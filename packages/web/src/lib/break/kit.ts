import { encodeAbiParameters, encodeFunctionData, isAddressEqual, keccak256, type Address, type Hex } from "viem";
import { ADAPTIVE_CURVE_IRM, CIRBTC, MARKET_USDC, USDC, USDC_MARKET_LLTV, USDC_MARKET_ORACLE } from "@/lib/arc/constants";
import { OTHER_USDC_CIRBTC_MARKET } from "@/lib/pay/constants";
import { erc20Abi } from "./abi";
import type { CheckId } from "./catalogue";
import { MOCK_ORACLE_CODE } from "./constants";
import { SuiteError } from "./errors";
import { decodeRevert, type Call, type SimResult } from "./simulate";

export const STATUS = ["None", "Open", "Paid", "Void"] as const;
export const WAD = 10n ** 18n;
export const ORACLE_SCALE = 10n ** 36n;

export type Step = { to: Address; data: Hex };
export type Params = { loanToken: Address; collateralToken: Address; oracle: Address; irm: Address; lltv: bigint };
export type Pin = { number: bigint; timestamp: bigint };

// Reports one check. The suite turns it into a result line with the verdict the catalogue expects.
export type Row = (id: CheckId, pass: boolean, reason: string, raw: string, gas: bigint | null) => void;

export const tx = (from: Address, s: Step): Call => ({ from, to: s.to, data: s.data });
export const approve = (token: Address, spender: Address, amount: bigint): Step => ({
  to: token,
  data: encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [spender, amount] }),
});
export const outcome = (r: SimResult) => (r.ok ? "success" : decodeRevert(r.revertData));

// MARKET_USDC with its last hex digit changed: the kind of id a careless or hostile page builds.
export const LOOK_ALIKE: Hex = `${MARKET_USDC.slice(0, -1)}${MARKET_USDC.endsWith("d") ? "e" : "d"}` as Hex;

export const tidy = (s: string) =>
  s
    .split(MARKET_USDC)
    .join("MARKET_USDC")
    .split(OTHER_USDC_CIRBTC_MARKET)
    .join("OTHER_MARKET")
    .split(LOOK_ALIKE)
    .join("LOOK_ALIKE")
    .replace(/BillNotOpen\((\d+), (\d)\)/g, (_, id: string, st: string) => `BillNotOpen(${id}, ${STATUS[Number(st)] ?? st})`);

const fixed = (v: bigint, decimals: number) => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  return `${neg ? "-" : ""}${abs / scale}.${(abs % scale).toString().padStart(decimals, "0")}`;
};
export const usdc = (v: bigint) => `${fixed(v, 6)} USDC`;
export const btc = (v: bigint) => `${fixed(v, 8)} cirBTC`;
export const pct = (wad: bigint) => (wad === 2n ** 256n - 1n ? "no collateral" : `${(Number(wad) / 1e16).toFixed(2)}%`);
export const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;
export const usdPrice = (price: bigint) => (Number(price) / 1e34).toLocaleString("en-US", { maximumFractionDigits: 2 });

// Morpho's own rounding, restated so the checks do not lean on the contracts' maths.
export const debtUp = (shares: bigint, totalAssets: bigint, totalShares: bigint) =>
  shares === 0n ? 0n : ceilDiv(shares * (totalAssets + 1n), totalShares + 1_000_000n);
export const debtDown = (shares: bigint, totalAssets: bigint, totalShares: bigint) => (shares * (totalAssets + 1n)) / (totalShares + 1_000_000n);
export function ltvOf(debt: bigint, collateral: bigint, price: bigint): bigint {
  if (debt === 0n) return 0n;
  const value = (collateral * price) / ORACLE_SCALE;
  if (value === 0n) return 2n ** 256n - 1n;
  return ceilDiv(debt * WAD, value);
}

export type LoanNow = { shares: bigint; collateral: bigint; price: bigint; totalAssets: bigint; totalShares: bigint; debt: bigint };

// The loan guard rows' premise, mirroring loanPremise in packages/contracts/prove-it/guard-prove.mjs: the one
// borrow or repay on Morpho that puts the loan at `level`, following Morpho's own rounding (shares minted rounded
// up on a borrow, burned rounded down on a repay, debt read back rounded up), so it lands at or just under it.
export function loanPremise(b: LoanNow, level: bigint): { kind: "borrow" | "repay" | "none"; amount: bigint } {
  if (b.shares === 0n || b.collateral === 0n) throw new SuiteError("The payer has no USDC-market loan with collateral behind it, so no premise can place it at a level.");
  const value = (b.collateral * b.price) / ORACLE_SCALE;
  const maxDebt = (value * level) / WAD;
  const P = b.totalAssets + 1n;
  const Q = b.totalShares + 1_000_000n;
  const s = b.shares;
  if (b.debt === maxDebt) return { kind: "none", amount: 0n };
  if (b.debt < maxDebt) {
    const debtAfter = (x: bigint) => {
      const minted = ceilDiv(x * Q, P);
      return ceilDiv((s + minted) * (P + x), Q + minted);
    };
    let x = maxDebt - b.debt;
    while (x > 0n && debtAfter(x) > maxDebt) x -= 1n;
    return { kind: "borrow", amount: x };
  }
  const debtAfter = (x: bigint) => {
    const burned = (x * Q) / P;
    return burned >= s ? 0n : ceilDiv((s - burned) * (P - x), Q - burned);
  };
  let x = b.debt - maxDebt;
  while (debtAfter(x) > maxDebt) x += 1n;
  // Never past the debt rounded down, the most a repayment by amount can be without Morpho underflowing.
  const most = (s * P) / Q;
  if (x > most) x = most;
  return { kind: "repay", amount: x };
}

// "MemoFailed(LtvAboveLimit(m, borrowed, max))" in plain words, with both figures in USDC.
export function overLimit(raw: string): string | null {
  const m = /LtvAboveLimit\([^,]+, (\d+), (\d+)\)/.exec(raw);
  if (!m) return null;
  return `the loan would be ${usdc(BigInt(m[1]!))} against a limit of ${usdc(BigInt(m[2]!))}, which is 40% of the bitcoin's value`;
}

// The fetched params are held to the fixed market id and to every constant, as prove-it's lib.mjs does (C12).
export function verifyUsdcParams(p: Params) {
  const id = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
      [p.loanToken, p.collateralToken, p.oracle, p.irm, p.lltv],
    ),
  );
  const same =
    id.toLowerCase() === MARKET_USDC.toLowerCase() &&
    isAddressEqual(p.loanToken, USDC) &&
    isAddressEqual(p.collateralToken, CIRBTC) &&
    isAddressEqual(p.oracle, USDC_MARKET_ORACLE) &&
    isAddressEqual(p.irm, ADAPTIVE_CURVE_IRM) &&
    p.lltv === USDC_MARKET_LLTV;
  if (!same) throw new SuiteError("Morpho's USDC market params do not match the fixed market.");
}

// Runtime code for the mock oracle: a fixed price, and the real oracle's feeds so the freshness checks still read Chainlink.
export function mockOracleCode(price: bigint, baseFeed: Address, quoteFeed: Address): Hex {
  const swap = (code: string, sentinel: string, value: string) => {
    if (code.split(sentinel).length !== 2) throw new SuiteError(`MockOracle sentinel ${sentinel.slice(0, 8)} not found exactly once.`);
    return code.replace(sentinel, value);
  };
  let code = MOCK_ORACLE_CODE.toLowerCase();
  code = swap(code, "5eed".repeat(16), price.toString(16).padStart(64, "0"));
  code = swap(code, "b0".repeat(20), baseFeed.slice(2).toLowerCase());
  code = swap(code, "c0".repeat(20), quoteFeed.slice(2).toLowerCase());
  return code as Hex;
}
