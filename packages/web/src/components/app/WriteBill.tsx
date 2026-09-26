"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import { isAddressEqual, size, type Hex } from "viem";
import { BillStamp } from "@/components/BillStamp";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { adagAbi } from "@/lib/pay/abi";
import { dueFromDate, localIsoDate, parseAmountInput } from "@/lib/pay/amount";
import { buildCreateBill, referenceBytes } from "@/lib/pay/build";
import { ADAG_BILLS, BILL_STATUS, CURRENCIES, EXPLORER, MAX_REFERENCE_BYTES, type Currency } from "@/lib/pay/constants";
import { formatDate, formatUnitsExact, referenceText, shortAddress } from "@/lib/pay/format";
import { billCreatedIn } from "@/lib/pay/receipt";
import { feesNow, publicArc, simulateAndSend, type TxStep } from "@/lib/wallet/send";
import { readyToSign, useWallet } from "@/lib/wallet/useWallet";
import { ConnectButton } from "./ConnectButton";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";
import { feeText } from "./fee";

const DEFAULT_DUE_DAYS = 14;

type Written = { id: bigint; hash: Hex };

export function WriteBill() {
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
  const [copied, setCopied] = useState(false);

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
  const dueError = noDue ? null : !dueDate ? "Choose a due date, or No due date." : today && dueDate < today ? "The due date is in the past." : null;

  // The builder is the validator: whatever it refuses, the form refuses, in its words (C8 as a courtesy).
  const built = useMemo(() => {
    if (!amount.ok) return { ok: false as const, message: amount.message };
    if (due === null) return { ok: false as const, message: dueError ?? "Choose a due date." };
    try {
      return { ok: true as const, call: buildCreateBill(currency, amount.value, due, refText) };
    } catch (error) {
      return { ok: false as const, message: (error as Error).message };
    }
  }, [amount, due, dueError, currency, refText]);

  const feeQuery = useQuery({
    queryKey: ["adag-create-fee", address, built.ok ? built.call.data : null],
    enabled: ready && built.ok && !written,
    staleTime: 30_000,
    retry: false,
    queryFn: async () => {
      if (!built.ok || !address) throw new Error("not ready");
      const [gas, fees] = await Promise.all([publicArc().estimateGas({ account: address, to: built.call.to, data: built.call.data }), feesNow()]);
      return gas * fees.expected;
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
      setTx({ kind: "failed", message: "Arc confirmed the transaction, but the bill it wrote does not read back as expected. Check the transaction.", href: `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    setWritten({ id, hash: out.hash });
    setTx({ kind: "idle" });
  };

  const shareLink = written ? `${typeof window === "undefined" ? "" : window.location.origin}/bill/${written.id}` : "";
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(shareLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };

  const showErrors = touched || amountText !== "";
  const locked = Boolean(busy) || Boolean(written);

  return (
    <section className="relative px-5 pt-12 pb-24 md:px-[6vw] md:pt-[10vh]">
      <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
        <Hallmark>Write a bill · Arc mainnet</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[12ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
        Write a <em className="font-semibold text-gold italic">bill</em>.
      </h1>
      <p className="type-lead app-rise mt-6 max-w-[40rem] text-text/88" style={{ "--d": 2 } as React.CSSProperties}>
        One signature puts it on Arc, payable to you, exactly once. Send the link to whoever owes it.
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
              <p className="type-label text-muted">Currency</p>
              <div role="radiogroup" aria-label="Currency" className="mt-3 inline-flex gap-1 rounded-[8px] border border-rule p-1">
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
                Amount
              </label>
              <div className="mt-2 flex items-end gap-3">
                <input
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
                  {amount.message}
                </p>
              )}
            </div>

            <div>
              <label htmlFor={ids.due} className="type-label text-muted">
                Due date
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
                  No due date
                </label>
              </div>
              <p className="type-body mt-2 text-muted">Shown to the payer, never enforced.</p>
              {dueError && <p className="type-body mt-1 text-danger">{dueError}</p>}
            </div>

            <div>
              <div className="flex items-baseline justify-between gap-4">
                <label htmlFor={ids.ref} className="type-label text-muted">
                  Reference
                </label>
                <span className={`type-micro tabular-nums ${refLength > MAX_REFERENCE_BYTES ? "text-danger" : "text-muted"}`} data-field="ref-bytes">
                  {refLength} / {MAX_REFERENCE_BYTES} bytes
                </span>
              </div>
              <textarea
                id={ids.ref}
                rows={3}
                value={refText}
                onChange={(e) => setRefText(e.target.value)}
                aria-describedby={ids.refNote}
                placeholder="Invoice 1042, September hosting"
                className="type-body mt-3 w-full resize-y rounded-[8px] border border-rule-strong bg-transparent p-4 text-text transition-colors duration-200 placeholder:text-muted/70 hover:border-gold focus:border-gold focus:outline-none"
                data-field="ref"
              />
              <p id={ids.refNote} className="type-body mt-2 text-muted">
                Public on Arc: anyone can read it, forever. Accented letters and symbols take more than one byte.
              </p>
              {refLength > MAX_REFERENCE_BYTES && (
                <p className="type-body mt-1 text-danger" data-error="ref">
                  The reference is {refLength} bytes; the limit is {MAX_REFERENCE_BYTES}. Shorten it.
                </p>
              )}
            </div>
          </fieldset>

          <div className="mt-10 border-t border-rule pt-8">
            {!written &&
              (ready ? (
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:gap-6">
                  <Button type="submit" variant="primary" disabled={!built.ok || Boolean(busy)} className="w-full md:w-auto" data-action="write-bill">
                    {busy ? <BusyLabel step={busy.step} since={busy.since} /> : "Write the bill"}
                  </Button>
                  <p className="type-body text-muted">
                    Network fee{" "}
                    {feeQuery.isSuccess ? feeText(feeQuery.data) : feeQuery.isError ? "unavailable" : built.ok ? "being estimated" : "shown once the bill is valid"}
                  </p>
                </div>
              ) : (
                <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between" data-blocked="true">
                  <p className="type-body max-w-[26rem] text-text">
                    {wallet.status !== "connected"
                      ? "Connect the wallet the bill should pay. Nothing is built until then."
                      : !wallet.onArc
                        ? "Your wallet is on another network. Switch it to Arc to write the bill."
                        : "This wallet cannot sign here yet. See the note under the menu bar."}
                  </p>
                  <ConnectButton />
                </div>
              ))}
            {showErrors && !built.ok && amount.ok && refLength <= MAX_REFERENCE_BYTES && !dueError && (
              <p className="type-body mt-3 text-danger">{built.message}</p>
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
                  transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
                  className="app-panel p-6 md:p-8"
                >
                  <p className="type-label text-success">Written on Arc</p>
                  <p className="type-h3 mt-3 text-text">Bill #{written.id.toString()} is ready to share.</p>
                  <p className="type-address mt-5 break-all rounded-[6px] border border-rule bg-bg/40 p-3 text-text" data-share-link>
                    {shareLink}
                  </p>
                  <div className="mt-5 flex flex-col gap-3 md:flex-row">
                    <Button variant="primary" onClick={() => void copy()} className="w-full md:w-auto">
                      {copied ? "Copied" : "Copy link"}
                    </Button>
                    <Button href={`/bill/${written.id}`} variant="secondary" className="w-full md:w-auto">
                      Open the bill page
                    </Button>
                  </div>
                  <a href={`${EXPLORER}/tx/${written.hash}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address mt-5 inline-block text-muted hover:text-gold">
                    Transaction {shortAddress(written.hash)} on the explorer
                  </a>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        </form>

        <div className="app-rise md:col-span-6" style={{ "--d": 4 } as React.CSSProperties}>
          <div className="md:sticky md:top-28">
            <p className="type-label text-muted">What the payer will see</p>
            <Preview
              currency={currency}
              amount={amount.ok ? amount.value : null}
              due={due}
              refBytes={refLength <= MAX_REFERENCE_BYTES ? refBytes : null}
              payee={address}
              written={written}
            />
          </div>
        </div>
      </div>
    </section>
  );
}

type PreviewProps = { currency: Currency; amount: bigint | null; due: bigint | null; refBytes: Hex | null; payee: string | null; written: Written | null };

// Rendered from the same integer and the same bytes the transaction carries (C15), and the reference as text only (C14).
function Preview({ currency, amount, due, refBytes, payee, written }: PreviewProps) {
  const reference = refBytes ? referenceText(refBytes) : null;
  return (
    <div className="app-panel relative mt-4 overflow-hidden p-6 md:p-9" data-preview>
      <div className="flex items-start justify-between gap-4">
        <div className="min-h-[5.5rem]">
          <p className="type-micro text-muted">Bill No.</p>
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
                No. {written.id.toString()}
              </motion.p>
            ) : (
              <motion.p key="pending" className="mt-1 font-display text-[clamp(3.5rem,7vw,6rem)] leading-[0.9] text-rule-strong" exit={{ opacity: 0 }}>
                No. ?
              </motion.p>
            )}
          </AnimatePresence>
        </div>
        <div className="app-stamp pt-2">
          {written ? (
            <BillStamp status="open" entrance="in-view" tilt={-7} />
          ) : (
            <span className="type-micro inline-block -rotate-6 rounded-[3px] border-2 border-dashed border-rule-strong px-4 py-3 text-muted">Draft</span>
          )}
        </div>
      </div>

      <p className="mt-8 font-display text-[clamp(2.75rem,6vw,4.75rem)] leading-[0.9] font-semibold tracking-[-0.03em] tabular-nums text-text">
        {amount !== null ? formatUnitsExact(amount, currency.decimals) : "0.00"}
        <span className="app-amount-unit">{currency.symbol}</span>
      </p>

      <dl className="app-ledger mt-8 border-y border-rule">
        <div className="app-ledger-row">
          <dt className="type-micro text-muted">Pays</dt>
          <dd className="type-address min-w-0 break-all text-text">{payee ?? "Your connected wallet"}</dd>
        </div>
        <div className="app-ledger-row">
          <dt className="type-micro text-muted">Due</dt>
          <dd className="type-body text-text">{due === null ? "Choose a date" : due === 0n ? "No due date" : formatDate(due)}</dd>
        </div>
        <div className="app-ledger-row">
          <dt className="type-micro text-muted">Reference</dt>
          <dd className="type-body min-w-0 text-text">
            {reference === null ? <span className="text-danger">Too long</span> : reference ? <span className="app-reference">{reference}</span> : <span className="text-muted">None</span>}
          </dd>
        </div>
      </dl>
    </div>
  );
}
