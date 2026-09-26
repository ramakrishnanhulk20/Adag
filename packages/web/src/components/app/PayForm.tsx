"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { arc } from "viem/chains";
import { usePublicClient } from "wagmi";
import { Button } from "@/components/Button";
import { adagAbi } from "@/lib/pay/abi";
import { basketHref, billHref, parseBillList } from "@/lib/pay/billId";
import { deploymentOf } from "@/lib/pay/constants";

export function PayForm() {
  const router = useRouter();
  const client = usePublicClient({ chainId: arc.id });
  const inputId = useId();
  const noteId = useId();
  const [value, setValue] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const onSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    let parsed: ReturnType<typeof parseBillList>;
    try {
      parsed = parseBillList(value);
    } catch (error) {
      setNote((error as Error).message);
      return;
    }
    const { refs, dropped } = parsed;
    if (refs.length === 0) {
      setNote("Type a bill number, like 12, or paste the bill link your supplier sent. Several numbers pay together.");
      return;
    }
    if (dropped.length) {
      setNote(`"${dropped[0]}" is not a bill number or a bill link. Fix it or take it out.`);
      return;
    }
    // Several bills open the basket; the page reads each one itself and says which cannot be paid.
    if (refs.length > 1) {
      setBusy(true);
      router.push(basketHref(refs[0]!.contract, refs.map((r) => r.id)));
      return;
    }
    const ref = refs[0]!;
    const first = deploymentOf(ref.contract)?.label === "first";
    setBusy(true);
    setNote(null);
    let count: bigint | null = null;
    try {
      // Read fresh at the moment of asking, on the bill's own contract, so a bill written a second ago is found.
      count = client ? await client.readContract({ address: ref.contract, abi: adagAbi, functionName: "billCount" }) : null;
    } catch {
      count = null;
    }
    if (count !== null && ref.id > count) {
      setBusy(false);
      const where = first ? "on the first AdagBills deployment" : "on Arc";
      setNote(count === 0n ? `No bill #${ref.id} ${where} yet. No bills have been written so far.` : `No bill #${ref.id} ${where} yet. The newest bill is #${count}.`);
      return;
    }
    // When Arc did not answer, the bill page runs its own read and says plainly if the bill is missing.
    router.push(billHref(ref.contract, ref.id));
  };

  return (
    <form onSubmit={onSubmit} noValidate className="w-full max-w-[44rem]">
      <label htmlFor={inputId} className="type-label text-muted">
        Bill numbers or links
      </label>
      <div className="mt-3 flex flex-col gap-5 md:flex-row md:items-end md:gap-6">
        <input
          id={inputId}
          name="bill"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder="For example 1, or paste a bill link"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (note) setNote(null);
          }}
          aria-invalid={note ? true : undefined}
          aria-describedby={noteId}
          className="app-input app-input-hint"
        />
        <Button type="submit" variant="primary" disabled={busy} className="w-full shrink-0 md:w-auto">
          {busy ? "Checking Arc" : "Open the bill"}
        </Button>
      </div>
      <div id={noteId} aria-live="polite" className="mt-4 min-h-[3.25rem]">
        <AnimatePresence mode="wait">
          {note && (
            <motion.p
              key={note}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -4 }}
              transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
              className="type-body flex items-start gap-3 text-text"
            >
              <span aria-hidden="true" className="diamond mt-[0.55em] !bg-pending" />
              {note}
            </motion.p>
          )}
        </AnimatePresence>
      </div>
    </form>
  );
}
