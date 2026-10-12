"use client";

import { useLocale, useTranslations } from "next-intl";
import { localDateIn } from "@/i18n/dates";
import { localeOf } from "@/i18n/locales";
import type { Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";

export type GuardRule = { triggerWad: bigint; targetWad: bigint; expiry: bigint };

// One loan's guard in one line: the rule with the approval standing beside it (C60), or the leftover approval when
// there is no rule. The loan card and the alerts page both show exactly this, so they never word it two ways.
export function GuardSummary({ currency, rule, allowance, balance }: { currency: Currency; rule: GuardRule; allowance: bigint; balance: bigint | null }) {
  const t = useTranslations("guard.summary");
  const locale = localeOf(useLocale());
  const sym = currency.symbol;
  const fmt = (v: bigint) => formatUnitsExact(v, currency.decimals);
  const hasRule = rule.triggerWad > 0n;
  const usable = balance !== null ? (allowance < balance ? allowance : balance) : null;
  const expired = hasRule && rule.expiry !== 0n && BigInt(Math.floor(Date.now() / 1000)) >= rule.expiry;

  if (!hasRule) {
    return (
      <>
        <p className="type-body text-muted">{t("notProtected", { symbol: sym })}</p>
        {allowance > 0n && (
          <p className="type-body mt-2 text-pending" data-guard-leftover={allowance.toString()}>
            {t("leftover", { amount: fmt(allowance), symbol: sym })}
          </p>
        )}
      </>
    );
  }
  return (
    <>
      <p className="type-body text-text">
        {t.rich("protected", {
          trigger: formatPercentWad(rule.triggerWad),
          target: formatPercentWad(rule.targetWad),
          usable: usable === null ? "…" : `${fmt(usable)} ${sym}`,
          allowance: fmt(allowance),
          strong: (chunks) => <span className="font-semibold">{chunks}</span>,
          usableSpan: (chunks) => (
            <span className="font-semibold" data-guard-usable={usable?.toString() ?? ""}>
              {chunks}
            </span>
          ),
          allowanceSpan: (chunks) => <span data-guard-allowance={allowance.toString()}>{chunks}</span>,
        })}
        {rule.expiry !== 0n && (
          <span className="text-muted">
            {" "}
            {expired ? t("ended", { date: localDateIn(locale, Number(rule.expiry) * 1000) }) : t("until", { date: localDateIn(locale, Number(rule.expiry) * 1000) })}
          </span>
        )}
      </p>
      {allowance === 0n && <p className="type-body mt-2 text-danger">{t("cannotActZero")}</p>}
      {balance === 0n && (
        <p className="type-body mt-2 text-danger" data-guard-no-balance>
          {t("noBalance", { symbol: sym })}
        </p>
      )}
    </>
  );
}
