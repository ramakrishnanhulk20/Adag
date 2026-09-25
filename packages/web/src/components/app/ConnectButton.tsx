"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { EIP1193Provider } from "viem";
import { useConnect, useConnection, useConnectors, useDisconnect, type Connector } from "wagmi";
import { Button } from "@/components/Button";
import { switchToArc } from "@/lib/wallet/switchToArc";
import { useWallet } from "@/lib/wallet/useWallet";
import { shortAddress } from "@/lib/pay/format";

function firstLine(error: unknown) {
  const e = error as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage || e?.message || "The wallet did not answer.").split("\n")[0]!.slice(0, 120);
}

// The generic "Injected" entry duplicates whichever wallet announced itself by name, so it only shows alone.
function visibleConnectors(all: readonly Connector[]) {
  const named = all.filter((c) => c.id !== "injected");
  return named.length ? named : all;
}

const pop = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

export function ConnectButton() {
  const wallet = useWallet();
  const { connector } = useConnection();
  const connectors = useConnectors();
  const connect = useConnect();
  const { mutate: disconnect } = useDisconnect();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuId = useId();
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => root.current && !root.current.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => {
    if (!note) return;
    const t = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(t);
  }, [note]);

  const choices = visibleConnectors(connectors);

  const connectWith = (c: Connector) => {
    setOpen(false);
    setNote(null);
    connect.mutate(
      { connector: c },
      { onError: (error) => setNote(/reject|denied|cancel/i.test(firstLine(error)) ? "You closed the wallet request. Nothing was connected." : firstLine(error)) },
    );
  };

  const onConnectClick = () => {
    if (typeof window !== "undefined" && !("ethereum" in window) && choices.every((c) => c.type === "injected")) {
      setNote("No browser wallet found. Install MetaMask or Rabby, then reload this page.");
      return;
    }
    if (choices.length === 1) connectWith(choices[0]!);
    else setOpen((o) => !o);
  };

  const onSwitch = async () => {
    if (!connector) return;
    setSwitching(true);
    setNote(null);
    try {
      const provider = (await connector.getProvider()) as EIP1193Provider;
      await switchToArc(provider);
    } catch (error) {
      setNote(/reject|denied|cancel/i.test(firstLine(error)) ? "You declined the switch. Adag only works on Arc." : firstLine(error));
    } finally {
      setSwitching(false);
    }
  };

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1400);
    } catch {
      setCopied(false);
    }
  };

  let trigger: React.ReactNode;
  if (wallet.status === "connected" && !wallet.onArc) {
    trigger = (
      <Button variant="primary" size="sm" onClick={onSwitch} disabled={switching} aria-live="polite">
        {switching ? "Check your wallet" : "Switch to Arc"}
      </Button>
    );
  } else if (wallet.status === "connected") {
    trigger = (
      <button
        type="button"
        aria-expanded={open}
        aria-controls={menuId}
        onClick={() => setOpen((o) => !o)}
        className="group inline-flex h-10 items-center gap-2.5 rounded-[8px] border border-rule-strong px-3.5 text-text transition-colors duration-200 hover:border-gold"
      >
        <span aria-hidden="true" className={`diamond ${wallet.kind === "smart" ? "!bg-danger" : ""}`} />
        <span className="type-address text-[0.875rem] transition-colors duration-200 group-hover:text-gold">{shortAddress(wallet.address)}</span>
      </button>
    );
  } else {
    trigger = (
      <Button variant="secondary" size="sm" onClick={onConnectClick} disabled={wallet.status === "connecting" || connect.isPending} aria-expanded={choices.length > 1 ? open : undefined} aria-controls={choices.length > 1 ? menuId : undefined}>
        {wallet.status === "connecting" || connect.isPending ? "Check your wallet" : "Connect wallet"}
      </Button>
    );
  }

  return (
    <div ref={root} className="relative">
      {trigger}
      <AnimatePresence>
        {open && wallet.status === "connected" && (
          <motion.div key="account" id={menuId} {...pop} className="absolute right-0 top-full z-50 mt-2 w-[min(88vw,22rem)] rounded-[8px] border border-rule bg-raised p-4 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.5)]">
            <p className="type-micro text-muted">Connected on {wallet.onArc ? "Arc mainnet" : `chain ${wallet.chainId}`}</p>
            <p className="type-address mt-2 break-all text-text">{wallet.address}</p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => copy(wallet.address)} className="type-micro rounded-[6px] border border-rule-strong px-3 py-2 text-text transition-colors duration-200 hover:border-gold hover:text-gold">
                {copied ? "Copied" : "Copy address"}
              </button>
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  disconnect();
                }}
                className="type-micro rounded-[6px] border border-rule-strong px-3 py-2 text-text transition-colors duration-200 hover:border-danger hover:text-danger"
              >
                Disconnect
              </button>
            </div>
          </motion.div>
        )}
        {open && wallet.status !== "connected" && (
          <motion.ul key="choices" id={menuId} {...pop} className="absolute right-0 top-full z-50 mt-2 w-[min(88vw,16rem)] rounded-[8px] border border-rule bg-raised p-1.5 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.5)]">
            {choices.map((c) => (
              <li key={c.uid}>
                <button type="button" onClick={() => connectWith(c)} className="type-ui flex w-full items-center justify-between rounded-[6px] px-3 py-2.5 text-left text-text transition-colors duration-200 hover:bg-surface hover:text-gold">
                  {c.type === "walletConnect" ? "WalletConnect" : c.name === "Injected" ? "Browser wallet" : c.name}
                  <span aria-hidden="true" className="diamond opacity-60" />
                </button>
              </li>
            ))}
          </motion.ul>
        )}
        {note && (
          <motion.p key="note" role="status" {...pop} className="type-body absolute right-0 top-full z-40 mt-2 w-[min(88vw,20rem)] rounded-[8px] border border-rule bg-raised px-3.5 py-3 text-text">
            {note}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
