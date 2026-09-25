"use client";

import { AnimatePresence, motion } from "motion/react";
import { useWallet } from "@/lib/wallet/useWallet";

export const SMART_ACCOUNT_SENTENCE =
  "Adag needs an ordinary wallet such as MetaMask or Rabby. Smart-account wallets cannot use Arc's one-signature batching.";

// The strip under the nav that says, once and plainly, when this wallet cannot pay here.
export function WalletNotice() {
  const wallet = useWallet();
  let message: { tone: "danger" | "pending"; text: string } | null = null;
  if (wallet.status === "connected") {
    if (!wallet.onArc) message = { tone: "pending", text: `Your wallet is on chain ${wallet.chainId}. Adag only works on Arc mainnet: use Switch to Arc.` };
    else if (wallet.kind === "smart") message = { tone: "danger", text: SMART_ACCOUNT_SENTENCE };
    else if (wallet.kind === "delegated")
      message = {
        tone: "pending",
        text: "This wallet has an EIP-7702 delegation. Tested on a mainnet fork: it can pay here as long as it sends its own transaction.",
      };
    else if (wallet.kind === "unavailable") message = { tone: "pending", text: "Could not check this wallet's type on Arc right now. Reload to try again." };
  }

  return (
    <AnimatePresence initial={false}>
      {message && (
        <motion.div
          key={message.text}
          role="status"
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: "auto" }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ duration: 0.3, ease: [0.16, 1, 0.3, 1] }}
          className="overflow-hidden border-b border-rule bg-surface"
        >
          <p className={`type-body flex items-start gap-3 px-5 py-3 md:px-[6vw] ${message.tone === "danger" ? "text-danger" : "text-text"}`}>
            <span aria-hidden="true" className={`diamond mt-[0.55em] ${message.tone === "danger" ? "!bg-danger" : "!bg-pending"}`} />
            {message.text}
          </p>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
