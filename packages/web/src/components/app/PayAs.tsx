"use client";

import { useEffect, useRef, useState } from "react";
import type { Address } from "viem";
import { recallProposal } from "./safeMemory";
import { useSafeList } from "./safeList";

export type PayAsMode = "wallet" | "safe";

// F3: who pays. Opens on "a Safe" when Safe's service lists one for this owner, or when this browser already
// proposed these bills to a Safe; otherwise on "this wallet". Once the payer chooses, their choice stands.
export function usePayAsMode(owner: Address | null, contract: string, ids: readonly bigint[]) {
  const [mode, setMode] = useState<PayAsMode>("wallet");
  const chosen = useRef(false);
  const list = useSafeList(owner);
  const idsKey = ids.join(",");
  useEffect(() => {
    if (chosen.current) return;
    if (recallProposal(contract, ids)) setMode("safe");
    // ids is read through idsKey.
  }, [contract, idsKey]);
  useEffect(() => {
    if (chosen.current) return;
    if (list.data && list.data.length > 0) setMode("safe");
  }, [list.data]);
  const choose = (m: PayAsMode) => {
    chosen.current = true;
    setMode(m);
  };
  return { mode, choose };
}

export function PayAsSwitch({ mode, onChoose, className = "" }: { mode: PayAsMode; onChoose: (m: PayAsMode) => void; className?: string }) {
  const option = (m: PayAsMode, label: string, extra: Record<string, string>) => (
    <button
      type="button"
      role="radio"
      aria-checked={mode === m}
      onClick={() => onChoose(m)}
      className={`type-ui rounded-[6px] px-4 py-2 transition-colors duration-200 ${mode === m ? "bg-raised text-gold" : "text-muted hover:text-text"}`}
      data-pay-as={m}
      {...extra}
    >
      {label}
    </button>
  );
  return (
    <div className={`flex flex-wrap items-center gap-3 ${className}`} data-pay-as-switch={mode}>
      <span className="type-label text-muted">Pay as</span>
      <div role="radiogroup" aria-label="Pay as" className="inline-flex rounded-[8px] border border-rule p-1">
        {option("wallet", "This wallet", {})}
        {option("safe", "A Safe", { "data-action": "safe-open" })}
      </div>
    </div>
  );
}

// F11: a Safe cannot pay bills on the first contract. Name them, say what to do, and give the payer a line to send.
export function FirstContractSafeNote({ ids, className = "" }: { ids: readonly bigint[]; className?: string }) {
  const [copied, setCopied] = useState(false);
  const which = ids.length === 1 ? `Bill #${ids[0]} was` : `Bills #${ids.join(", #")} were`;
  const message = `Hello, could you write ${ids.length === 1 ? `bill #${ids[0]}` : `bills #${ids.join(", #")}`} again on Adag? ${ids.length === 1 ? "It is" : "They are"} on Adag's older contract, and our company Safe can only pay bills on the current one.`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(message);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      setCopied(false);
    }
  };
  return (
    <div className={`rounded-[8px] border border-rule p-4 ${className}`} data-safe-unavailable>
      <p className="type-body text-text">
        {which} written on Adag&apos;s older contract, which a Safe cannot pay. Pay {ids.length === 1 ? "it" : "them"} from a wallet, or ask the supplier to write{" "}
        {ids.length === 1 ? "it" : "them"} again.
      </p>
      <p className="type-micro mt-3 normal-case tracking-[0.04em] text-muted">{message}</p>
      <button
        type="button"
        onClick={() => void copy()}
        className="type-micro mt-3 rounded-[6px] border border-rule px-2.5 py-1.5 text-muted transition-colors duration-200 hover:border-gold hover:text-gold"
        data-action="copy-supplier-message"
      >
        {copied ? "Copied" : "Copy the message to the supplier"}
      </button>
    </div>
  );
}
