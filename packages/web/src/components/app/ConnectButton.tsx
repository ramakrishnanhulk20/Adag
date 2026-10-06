"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { EIP1193Provider } from "viem";
import { useConnect, useConnection, useConnectors, useDisconnect } from "wagmi";
import { Button } from "@/components/Button";
import { appKit } from "@/lib/wallet/appkit";
import { projectId } from "@/lib/wallet/config";
import { switchToArc } from "@/lib/wallet/switchToArc";
import { useWallet } from "@/lib/wallet/useWallet";
import { shortAddress } from "@/lib/pay/format";
import { networkName } from "@/lib/wallet/networks";

function firstLine(error: unknown) {
  const e = error as { shortMessage?: string; message?: string } | undefined;
  return (e?.shortMessage || e?.message || "The wallet did not answer.").split("\n")[0]!.slice(0, 120);
}

const pop = {
  initial: { opacity: 0, y: -6 },
  animate: { opacity: 1, y: 0 },
  exit: { opacity: 0, y: -6 },
  transition: { duration: 0.22, ease: [0.16, 1, 0.3, 1] as const },
};

type ModalView = "Connect" | "Account";

type Props = {
  // Runs just before the wallet modal opens. The phone menu uses it to close itself, so the modal never opens on top of it.
  beforeOpen?: () => void;
};

// With a Reown project id the wallet modal does the connecting. Without one there is no modal, and the button talks to
// the browser's own wallet directly. The id is fixed when the app is built, so server and browser always agree. The
// modal is only created in the browser (lib/wallet/appkit.ts), which is why this calls the instance and not a hook.
const openModal = projectId ? (view: ModalView) => void appKit?.open({ view }) : null;

export function ConnectButton({ beforeOpen }: Props) {
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

  const showModal = (view: ModalView) => {
    setNote(null);
    beforeOpen?.();
    openModal?.(view);
  };

  // No project id: the one injected connector, as before. A browser with no wallet at all gets told where to find one.
  const connectInjected = () => {
    const injected = connectors.find((c) => c.type === "injected");
    if (!injected || (typeof window !== "undefined" && !("ethereum" in window))) {
      setNote("No wallet found in this browser. Open Adag in the browser inside MetaMask or Rabby, or add one to this browser.");
      return;
    }
    setNote(null);
    connect.mutate(
      { connector: injected },
      { onError: (error) => setNote(/reject|denied|cancel/i.test(firstLine(error)) ? "You closed the wallet request. Nothing was connected." : firstLine(error)) },
    );
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

  const connecting = wallet.status === "connecting" || connect.isPending;

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
        data-wallet-pill
        aria-haspopup={openModal ? "dialog" : undefined}
        aria-expanded={openModal ? undefined : open}
        aria-controls={openModal ? undefined : menuId}
        onClick={() => (openModal ? showModal("Account") : setOpen((o) => !o))}
        className="group inline-flex h-10 items-center gap-2.5 rounded-[8px] border border-rule-strong px-3.5 text-text transition-colors duration-200 hover:border-gold"
      >
        <span aria-hidden="true" className={`diamond ${wallet.kind === "smart" ? "!bg-danger" : ""}`} />
        <span className="type-address text-[0.875rem] transition-colors duration-200 group-hover:text-gold">{shortAddress(wallet.address)}</span>
      </button>
    );
  } else {
    trigger = (
      <Button variant="secondary" size="sm" onClick={() => (openModal ? showModal("Connect") : connectInjected())} disabled={connecting} aria-haspopup={openModal ? "dialog" : undefined}>
        {connecting ? "Check your wallet" : "Connect wallet"}
      </Button>
    );
  }

  return (
    <div ref={root} className="relative">
      {trigger}
      <AnimatePresence>
        {!openModal && open && wallet.status === "connected" && (
          <motion.div key="account" id={menuId} {...pop} className="absolute right-0 top-full z-50 mt-2 w-[min(88vw,22rem)] rounded-[8px] border border-rule bg-raised p-4 shadow-[0_24px_60px_-20px_rgb(0_0_0/0.5)]">
            <p className="type-micro text-muted">Connected on {wallet.onArc ? "Arc mainnet" : networkName(wallet.chainId)}</p>
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
        {note && (
          // Under 640px the only button is the one in the phone menu, so the note sits in the flow under it. From 640px
          // up it hangs from the button. It is never fixed: the nav and the rising panels would both trap a fixed box.
          <motion.p
            key="note"
            role="status"
            {...pop}
            className="type-body z-50 mt-3 rounded-[8px] border border-rule bg-raised px-3.5 py-3 text-text sm:absolute sm:right-0 sm:top-full sm:mt-2 sm:w-[20rem]"
          >
            {note}
          </motion.p>
        )}
      </AnimatePresence>
    </div>
  );
}
