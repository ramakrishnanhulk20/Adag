"use client";

import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { parseAbi } from "viem";
import { arc } from "viem/chains";
import { useReadContract } from "wagmi";
import { useNetworkName } from "@/lib/wallet/networks";
import { useWallet, type WalletState } from "@/lib/wallet/useWallet";

const safeThresholdAbi = parseAbi(["function getThreshold() view returns (uint256)"]);

// Why this wallet cannot sign right now, in words, or null when it can (C4 and the plain-wallet rule). `action` is
// what the screen was about to do: "continue", "pay", "changeLoan" or "sign", which only changes the network sentence.
export function useBlockedReason() {
  const t = useTranslations("walletState");
  return (wallet: WalletState, action: "continue" | "pay" | "changeLoan" | "sign" | "writeBill"): string | null => {
    if (wallet.status === "connected" && wallet.onArc && (wallet.kind === "plain" || wallet.kind === "delegated")) return null;
    if (action === "writeBill") return wallet.status !== "connected" ? t("connectToReceive") : !wallet.onArc ? t("otherNetwork.writeBill") : t("cannotSignYet");
    if (wallet.status !== "connected") return t("connectToContinue");
    if (!wallet.onArc) return t(`otherNetwork.${action}`);
    if (wallet.kind === "smart") return t("smartAccount");
    // The alerts page has always said "checking" here; the wallet pages name the failed read.
    if (wallet.kind === "unavailable" && action !== "sign") return t("kindUnavailable");
    return t("checkingWallet");
  };
}

// The strip under the nav that says, once and plainly, when this wallet cannot pay here.
export function WalletNotice() {
  const t = useTranslations("walletState");
  const wallet = useWallet();
  const networkName = useNetworkName();
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
    if (!wallet.onArc) message = { tone: "pending", text: t("notice.otherNetwork", { network: networkName(wallet.chainId) }) };
    else if (wallet.kind === "smart" && isSafe.isSuccess) message = { tone: "pending", text: t("notice.safe") };
    else if (wallet.kind === "smart") message = { tone: "danger", text: t("smartAccount") };
    else if (wallet.kind === "delegated") message = { tone: "pending", text: t("notice.delegated") };
    else if (wallet.kind === "unavailable") message = { tone: "pending", text: t("notice.kindUnavailable") };
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
