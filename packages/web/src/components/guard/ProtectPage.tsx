"use client";

import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { ConnectButton } from "@/components/app/ConnectButton";
import { SMART_ACCOUNT_SENTENCE } from "@/components/app/WalletNotice";
import { readyToSign, useWallet, type WalletState } from "@/lib/wallet/useWallet";
import { AlertsPanel } from "./AlertsPanel";
import { GuardList } from "./GuardList";

function blockedReason(wallet: WalletState): string | null {
  if (readyToSign(wallet)) return null;
  if (wallet.status !== "connected") return "Connect a wallet to continue.";
  if (!wallet.onArc) return "Your wallet is on another network. Switch it to Arc; nothing is signed until then.";
  if (wallet.kind === "smart") return SMART_ACCOUNT_SENTENCE;
  return "Checking your wallet on Arc.";
}

export function ProtectPage() {
  const wallet = useWallet();
  return (
    <div className="px-5 pt-12 pb-24 md:px-[6vw] md:pt-[9vh]">
      <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
        <Hallmark>Loan guard · alerts</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[14ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
        Know before <em className="font-semibold text-gold italic">Morpho</em> does.
      </h1>
      <p className="type-lead app-rise mt-8 max-w-[40rem] text-text/88" style={{ "--d": 2 } as React.CSSProperties}>
        The loan guard repays part of a loan from your own USDC or EURC when it crosses a line you choose. Alerts tell you on Telegram when a loan gets close, and each
        time the guard acts. You set the guard on each loan in your wallet.
      </p>
      <div className="app-rise mt-8" style={{ "--d": 3 } as React.CSSProperties}>
        <Button href="/app" variant="secondary" size="sm">
          Your wallet
        </Button>
      </div>

      <div className="app-rise mt-14" style={{ "--d": 4 } as React.CSSProperties}>
        {wallet.status === "connected" ? (
          <div className="flex flex-col gap-8">
            <GuardList address={wallet.address} canSign={readyToSign(wallet)} />
            <AlertsPanel address={wallet.address} canSign={readyToSign(wallet)} blockedReason={blockedReason(wallet)} />
          </div>
        ) : (
          <div className="app-panel p-6 md:p-8">
            <p className="type-body text-text">Connect the wallet whose loans you want alerts for.</p>
            <div className="mt-5">
              <ConnectButton />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
