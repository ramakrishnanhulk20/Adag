"use client";

import { useState } from "react";
import { motion } from "motion/react";
import { decodeEventLog, isAddressEqual, type Address, type Hex, type Log } from "viem";
import { Button } from "@/components/Button";
import { adagAbi, morphoAbi } from "@/lib/pay/abi";
import { buildEnrol } from "@/lib/pay/build";
import { EXPLORER, MARKET_EURC, MARKET_USDC, MORPHO, deploymentOf } from "@/lib/pay/constants";
import type { Blocker } from "@/lib/pay/enrol";
import { formatPercentWad } from "@/lib/pay/format";
import { publicArc, simulateAndSend, type TxStep } from "@/lib/wallet/send";
import { BusyLabel, TxMessage, type TxState } from "./TxProgress";

// C16 for enrol: the proof is the contract's own Enrolled for this wallet, and seenPosition read back afterwards
// equal to Morpho's position in both markets.
function enrolledIn(logs: readonly Log[], contract: Address, who: Address): boolean {
  return logs.some((log) => {
    if (log.removed || !isAddressEqual(log.address, contract)) return false;
    try {
      const ev = decodeEventLog({ abi: adagAbi, data: log.data, topics: log.topics, strict: true });
      return ev.eventName === "Enrolled" && isAddressEqual(ev.args.payer, who);
    } catch {
      return false;
    }
  });
}

const WAIT_BLOCK_MS = 90_000;

// The market the card talks about: the worst one first, so the sentence names the loan that matters.
const lead = (blockers: readonly Blocker[]) => [...blockers].sort((a, b) => (b.ltvWad > a.ltvWad ? 1 : -1))[0]!;

export function EnrolCard({
  contract,
  address,
  blockers,
  canSign,
  onRecorded,
  onBusy,
}: {
  contract: Address;
  address: Address;
  blockers: readonly Blocker[];
  canSign: boolean;
  onRecorded: () => void;
  onBusy?: (busy: boolean) => void;
}) {
  const [tx, setTx] = useState<TxState>({ kind: "idle" });
  const [waiting, setWaiting] = useState<Hex | null>(null);
  const first = deploymentOf(contract)?.label === "first";
  const top = lead(blockers);
  const staleOnly = blockers.every((b) => b.reason === "stale");

  if (first) {
    // The first deployment has no enrol, so there is nothing to sign here.
    return (
      <div className="app-panel border-danger/40 p-6 md:p-7" data-enrol="first">
        <p className="type-label text-danger">Your existing loan</p>
        <p className="type-body mt-3 text-text">
          {staleOnly
            ? "This bill is on Adag's first contract, which checks your whole Morpho loan the first time you pay there, and the bitcoin price is not fresh right now. Paying works once the price updates."
            : "This bill is on Adag's first contract, which counts your whole Morpho loan the first time you pay there, and your loan is above 40%. Ask the supplier to write it again; new bills use the current contract, where you can record your loan first."}
        </p>
      </div>
    );
  }

  const step = (s: TxStep) => setTx((prev) => ({ kind: "busy", step: s, since: prev.kind === "busy" && prev.step === s ? prev.since : Date.now() }));
  const busy = tx.kind === "busy" ? tx : null;

  const record = async () => {
    onBusy?.(true);
    try {
      let call;
      try {
        call = buildEnrol(contract);
      } catch (error) {
        setTx({ kind: "failed", message: (error as Error).message });
        return;
      }
      const out = await simulateAndSend({ account: address, to: call.to, data: call.data, onStep: step, usdcOut: 0n });
      if (!out.ok) {
        setTx(out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` });
        return;
      }
      const client = publicArc();
      const [seenU, seenE, liveU, liveE] = await Promise.all([
        client.readContract({ address: contract, abi: adagAbi, functionName: "seenPosition", args: [address, MARKET_USDC] }),
        client.readContract({ address: contract, abi: adagAbi, functionName: "seenPosition", args: [address, MARKET_EURC] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_USDC, address] }),
        client.readContract({ address: MORPHO, abi: morphoAbi, functionName: "position", args: [MARKET_EURC, address] }),
      ]).catch(() => [null, null, null, null] as const);
      const matches =
        seenU !== null && seenE !== null && liveU !== null && liveE !== null &&
        seenU[0] === liveU[1] && seenU[1] === liveU[2] && seenE[0] === liveE[1] && seenE[1] === liveE[2];
      if (!enrolledIn(out.receipt.logs, contract, address) || !matches) {
        setTx({ kind: "failed", message: "Arc confirmed the transaction, but Adag's record of your loan does not match Morpho's yet. Reload to check before paying.", href: `${EXPLORER}/tx/${out.hash}` });
        return;
      }
      // AdagBills refuses a payment in the same block as the recording, so the payment is only built from the next one.
      setTx({ kind: "idle" });
      setWaiting(out.hash);
      const until = Date.now() + WAIT_BLOCK_MS;
      while (Date.now() < until) {
        const head = await client.getBlockNumber().catch(() => null);
        if (head !== null && head > out.receipt.blockNumber) {
          setWaiting(null);
          onRecorded();
          return;
        }
        await new Promise((r) => setTimeout(r, 1_000));
      }
      setWaiting(null);
      setTx({ kind: "failed", message: "Your loan is recorded, but Arc has not produced the next block yet. Reload in a moment to pay." });
    } finally {
      onBusy?.(false);
    }
  };

  return (
    <motion.div initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }} className="app-panel p-6 md:p-7" data-enrol="current">
      <p className="type-label text-gold">Record your existing loan first</p>
      <p className="type-body mt-3 text-text">
        {staleOnly
          ? `You already borrow on Morpho, and the bitcoin price is not fresh right now, so Adag's check on your ${top.symbol} loan would refuse the payment. Adag checks the 40% line only on new borrowing, so record the loan you have first. One signature, no money moves. Then pay in the next step.`
          : `You already borrow on Morpho: your ${top.symbol} loan is at ${formatPercentWad(top.ltvWad)}. Adag checks the 40% line only on new borrowing, so record the loan you have first. One signature, no money moves. Then pay in the next step.`}
      </p>
      <p className="type-body mt-2 text-muted">Recording does not change your loan or make it safer: it tells Adag to judge only what you borrow from now on.</p>
      {waiting ? (
        <p className="type-body mt-5 flex items-center gap-3 text-text" data-enrol-state="waiting-block">
          <span aria-hidden="true" className="live-shimmer inline-block h-[2px] w-10" />
          Recorded. Waiting for Arc&apos;s next block, then the payment below opens.
        </p>
      ) : (
        <Button variant="primary" disabled={!canSign || Boolean(busy)} onClick={() => void record()} className="mt-5 w-full md:w-auto" data-action="enrol">
          {busy ? <BusyLabel step={busy.step} since={busy.since} /> : "Record my existing loan"}
        </Button>
      )}
      <div className="mt-3">
        <TxMessage state={tx} />
      </div>
    </motion.div>
  );
}
