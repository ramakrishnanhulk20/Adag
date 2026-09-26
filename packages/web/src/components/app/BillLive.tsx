"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { adagAbi } from "@/lib/pay/abi";
import { BILL_STATUS, requireDeployment } from "@/lib/pay/constants";
import { publicArc } from "@/lib/wallet/send";

const EVERY_MS = 6_000;

// While an open bill's page is visible, read bill(id) on the bill's own contract every six seconds. The moment someone
// pays or cancels it, the page re-renders from the server and the keyed stamp springs down, with nothing to reload.
export function BillLive({ contract, id, status }: { contract: string; id: string; status: number }) {
  const router = useRouter();

  useEffect(() => {
    if (status !== BILL_STATUS.Open) return;
    const { address } = requireDeployment(contract);
    let stopped = false;
    const billId = BigInt(id);
    const tick = async () => {
      if (stopped || document.visibilityState !== "visible") return;
      try {
        const b = await publicArc().readContract({ address, abi: adagAbi, functionName: "bill", args: [billId] });
        if (stopped || b.status === BILL_STATUS.Open) return;
        stopped = true;
        document.title = `${b.status === BILL_STATUS.Paid ? "Paid" : "Cancelled"} · Bill #${id} · Adag`;
        router.refresh();
      } catch {
        // A missed read is not an answer; the next tick tries again.
      }
    };
    const timer = window.setInterval(() => void tick(), EVERY_MS);
    const onVisible = () => document.visibilityState === "visible" && void tick();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stopped = true;
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [contract, id, status, router]);

  return null;
}
