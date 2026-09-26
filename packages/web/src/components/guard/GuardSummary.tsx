import type { Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";

export type GuardRule = { triggerWad: bigint; targetWad: bigint; expiry: bigint };

// One loan's guard in one line: the rule with the approval standing beside it (C60), or the leftover approval when
// there is no rule. The loan card and the alerts page both show exactly this, so they never word it two ways.
export function GuardSummary({ currency, rule, allowance, balance }: { currency: Currency; rule: GuardRule; allowance: bigint; balance: bigint | null }) {
  const sym = currency.symbol;
  const fmt = (v: bigint) => formatUnitsExact(v, currency.decimals);
  const hasRule = rule.triggerWad > 0n;
  const usable = balance !== null ? (allowance < balance ? allowance : balance) : null;
  const expired = hasRule && rule.expiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) >= rule.expiry;

  if (!hasRule) {
    return (
      <>
        <p className="type-body text-muted">Not protected. The guard repays part of this loan from your own {sym} if it crosses a line you choose, so Morpho never gets there.</p>
        {allowance > 0n && (
          <p className="type-body mt-2 text-pending" data-guard-leftover={allowance.toString()}>
            AdagGuard still holds an approval of {fmt(allowance)} {sym} with no rule. Stop protecting sets it to 0.
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <p className="type-body text-text">
        Protected: repays at <span className="font-semibold">{formatPercentWad(rule.triggerWad)}</span> down to <span className="font-semibold">{formatPercentWad(rule.targetWad)}</span>. May use up to{" "}
        <span className="font-semibold" data-guard-usable={usable?.toString() ?? ""}>
          {usable === null ? "…" : `${fmt(usable)} ${sym}`}
        </span>{" "}
        (allowance now <span data-guard-allowance={allowance.toString()}>{fmt(allowance)}</span>).
        {rule.expiry !== 0n && (
          <span className="text-muted">
            {" "}
            {expired ? "Ended" : "Until"} {new Date(Number(rule.expiry) * 1000).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" })}.
          </span>
        )}
      </p>
      {allowance === 0n && <p className="type-body mt-2 text-danger">It cannot act: its approval is 0. Change it to give it an amount, or stop protecting.</p>}
      {balance === 0n && (
        <p className="type-body mt-2 text-danger" data-guard-no-balance>
          Your wallet holds no {sym}, so the guard cannot act.
        </p>
      )}
    </>
  );
}
