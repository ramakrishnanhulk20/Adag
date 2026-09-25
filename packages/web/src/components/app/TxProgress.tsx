"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { PlainError } from "@/lib/pay/errors";
import type { TxStep } from "@/lib/wallet/send";

export type TxState =
  | { kind: "idle" }
  | { kind: "busy"; step: TxStep; since: number }
  | { kind: "refused"; error: PlainError }
  | { kind: "failed"; message: string; href?: string };

const LABEL: Record<TxStep, string> = {
  checking: "Checking with Arc",
  signing: "Confirm in your wallet",
  confirming: "Waiting for Arc to confirm",
  rereading: "Reading the bill again",
};

export function useElapsed(since: number | null) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

// Any wait past two seconds shows its honest label and a running count, never a bare spinner.
export function stepLabel(step: TxStep, seconds: number) {
  return seconds >= 2 ? `${LABEL[step]} · ${seconds}s` : LABEL[step];
}

export function BusyLabel({ step, since }: { step: TxStep; since: number }) {
  const seconds = useElapsed(since);
  return <>{stepLabel(step, seconds)}</>;
}

export function TxMessage({ state }: { state: TxState }) {
  const busy = state.kind === "busy" ? state : null;
  const seconds = useElapsed(busy ? busy.since : null);
  let content: React.ReactNode = null;
  if (busy) {
    content = (
      <p className="type-body flex items-center gap-3 text-text" data-tx-state={busy.step}>
        <span aria-hidden="true" className="live-shimmer inline-block h-[2px] w-10" />
        {stepLabel(busy.step, seconds)}
        {busy.step === "signing" && <span className="text-muted">Nothing is sent until you approve it.</span>}
      </p>
    );
  } else if (state.kind === "refused") {
    content = (
      <div data-tx-state="refused">
        <p className="type-body text-danger">{state.error.message}</p>
        <p className="type-body mt-1 text-text">
          {state.error.next} <span className="text-muted">Arc refused it in a dry run, so nothing was sent to your wallet.</span>
        </p>
      </div>
    );
  } else if (state.kind === "failed") {
    content = (
      <p className="type-body text-danger" data-tx-state="failed">
        {state.message}{" "}
        {state.href && (
          <a href={state.href} target="_blank" rel="noopener noreferrer" className="link-draw text-text hover:text-gold">
            View the transaction
          </a>
        )}
      </p>
    );
  }
  return (
    <div role="status" aria-live="polite" className="min-h-[1.6rem]">
      <AnimatePresence mode="wait">
        {content && (
          <motion.div
            key={state.kind + (busy?.step ?? "")}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -4 }}
            transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
          >
            {content}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
