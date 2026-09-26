"use client";

import { useState } from "react";
import type { EIP1193Provider } from "viem";
import { useConnection } from "wagmi";
import { switchToArc } from "@/lib/wallet/switchToArc";
import { useWallet } from "@/lib/wallet/useWallet";

export type SetupNeed = "cirbtc" | "usdc" | "arc";

// Official routes only, each opened and checked when it was added: Arc Portal's swap (it also moves funds across
// chains), Circle's App Kit Swap and Circle's CCTP. Adag never handles the swap or the transfer itself.
export const SETUP_LINKS = {
  portalSwap: "https://portal.arc.io/swap",
  appKitSwap: "https://docs.arc.io/app-kit/swap",
  cctp: "https://developers.circle.com/cctp",
} as const;

function Ext({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a href={href} target="_blank" rel="noopener noreferrer" className="link-draw text-gold transition-colors duration-200 hover:text-text">
      {children}
    </a>
  );
}

// Where a payer comes up short, one plain line per missing thing, so nobody meets a dead end.
export function GetSetUp({ needs, className = "" }: { needs: readonly SetupNeed[]; className?: string }) {
  const wallet = useWallet();
  const { connector } = useConnection();
  const [note, setNote] = useState<string | null>(null);
  if (needs.length === 0) return null;
  const wrongNetwork = wallet.status === "connected" && !wallet.onArc;

  const addArc = async () => {
    if (!connector) return;
    setNote(null);
    try {
      await switchToArc((await connector.getProvider()) as EIP1193Provider);
    } catch {
      setNote("Your wallet did not add Arc. Try again from the wallet's own network menu.");
    }
  };

  return (
    <div className={`rounded-[8px] border border-rule bg-bg/30 p-4 md:p-5 ${className}`} data-setup>
      <p className="type-label text-text">Need cirBTC or USDC on Arc?</p>
      <ul className="type-body mt-3 space-y-2 text-muted">
        {needs.includes("cirbtc") && (
          <li data-setup-need="cirbtc">
            <span className="text-text">Get cirBTC:</span> swap USDC for it on <Ext href={SETUP_LINKS.portalSwap}>Arc Portal</Ext>, or see{" "}
            <Ext href={SETUP_LINKS.appKitSwap}>Circle&apos;s App Kit Swap</Ext>.
          </li>
        )}
        {needs.includes("usdc") && (
          <li data-setup-need="usdc">
            <span className="text-text">Bring USDC from another chain:</span> <Ext href={SETUP_LINKS.portalSwap}>Arc Portal</Ext> moves it across
            chains, and <Ext href={SETUP_LINKS.cctp}>Circle&apos;s CCTP</Ext> is the native route. A little USDC also pays Arc&apos;s network fee.
          </li>
        )}
        {needs.includes("arc") && (
          <li data-setup-need="arc">
            <span className="text-text">Add Arc to your wallet:</span>{" "}
            {wrongNetwork ? (
              <button type="button" onClick={() => void addArc()} className="link-draw text-gold transition-colors duration-200 hover:text-text" data-action="add-arc">
                Switch to Arc
              </button>
            ) : (
              "Switch to Arc"
            )}{" "}
            adds it if your wallet does not have it yet.
          </li>
        )}
      </ul>
      {note && <p className="type-body mt-2 text-danger">{note}</p>}
    </div>
  );
}
