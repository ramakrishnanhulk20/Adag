"use client";

import { AnimatePresence, motion } from "motion/react";
import { parseAbi } from "viem";
import { arc } from "viem/chains";
import { useReadContract } from "wagmi";
import { networkName } from "@/lib/wallet/networks";
import { useWallet } from "@/lib/wallet/useWallet";

export const SMART_ACCOUNT_SENTENCE =
  "Adag needs an ordinary wallet such as MetaMask or Rabby. Smart-account wallets cannot use Arc's one-signature batching.";

const safeThresholdAbi = parseAbi(["function getThreshold() view returns (uint256)"]);

// The strip under the nav that says, once and plainly, when this wallet cannot pay here.
export function WalletNotice() {
  const wallet = useWallet();
  // A Safe connected as the wallet itself (Safe's mobile app over WalletConnect does this) cannot sign Adag's batch;
  // it pays through its owners instead, so it gets that route rather than the general smart-account sentence.
  const isSafe = useReadContract({
    chainId: arc.id,
    address: wallet.status === "connected" ? wallet.address : undefined,
    abi: safeThresholdAbi,
    functionName: "getThreshold",
    query: { enabled: wallet.status === "connected" && wallet.kind === "smart", retry: false, staleTime: 60_000 },
  });
  let message: { tone: "danger" | "pending"; text: string } | null = null;
  if (wallet.status === "connected") {
    if (!wallet.onArc)
      message = {
        tone: "pending",
        text: `Your wallet is on ${networkName(wallet.chainId)}. Adag works on Arc mainnet only: Switch to Arc adds Arc to your wallet if it is not there yet.`,
      };
    else if (wallet.kind === "smart" && isSafe.isSuccess)
      message = {
        tone: "pending",
        text: "This is a Safe. Adag pays from a Safe through its owners: connect an owner's own wallet, then choose Pay as: a Safe on the bill.",
      };
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
