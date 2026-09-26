"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { formatUnits, parseUnits, type Address } from "viem";
import { Button } from "@/components/Button";
import { FeeLine } from "@/components/app/FeeLine";
import { BusyLabel } from "@/components/app/TxProgress";
import { buildSaveRule, ruleProblem, type RuleInput } from "@/lib/guard/build";
import { ltvAfter, planRepay, type LoanState } from "@/lib/guard/plan";
import { parseAmountInput } from "@/lib/pay/amount";
import type { Currency } from "@/lib/pay/constants";
import { formatPercentWad, formatUnitsExact } from "@/lib/pay/format";
import { estimateFee, type TxStep } from "@/lib/wallet/send";
import { GuardGauge } from "./GuardGauge";

export type Initial = { triggerWad: bigint; targetWad: bigint; expiry: bigint; approval: bigint };

type Props = {
  address: Address;
  currency: Currency;
  loan: LoanState | null;
  ltvWad: bigint | null;
  balance: bigint | null;
  initial: Initial | null;
  busy: { step: TxStep; since: number } | null;
  onSave: (rule: RuleInput, approval: bigint) => void;
  onCancel: () => void;
};

// Percent with at most two decimals, as a WAD: "55.5" is 0.555e18.
function parsePercent(text: string): bigint | null {
  const t = text.trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(t)) return null;
  return parseUnits(t, 16);
}
const percentText = (wad: bigint) => formatUnits(wad, 16);

function endOfDay(date: string): bigint | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  const ms = new Date(`${date}T23:59:59`).getTime();
  return Number.isFinite(ms) ? BigInt(Math.floor(ms / 1000)) : null;
}
function dateOf(expiry: bigint): string {
  if (expiry === 0n) return "";
  const d = new Date(Number(expiry) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function ProtectPanel({ address, currency, loan, ltvWad, balance, initial, busy, onSave, onCancel }: Props) {
  const lltv = currency.params.lltv;
  const sym = currency.symbol;
  const [triggerText, setTriggerText] = useState(initial ? percentText(initial.triggerWad) : "65");
  const [targetText, setTargetText] = useState(initial ? percentText(initial.targetWad) : "50");
  const [amountText, setAmountText] = useState(initial && initial.approval > 0n ? formatUnits(initial.approval, currency.decimals) : "");
  const [endDate, setEndDate] = useState(initial ? dateOf(initial.expiry) : "");

  const triggerWad = parsePercent(triggerText);
  const targetWad = parsePercent(targetText);
  const amount = parseAmountInput(amountText, currency.decimals);
  const expiry = endDate ? endOfDay(endDate) : 0n;
  const nowSeconds = BigInt(Math.floor(Date.now() / 1000));

  const rule: RuleInput | null = triggerWad !== null && targetWad !== null && expiry !== null ? { market: currency.marketId, triggerWad, targetWad, expiry } : null;
  const problem =
    triggerWad === null || targetWad === null
      ? "Use a percentage like 55 or 55.5."
      : expiry === null
        ? "Choose a real end date, or none."
        : ruleProblem(rule!, lltv, nowSeconds);
  const amountProblem = amountText === "" ? null : amount.ok ? null : amount.message;
  const ready = rule !== null && problem === null && amount.ok;

  // What this rule would do at today's price if it were saved now (C41), from the guard's own arithmetic.
  const plan = loan && rule && problem === null ? planRepay(loan, rule, amount.ok ? amount.value : 0n, balance ?? 0n) : null;
  const landing = loan && plan && plan.amount > 0n ? ltvAfter(loan, plan.amount) : null;
  // One protection starting exactly at the trigger repays about debt x (trigger - target) / trigger.
  const perStep = loan && plan && triggerWad && targetWad && triggerWad > targetWad ? (plan.debt * (triggerWad - targetWad)) / triggerWad : null;
  const fall = ltvWad !== null && triggerWad && ltvWad < triggerWad ? 10_000n - (ltvWad * 10_000n) / triggerWad : null;

  const fee = useQuery({
    queryKey: ["adag-fee", "guard-save", currency.marketId, address, triggerText, targetText, amountText, endDate],
    enabled: ready,
    staleTime: 30_000,
    retry: false,
    queryFn: () => {
      const built = buildSaveRule(address, rule!, (amount as { value: bigint }).value, lltv, nowSeconds);
      return estimateFee({ account: address, to: built.to, data: built.data });
    },
  });

  const approval = amount.ok ? amount.value : null;
  const isUsdc = sym === "USDC";

  return (
    <div className="mt-5" data-protect-panel={sym}>
      <GuardGauge ltvWad={ltvWad} triggerWad={triggerWad} targetWad={targetWad} lltv={lltv} />

      <div className="grid gap-5 md:grid-cols-2">
        <PercentField
          label="Step in when the loan reaches"
          value={triggerText}
          onChange={setTriggerText}
          max={Number((lltv * 100n) / 10n ** 18n) - 1}
          field="guard-trigger"
          hint={`Morpho liquidates at ${formatPercentWad(lltv)}.`}
        />
        <PercentField label="Repay it down to" value={targetText} onChange={setTargetText} max={Number((lltv * 100n) / 10n ** 18n) - 2} field="guard-target" hint="Only what brings it back here, each time." />
      </div>

      <div className="mt-5 grid gap-5 md:grid-cols-2">
        <label className="block">
          <span className="type-micro text-muted">
            {sym} it may use, in total · you hold {balance === null ? "…" : formatUnitsExact(balance, currency.decimals)}
          </span>
          <span className="mt-1 flex items-end gap-3">
            <input
              inputMode="decimal"
              autoComplete="off"
              placeholder={`Amount in ${sym}`}
              value={amountText}
              onChange={(e) => setAmountText(e.target.value)}
              className="app-input !text-[1.6rem]"
              data-field="guard-amount"
            />
            {perStep !== null && perStep > 0n && (
              <button
                type="button"
                onClick={() => setAmountText(formatUnits(perStep, currency.decimals))}
                className="type-micro mb-2 shrink-0 rounded-[6px] border border-rule-strong px-3 py-2 text-text transition-colors duration-200 hover:border-gold hover:text-gold"
                data-action="guard-one-step"
              >
                One step
              </button>
            )}
          </span>
          <span className="type-micro mt-2 block normal-case tracking-[0.04em] text-muted">
            {perStep !== null && perStep > 0n
              ? `One protection starting at the trigger repays about ${formatUnitsExact(perStep, currency.decimals)} ${sym}.`
              : "It never takes more than this, however many times it acts."}
          </span>
        </label>
        <label className="block">
          <span className="type-micro text-muted">End date · optional</span>
          <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} className="app-input mt-1 !text-[1.25rem]" data-field="guard-expiry" />
          <span className="type-micro mt-2 block normal-case tracking-[0.04em] text-muted">With no date, it stays on until you stop it.</span>
        </label>
      </div>

      {(problem || amountProblem) && (triggerText || targetText || amountText) ? (
        <p className="type-body mt-4 text-danger" data-guard-problem>
          {problem ?? amountProblem}
        </p>
      ) : null}

      {ready && plan && (
        <div className="mt-5 rounded-[8px] border border-rule p-4" data-guard-preview>
          {plan.amount > 0n ? (
            <p className="type-body text-pending" data-guard-act-now={plan.amount.toString()}>
              Your loan is already at {formatPercentWad(plan.ltvWad)}, past this trigger. Once saved, this will repay about{" "}
              <span className="font-semibold text-text">
                {formatUnitsExact(plan.amount, currency.decimals)} {sym}
              </span>{" "}
              within minutes{landing !== null ? `, bringing it to about ${formatPercentWad(landing)}` : ""}.
            </p>
          ) : (
            <p className="type-body text-text">
              It would not act at today&apos;s price.{" "}
              {fall !== null ? `It steps in if bitcoin falls about ${(Number(fall) / 100).toFixed(2)}% from here.` : ""}
            </p>
          )}
        </div>
      )}

      <div className="mt-5 flex flex-col gap-2" data-guard-ceiling>
        <p className="type-body text-text">
          The most this can ever take is your approval{approval !== null ? `: ${formatUnitsExact(approval, currency.decimals)} ${sym}` : ""}. Each time it acts, it repays only what brings the
          loan back to your target, and the approval shrinks by that much.
        </p>
        <p className="type-body text-muted">It can only ever repay your own loan, from this approval. Once the loan passes your trigger, anyone may set it off, Adag included.</p>
        {isUsdc && (
          <p className="type-body text-muted" data-guard-gas-warning>
            On Arc, USDC also pays the network fee. A USDC rule uses the same balance, so it can leave this wallet without enough USDC to send a transaction.
          </p>
        )}
      </div>

      <FeeLine query={fee} className="mt-4" idle="The network fee shows once the rule and amount are valid." />

      <div className="mt-5 flex flex-col gap-3 md:flex-row">
        <Button variant="primary" disabled={!ready || Boolean(busy)} onClick={() => ready && onSave(rule!, amount.value)} data-action="protect-save" className="w-full md:w-auto">
          {busy ? <BusyLabel step={busy.step} since={busy.since} /> : initial ? "Save the new rule" : "Protect this loan"}
        </Button>
        <Button variant="secondary" disabled={Boolean(busy)} onClick={onCancel} className="w-full md:w-auto">
          Cancel
        </Button>
      </div>
      <p className="type-micro mt-3 normal-case tracking-[0.04em] text-muted">One signature: the approval for exactly this amount, then the rule.</p>
    </div>
  );
}

function PercentField({ label, value, onChange, max, field, hint }: { label: string; value: string; onChange: (v: string) => void; max: number; field: string; hint: string }) {
  const n = Number(value);
  return (
    <label className="block">
      <span className="type-micro text-muted">{label}</span>
      <span className="mt-1 flex items-end gap-2">
        <input inputMode="decimal" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} className="app-input !w-28 !text-[1.6rem]" data-field={field} />
        <span className="type-h4 mb-2 text-muted">%</span>
      </span>
      <input
        type="range"
        min={1}
        max={max}
        step={0.5}
        value={Number.isFinite(n) ? Math.min(Math.max(n, 1), max) : 1}
        onChange={(e) => onChange(e.target.value)}
        className="mt-3 w-full accent-[var(--gold-fill)]"
        aria-label={label}
      />
      <span className="type-micro mt-1 block normal-case tracking-[0.04em] text-muted">{hint}</span>
    </label>
  );
}
