"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { useQuery } from "@tanstack/react-query";
import type { Address, Hex } from "viem";
import { Button } from "@/components/Button";
import { adagAbi } from "@/lib/pay/abi";
import { buildVoid, type Bill } from "@/lib/pay/build";
import { billHref } from "@/lib/pay/billId";
import { BILL_STATUS, EXPLORER } from "@/lib/pay/constants";
import { formatUnitsExact } from "@/lib/pay/format";
import { currencyOf } from "@/lib/pay/market";
import { billVoidedIn } from "@/lib/pay/receipt";
import { estimateFee, publicArc, simulateAndSend, watchBills, type TxStep } from "@/lib/wallet/send";
import { FeeLine } from "./FeeLine";
import { ShareActions } from "./ShareActions";
import { SuccessCard } from "./SuccessCard";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";

export function VoidAction({ bill, address, canSign, blockedReason }: { bill: Bill; address: Address; canSign: boolean; blockedReason: string | null }) {
  const t = useTranslations("bill.void");
  const tc = useTranslations("common");
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [done, setDone] = useState<Hex | null>(null);
  const [link, setLink] = useState("");
  const open = bill.status === BILL_STATUS.Open;
  const id = bill.id.toString();
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));
  useEffect(() => setLink(`${window.location.origin}${billHref(bill.contract, bill.id)}`), [bill.contract, bill.id]);

  const fee = useQuery({
    queryKey: ["adag-fee", "void", bill.contract, bill.id.toString(), address],
    enabled: open && canSign && confirming && !done,
    staleTime: 30_000,
    retry: false,
    queryFn: () => {
      const call = buildVoid(bill);
      return estimateFee({ account: address, to: call.to, data: call.data });
    },
  });

  const voidIt = async () => {
    const call = buildVoid(bill);
    const out = await simulateAndSend({ account: address, to: call.to, data: call.data, onStep: step, usdcOut: 0n });
    if (!out.ok) {
      if (out.stage === "unconfirmed") {
        // No receipt in time: the bill's own status says whether the cancel happened.
        step("watching");
        if (await watchBills(bill.contract, [bill.id], BILL_STATUS.Void)) {
          setDone(out.hash);
          setTx({ kind: "idle" });
          router.refresh();
          return;
        }
        setTx({ kind: "failed", message: t("notConfirmed"), href: `${EXPLORER}/tx/${out.hash}` });
        return;
      }
      setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    const record = await publicArc()
      .readContract({ address: bill.contract, abi: adagAbi, functionName: "bill", args: [bill.id] })
      .catch(() => null);
    if (!record || record.status !== BILL_STATUS.Void || !billVoidedIn(out.receipt.logs, bill.contract, bill.id)) {
      setTx({ kind: "failed", message: t("notCancelledYet"), href: `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    setDone(out.hash);
    setTx({ kind: "idle" });
    router.refresh();
  };

  if (done) {
    return <SuccessCard status="void" hash={done} title={t("cancelledTitle", { id })} rows={[{ label: t("whatItMeans"), value: t("noOneCanPay") }]} />;
  }

  const c = currencyOf(bill.currency);
  const busy = tx.kind === "busy" ? tx : null;
  return (
    <div className="app-panel h-full p-6 md:p-8">
      <p className="type-label text-gold">{t("youWroteThis")}</p>
      <p className="type-lead mt-4 text-text">{open ? t("sendIt") : t("closed")}</p>
      {open && link && (
        <div className="mt-6" data-share-bill>
          <p className="type-micro text-muted">{t("shareThisBill")}</p>
          <p className="type-address mt-2 break-all rounded-[6px] border border-rule bg-bg/40 p-3 text-text">{link}</p>
          <ShareActions
            url={link}
            title={tc("billNumber", { id })}
            text={c ? tc("shareTextAmount", { id, amount: formatUnitsExact(bill.amount, c.decimals), symbol: c.symbol }) : tc("shareText", { id })}
            size="sm"
            className="mt-3"
          />
        </div>
      )}
      {open && (
        <div className="mt-8 border-t border-rule pt-6">
          {!canSign ? (
            <p className="type-body text-muted">{blockedReason}</p>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {!confirming ? (
                <motion.div key="ask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Button variant="secondary" onClick={() => setConfirming(true)} className="w-full md:w-auto" data-action="void">
                    {t("voidThisBill")}
                  </Button>
                </motion.div>
              ) : (
                <motion.div key="confirm" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-[8px] border border-danger/60 p-5">
                  <p className="type-body text-text">{t("confirm", { id })}</p>
                  <FeeLine query={fee} className="mt-3" />
                  <div className="mt-5 flex flex-col gap-3 md:flex-row">
                    <Button variant="primary" disabled={!!busy} onClick={() => void voidIt()} className="w-full md:w-auto" data-action="void-confirm">
                      {busy ? <BusyLabel step={busy.step} since={busy.since} /> : t("yesVoidIt")}
                    </Button>
                    <Button variant="secondary" disabled={!!busy} onClick={() => setConfirming(false)} className="w-full md:w-auto">
                      {t("keepItOpen")}
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          )}
          <div className="mt-4">
            <TxMessage state={tx} />
          </div>
        </div>
      )}
    </div>
  );
}
