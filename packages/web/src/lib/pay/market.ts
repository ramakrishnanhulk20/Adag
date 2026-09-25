import { encodeAbiParameters, isAddressEqual, keccak256, type Hex } from "viem";
import { CURRENCIES, type Currency, type MarketParams } from "./constants";

// Ported from packages/contracts/prove-it/lib.mjs. Morpho's market id is keccak256 of the abi-encoded params, so a
// match proves every field, oracle and rate model included, whatever RPC served them (C3). Throws on any mismatch.
export function verifyMarketParams(params: MarketParams, marketId: Hex): void {
  let id: Hex;
  try {
    id = keccak256(
      encodeAbiParameters(
        [{ type: "address" }, { type: "address" }, { type: "address" }, { type: "address" }, { type: "uint256" }],
        [params.loanToken, params.collateralToken, params.oracle, params.irm, params.lltv],
      ),
    );
  } catch {
    throw new Error(`Market params for ${marketId} are malformed; refusing to sign with them.`);
  }
  if (id.toLowerCase() !== marketId.toLowerCase()) {
    throw new Error(`Market params hash to ${id}, not ${marketId}; refusing to sign with them.`);
  }
}

// Belt and braces beside the hash, as prove-it's assertUsdcMarketConstants: every field equals the build-time value.
export function assertMarketConstants(params: MarketParams, currency: Currency): void {
  const want = currency.params;
  const same =
    isAddressEqual(params.loanToken, want.loanToken) &&
    isAddressEqual(params.collateralToken, want.collateralToken) &&
    isAddressEqual(params.oracle, want.oracle) &&
    isAddressEqual(params.irm, want.irm) &&
    params.lltv === want.lltv;
  if (!same) throw new Error(`Market params for ${currency.marketId} differ from the fixed ${currency.symbol} market; refusing to sign with them.`);
}

export function currencyOf(address: string): Currency | null {
  for (const c of CURRENCIES) {
    try {
      if (isAddressEqual(address as Hex, c.address)) return c;
    } catch {
      return null;
    }
  }
  return null;
}

// Morpho returns the tuple positionally; this names it without trusting any field yet.
export function paramsFromTuple(t: readonly [Hex, Hex, Hex, Hex, bigint]): MarketParams {
  return { loanToken: t[0], collateralToken: t[1], oracle: t[2], irm: t[3], lltv: t[4] };
}
