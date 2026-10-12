"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useLocale, useTranslations } from "next-intl";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { isAddressEqual, size, type Hex } from "viem";
import { BillStamp } from "@/components/BillStamp";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { dateIn } from "@/i18n/dates";
import { localeOf, type Locale } from "@/i18n/locales";
import { useLibText } from "@/i18n/useLibText";
import { adagAbi } from "@/lib/pay/abi";
import { dueFromDate, localIsoDate, parseAmountInput } from "@/lib/pay/amount";
import { buildCreateBill, referenceBytes } from "@/lib/pay/build";
import { billHref } from "@/lib/pay/billId";
import { ADAG_BILLS, BILL_STATUS, CURRENCIES, EXPLORER, MAX_REFERENCE_BYTES, type Currency } from "@/lib/pay/constants";
import { formatUnitsExact, referenceText, shortAddress } from "@/lib/pay/format";
import { billCreatedIn } from "@/lib/pay/receipt";
import { estimateFee, publicArc, simulateAndSend, type TxStep } from "@/lib/wallet/send";
import { readyToSign, useWallet } from "@/lib/wallet/useWallet";
import { ConnectButton } from "./ConnectButton";
import { FeeLine } from "./FeeLine";
import { GetSetUp } from "./GetSetUp";
import { ShareActions } from "./ShareActions";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";
import { useBlockedReason } from "./WalletNotice";

const DEFAULT_DUE_DAYS = 14;

type Written = { id: bigint; hash: Hex };

export function WriteBill() {
  const t = useTranslations("write");
  const tc = useTranslations("common");
  const tl = useLibText();
  const blockedReason = useBlockedReason();
  const locale = localeOf(useLocale());
  const wallet = useWallet();
  const ready = readyToSign(wallet);
  const address = wallet.status === "connected" ? wallet.address : null;
  const ids = { amount: useId(), due: useId(), noDue: useId(), ref: useId(), refNote: useId() };

  const [currency, setCurrency] = useState<Currency>(CURRENCIES[0]!);
  const [amountText, setAmountText] = useState("");
  const [today, setToday] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [noDue, setNoDue] = useState(false);
  const [refText, setRefText] = useState("");
  const [touched, setTouched] = useState(false);
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [written, setWritten] = useState<Written | null>(null);
  const amountInput = useRef<HTMLInputElement>(null);
  const reduceMotion = useReducedMotion();

  // Dates depend on the visitor's clock, so they are set after mount; the server never guesses a time zone.
  useEffect(() => {
    const now = new Date();
    setToday(localIsoDate(now));
    setDueDate(localIsoDate(new Date(now.getTime() + DEFAULT_DUE_DAYS * 86_400_000)));
  }, []);

  const amount = parseAmountInput(amountText, currency.decimals);
  const refBytes: Hex = referenceBytes(refText);
  const refLength = size(refBytes);
  const due: bigint | null = noDue ? 0n : dueDate && today && dueDate >= today ? dueFromDate(dueDate) : null;
  const dueError = noDue ? null : !dueDate ? t("due.chooseOrNone") : today && dueDate < today ? t("due.inThePast") : null;

  // The builder is the validator: whatever it refuses, the form refuses, in its words (C8 as a courtesy).
  const built = useMemo(() => {
    if (!amount.ok) return { ok: false as const, message: amount.message };
    if (due === null) return { ok: false as const, message: dueError ?? t("due.choose") };
    try {
      return { ok: true as const, call: buildCreateBill(currency, amount.value, due, refText) };
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
  }, [amount, due, dueError, currency, refText, t]);

  const feeQuery = useQuery({
    queryKey: ["adag-create-fee", address, built.ok ? built.call.data : null],
    enabled: ready && built.ok && !written,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      if (!built.ok || !address) throw new Error("not ready");
      return estimateFee({ account: address, to: built.call.to, data: built.call.data });
    },
  });

  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));
  const busy = tx.kind === "busy" ? tx : null;

  const write = async () => {
    setTouched(true);
    if (!built.ok || !address || !ready) return;
    const call = built.call;
    const out = await simulateAndSend({ account: address, to: call.to, data: call.data, onStep: step, usdcOut: 0n });
    if (!out.ok) {
      setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    const id = billCreatedIn(out.receipt.logs);
    const record = id
      ? await publicArc()
          .readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [id] })
          .catch(() => null)
      : null;
    const matches =
      id !== null &&
      record !== null &&
      record.status === BILL_STATUS.Open &&
      isAddressEqual(record.payee, address) &&
      isAddressEqual(record.currency, currency.address) &&
      record.amount === (amount.ok ? amount.value : -1n) &&
      record.due === due &&
      record.ref.toLowerCase() === refBytes.toLowerCase();
    if (!matches || id === null) {
      setTx({ kind: "failed", message: t("notAsExpected"), href: `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    setWritten({ id, hash: out.hash });
    setTx({ kind: "idle" });
  };

  const writeAnother = () => {
    const now = new Date();
    setWritten(null);
    setTx({ kind: "idle" });
    setAmountText("");
    setRefText("");
    setTouched(false);
    setNoDue(false);
    setDueDate(localIsoDate(new Date(now.getTime() + DEFAULT_DUE_DAYS * 86_400_000)));
    setToday(localIsoDate(now));
    // The fields stay disabled until the reset renders, and a disabled input cannot take focus, so wait one frame.
    requestAnimationFrame(() => {
      amountInput.current?.scrollIntoView({ behavior: reduceMotion ? "auto" : "smooth", block: "center" });
      amountInput.current?.focus({ preventScroll: true });
    });
  };

  const shareLink = written ? `${typeof window === "undefined" ? "" : window.location.origin}${billHref(ADAG_BILLS, written.id)}` : "";

  const showErrors = touched || amountText !== "";
  const locked = Boolean(busy) || Boolean(written);

  return (
    <section className="relative px-5 pt-12 pb-24 md:px-[6vw] md:pt-[10vh]">
      <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
        <Hallmark>{t("hallmark")}</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[12ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
        {/* The display face has no kerning pair for W and r, which leaves a visible gap, so the W is pulled in by hand. */}
        {t.rich("title", { w: (chunks) => <span className="-mr-[0.07em]">{chunks}</span>, em: (chunks) => <em className="font-semibold text-gold italic">{chunks}</em> })}
      </h1>
      <p className="type-lead app-rise mt-6 max-w-[40rem] text-text/88" style={{ "--d": 2 } as React.CSSProperties}>
        {t("lead")}
      </p>

      <div className="mt-12 grid gap-12 md:mt-16 md:grid-cols-12 md:gap-10">
        <form
          className="app-rise md:col-span-6"
          style={{ "--d": 3 } as React.CSSProperties}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void write();
          }}
        >
          <fieldset disabled={locked} className="space-y-10">
            <div>
              <p className="type-label text-muted">{t("currency")}</p>
              <div role="radiogroup" aria-label={t("currency")} className="mt-3 inline-flex gap-1 rounded-[8px] border border-rule p-1">
                {CURRENCIES.map((c) => {
                  const on = c.symbol === currency.symbol;
                  return (
                    <button
                      key={c.symbol}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => setCurrency(c)}
                      className={`relative inline-flex h-11 min-w-24 items-center justify-center rounded-[6px] px-5 type-ui transition-colors duration-200 ${on ? "text-gold" : "text-muted hover:text-text"}`}
                    >
                      {on && (
                        <motion.span
                          layoutId="write-currency"
                          aria-hidden="true"
                          className="absolute inset-0 rounded-[6px] border border-rule-strong bg-raised"
                          transition={{ type: "spring", stiffness: 500, damping: 38 }}
                        />
                      )}
                      <span className="relative">{c.symbol}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div>
              <label htmlFor={ids.amount} className="type-label text-muted">
                {t("amount")}
              </label>
              <div className="mt-2 flex items-end gap-3">
                <input
                  ref={amountInput}
                  id={ids.amount}
                  name="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  placeholder="0.00"
                  value={amountText}
                  onChange={(e) => setAmountText(e.target.value)}
                  aria-invalid={showErrors && !amount.ok ? true : undefined}
                  className="app-input"
                  data-field="amount"
                />
                <span className="pb-3 font-display text-[1.75rem] italic text-gold">{currency.symbol}</span>
              </div>
              {showErrors && !amount.ok && (
                <p className="type-body mt-2 text-danger" data-error="amount">
                  {tl(amount.message)}
                </p>
              )}
            </div>

            <div>
              <label htmlFor={ids.due} className="type-label text-muted">
                {t("due.label")}
              </label>
              <div className="mt-3 flex flex-wrap items-center gap-5">
                <input
                  id={ids.due}
                  type="date"
                  min={today || undefined}
                  value={dueDate}
                  disabled={noDue}
                  onChange={(e) => setDueDate(e.target.value)}
                  className="h-12 rounded-[8px] border border-rule-strong bg-transparent px-4 type-ui text-text transition-colors duration-200 hover:border-gold disabled:opacity-40"
                />
                <label htmlFor={ids.noDue} className="type-body inline-flex cursor-pointer items-center gap-3 text-text">
                  <input id={ids.noDue} type="checkbox" checked={noDue} onChange={(e) => setNoDue(e.target.checked)} className="h-4 w-4 accent-[var(--gold-fill)]" />
                  {tc("noDueDate")}
                </label>
              </div>
              <p className="type-body mt-2 text-muted">{t("due.shownNeverEnforced")}</p>
              {dueError && <p className="type-body mt-1 text-danger">{dueError}</p>}
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-4">
                <label htmlFor={ids.ref} className="type-label text-muted">
                  {tc("reference")}
                </label>
                <span className={`type-micro tabular-nums ${refLength > MAX_REFERENCE_BYTES ? "text-danger" : "text-muted"}`} data-field="ref-bytes">
                  {t("ref.bytes", { used: String(refLength), max: String(MAX_REFERENCE_BYTES) })}
                </span>
              </div>
              <textarea
                id={ids.ref}
                rows={3}
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                aria-describedby={ids.refNote}
                placeholder={t("ref.placeholder")}
                className="type-body mt-3 w-full resize-y rounded-[8px] border border-rule-strong bg-transparent p-4 text-text transition-colors duration-200 placeholder:text-muted/70 hover:border-gold focus:border-gold focus:outline-none"
                data-field="ref"
              />
              <p id={ids.refNote} className="type-body mt-2 text-muted">
                {t("ref.note")}
              </p>
              {refLength > MAX_REFERENCE_BYTES && (
                <p className="type-body mt-1 text-danger" data-error="ref">
                  {t("ref.tooLong", { used: String(refLength), max: String(MAX_REFERENCE_BYTES) })}
                </p>
              )}
            </div>
          </fieldset>

          <div className="mt-10 border-t border-rule pt-8">
            {!written &&
              (ready ? (
                <div className="flex flex-col gap-4">
                  <Button type="submit" variant="primary" disabled={!built.ok || Boolean(busy)} className="w-full md:w-auto md:self-start" data-action="write-bill">
                    {busy ? <BusyLabel step={busy.step} since={busy.since} /> : t("writeTheBill")}
                  </Button>
                  {!built.ok && showErrors && <p className="type-body text-muted" data-blocked-reason>{t("fixTheField")}</p>}
                  <FeeLine query={feeQuery} idle={t("feeIdle")} />
                </div>
              ) : (
                <div data-blocked="true">
                  <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
                    <p className="type-body max-w-[26rem] text-text">{blockedReason(wallet, "writeBill")}</p>
                    <ConnectButton />
                  </div>
                  {(wallet.status !== "connected" || !wallet.onArc) && <GetSetUp needs={["arc", "usdc"]} className="mt-5" title={t("newToArc")} />}
                </div>
              ))}
            {showErrors && !built.ok && amount.ok && refLength <= MAX_REFERENCE_BYTES && !dueError && (
              <p className="type-body mt-3 text-danger">{tl(built.message)}</p>
            )}
            <div className="mt-4">
              <TxMessage state={tx} />
            </div>

            <AnimatePresence>
              {written && (
                <motion.div
                  data-tx-result="created"
                  data-bill-id={written.id.toString()}
                  initial={{ opacity: 0, y: 24 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: 12, transition: { duration: 0.3, ease: [0.16, 1, 0.3, 1] } }}
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="app-panel p-6 md:p-8"
                >
                  <p className="type-label text-success">{t("writtenOnArc")}</p>
                  <p className="type-h3 mt-3 text-text">{t("readyToShare", { id: written.id.toString() })}</p>
                  <p className="type-address mt-5 break-all rounded-[6px] border border-rule bg-bg/40 p-3 text-text" data-share-link>
                    {shareLink}
                  </p>
                  <div className="mt-5 flex flex-col gap-3 md:flex-row md:flex-wrap">
                    <ShareActions
                      url={shareLink}
                      title={tc("billNumber", { id: written.id.toString() })}
                      text={tc("shareTextAmount", { id: written.id.toString(), amount: amount.ok ? formatUnitsExact(amount.value, currency.decimals) : "", symbol: currency.symbol })}
                    />
                    <Button href={billHref(ADAG_BILLS, written.id)} variant="secondary" className="w-full md:w-auto">
                      {t("openTheBillPage")}
                    </Button>
                    <Button type="button" variant="secondary" className="w-full md:w-auto" data-action="write-another" onClick={writeAnother}>
                      {t("writeAnother")}
                    </Button>
                  </div>
                  <a href={`${EXPLORER}/tx/${written.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address mt-5 inline-block text-muted hover:text-gold">
                    {tc("transactionOnExplorer", { hash: shortAddress(written.hash) })}
                  </a>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </form>

        <div className="app-rise md:col-span-6" style={{ "--d": 4 } as React.CSSProperties}>
          <div className="md:sticky md:top-28">
            <p className="type-label text-muted">{t("preview.label")}</p>
            <Preview
              currency={currency}
              amount={amount.ok ? amount.value : null}
              due={due}
              refBytes={refLength <= MAX_REFERENCE_BYTES ? refBytes : null}
              payee={address}
              written={written}
              locale={locale}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

type PreviewProps = { currency: Currency; amount: bigint | null; due: bigint | null; refBytes: Hex | null; payee: string | null; written: Written | null; locale: Locale };

// Rendered from the same integer and the same bytes the transaction carries (C15), and the reference as text only (C14).
function Preview({ currency, amount, due, refBytes, payee, written, locale }: PreviewProps) {
  const t = useTranslations("write.preview");
  const tc = useTranslations("common");
  const reference = refBytes ? referenceText(refBytes) : null;
  return (
    <div className="app-panel relative mt-4 overflow-hidden p-6 md:p-9" data-preview>
      <div className="flex items-start justify-between gap-4">
        <div className="min-h-[5.5rem]">
          <p className="type-micro text-muted">{t("billNo")}</p>
          <AnimatePresence mode="wait">
            {written ? (
              <motion.p
                key="number"
                className="mt-1 font-display text-[clamp(3.5rem,7vw,6rem)] leading-[0.9] font-semibold tracking-[-0.03em] text-gold"
                initial={{ clipPath: "inset(0 100% 0 0)", opacity: 0.4 }}
                animate={{ clipPath: "inset(0 0% 0 0)", opacity: 1 }}
                transition={{ duration: 1.1, ease: [0.16, 1, 0.3, 1], delay: 0.35 }}
                data-drawn-number
              >
                {tc("no", { id: written.id.toString() })}
              </motion.p>
            ) : (
              <motion.p key="pending" className="mt-1 font-display text-[clamp(3.5rem,7vw,6rem)] leading-[0.9] text-rule-strong" exit={{ opacity: 0 }}>
                {tc("no", { id: "?" })}
              </motion.p>
            )}
          </AnimatePresence>
        </div>
        <div className="app-stamp pt-2">
          {written ? (
            <BillStamp status="open" entrance="in-view" tilt={-7} />
          ) : (
            <span className="type-micro inline-block -rotate-6 rounded-[3px] border-2 border-dashed border-rule-strong px-4 py-3 text-muted">{t("draft")}</span>
          )}
        </div>
      </div>

      <p className="mt-8 font-display text-[clamp(2.75rem,6vw,4.75rem)] leading-[0.9] font-semibold tracking-[-0.03em] tabular-nums text-text">
        {amount !== null ? formatUnitsExact(amount, currency.decimals) : "0.00"}
        <span className="app-amount-unit">{currency.symbol}</span>
      </p>

      <dl className="app-ledger mt-8 border-y border-rule">
        <div className="app-ledger-row">
          <dt className="type-micro text-muted">{tc("pays")}</dt>
          <dd className={`type-address min-w-0 text-text ${payee ? "break-all" : ""}`}>{payee ?? t("yourConnectedWallet")}</dd>
        </div>
        <div className="app-ledger-row">
          <dt className="type-micro text-muted">{t("due")}</dt>
          <dd className="type-body text-text">{due === null ? t("chooseADate") : due === 0n ? tc("noDueDate") : dateIn(locale, due)}</dd>
        </div>
        <div className="app-ledger-row">
          <dt className="type-micro text-muted">{tc("reference")}</dt>
          <dd className="type-body min-w-0 text-text">
            {reference === null ? <span className="text-danger">{t("tooLong")}</span> : reference ? <span className="app-reference">{reference}</span> : <span className="text-muted">{tc("none")}</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}
