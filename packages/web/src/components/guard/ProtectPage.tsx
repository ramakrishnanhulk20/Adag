"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { ConnectButton } from "@/components/app/ConnectButton";
import { useBlockedReason } from "@/components/app/WalletNotice";
import { readyToSign, useWallet } from "@/lib/wallet/useWallet";
import { AlertsPanel } from "./AlertsPanel";
import { GuardList } from "./GuardList";

export function ProtectPage() {
  const t = useTranslations("protect");
  const tc = useTranslations("common");
  const blockedReason = useBlockedReason();
  const wallet = useWallet();
  return (
    <div className="px-5 pt-12 pb-24 md:px-[6vw] md:pt-[9vh]">
      <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
        <Hallmark>{t("hallmark")}</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[14ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
        {t.rich("title", { em: (chunks) => <em className="font-semibold text-gold italic">{chunks}</em> })}
      </h1>
      <p className="type-lead app-rise mt-8 max-w-[40rem] text-text/88" style={{ "--d": 2 } as React.CSSProperties}>
        {t("lead")}
      </p>
      <div className="app-rise mt-8" style={{ "--d": 3 } as React.CSSProperties}>
        <Button href="/app" variant="secondary" size="sm">
          {tc("yourWallet")}
        </Button>
      </div>

      <div className="app-rise mt-14" style={{ "--d": 4 } as React.CSSProperties}>
        {wallet.status === "connected" ? (
          <div className="flex flex-col gap-8">
            <GuardList address={wallet.address} canSign={readyToSign(wallet)} />
            <AlertsPanel address={wallet.address} canSign={readyToSign(wallet)} blockedReason={blockedReason(wallet, "sign")} />
          </div>
        ) : (
          <div className="app-panel p-6 md:p-8">
            <p className="type-body text-text">{t("connectForAlerts")}</p>
            <div className="mt-5">
              <ConnectButton />
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
