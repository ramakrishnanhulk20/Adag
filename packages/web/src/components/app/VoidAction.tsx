"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import type { Address, Hex } from "viem";
import { Button } from "@/components/Button";
import { adagAbi } from "@/lib/pay/abi";
import { buildVoid, type Bill } from "@/lib/pay/build";
import { ADAG_BILLS, BILL_STATUS, EXPLORER } from "@/lib/pay/constants";
import { billVoidedIn } from "@/lib/pay/receipt";
import { publicArc, simulateAndSend, type TxStep } from "@/lib/wallet/send";
import { SuccessCard } from "./SuccessCard";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";

export function VoidAction({ bill, address, canSign, blockedReason }: { bill: Bill; address: Address; canSign: boolean; blockedReason: string | null }) {
  const router = useRouter();
  const [confirming, setConfirming] = useState(false);
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [done, setDone] = useState<Hex | null>(null);
  const open = bill.status === BILL_STATUS.Open;
  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));

  const voidIt = async () => {
    const call = buildVoid(bill.id);
    const out = await simulateAndSend({ account: address, to: call.to, data: call.data, onStep: step, usdcOut: 0n });
    if (!out.ok) {
      setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    const record = await publicArc()
      .readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "bill", args: [bill.id] })
      .catch(() => null);
    if (!record || record.status !== BILL_STATUS.Void || !billVoidedIn(out.receipt.logs, bill.id)) {
      setTx({ kind: "failed", message: "Arc confirmed the transaction, but the bill does not read as cancelled yet. Reload to check.", href: `${EXPLORER}/tx/${out.hash}` });
      return;
    }
    setDone(out.hash);
    setTx({ kind: "idle" });
    router.refresh();
  };

  if (done) {
    return <SuccessCard status="void" hash={done} title={`Bill #${bill.id} is cancelled.`} rows={[{ label: "What it means", value: "No one can pay it, ever." }]} />;
  }

  const busy = tx.kind === "busy" ? tx : null;
  return (
    <div className="app-panel h-full p-6 md:p-8">
      <p className="type-label text-gold">You wrote this bill</p>
      <p className="type-lead mt-4 text-text">
        {open ? "Share this page's link with whoever owes it. You can cancel it until someone pays." : "It is closed. Nothing more to do here."}
      </p>
      {open && (
        <div className="mt-8">
          {!canSign ? (
            <p className="type-body text-muted">{blockedReason}</p>
          ) : (
            <AnimatePresence mode="wait" initial={false}>
              {!confirming ? (
                <motion.div key="ask" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
                  <Button variant="secondary" onClick={() => setConfirming(true)} className="w-full md:w-auto" data-action="void">
                    Void this bill
                  </Button>
                </motion.div>
              ) : (
                <motion.div key="confirm" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} className="rounded-[8px] border border-danger/60 p-5">
                  <p className="type-body text-text">Cancel bill #{bill.id.toString()} for good? No one can pay it after this, and it cannot be undone.</p>
                  <div className="mt-5 flex flex-col gap-3 md:flex-row">
                    <Button variant="primary" disabled={!!busy} onClick={() => void voidIt()} className="w-full md:w-auto" data-action="void-confirm">
                      {busy ? <BusyLabel step={busy.step} since={busy.since} /> : "Yes, void it"}
                    </Button>
                    <Button variant="secondary" disabled={!!busy} onClick={() => setConfirming(false)} className="w-full md:w-auto">
                      Keep it open
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
