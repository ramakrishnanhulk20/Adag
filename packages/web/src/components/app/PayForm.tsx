"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { AnimatePresence, motion } from "motion/react";
import { arc } from "viem/chains";
import { usePublicClient } from "wagmi";
import { Button } from "@/components/Button";
import { adagAbi } from "@/lib/pay/abi";
import { parseBillList } from "@/lib/pay/billId";
import { ADAG_BILLS } from "@/lib/pay/constants";

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
    const { ids, dropped } = parsed;
    if (ids.length === 0) {
      setNote("Type a bill number, like 12, or paste the bill link your supplier sent. Several numbers pay together.");
      return;
    }
    if (dropped.length) {
      setNote(`"${dropped[0]}" is not a bill number or a bill link. Fix it or take it out.`);
      return;
    }
    // Several bills open the basket; the page reads each one itself and says which cannot be paid.
    if (ids.length > 1) {
      setBusy(true);
      router.push(`/pay/basket?bills=${ids.join(",")}`);
      return;
    }
    const id = ids[0]!;
    setBusy(true);
    setNote(null);
    let count: bigint | null = null;
    try {
      // Read fresh at the moment of asking, so a bill written a second ago is already found.
      count = client ? await client.readContract({ address: ADAG_BILLS, abi: adagAbi, functionName: "billCount" }) : null;
    } catch {
      count = null;
    }
    if (count !== null && id > count) {
      setBusy(false);
      setNote(count === 0n ? `No bill #${id} on Arc yet. No bills have been written so far.` : `No bill #${id} on Arc yet. The newest bill is #${count}.`);
      return;
    }
    // When Arc did not answer, the bill page runs its own read and says plainly if the bill is missing.
    router.push(`/bill/${id}`);
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
          placeholder="12, 13, 14"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            if (note) setNote(null);
          }}
          aria-invalid={note ? true : undefined}
          aria-describedby={noteId}
          className="app-input"
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
