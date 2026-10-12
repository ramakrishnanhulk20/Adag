"use client";

import { useId, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { arc } from "viem/chains";
import { usePublicClient } from "wagmi";
import { Button } from "@/components/Button";
import { useLibText } from "@/i18n/useLibText";
import { adagAbi } from "@/lib/pay/abi";
import { basketHref, billHref, parseBillList } from "@/lib/pay/billId";
import { deploymentOf } from "@/lib/pay/constants";

export function PayForm() {
  const t = useTranslations("pay.form");
  const tl = useLibText();
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
      setNote(tl((error as Error).message));
      return;
    }
    const { refs, dropped } = parsed;
    if (refs.length === 0) {
      setNote(t("typeANumber"));
      return;
    }
    if (dropped.length) {
      setNote(t("notABillNumber", { token: dropped[0]! }));
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
      const where = first ? t("onFirstDeployment") : t("onArc");
      setNote(count === 0n ? t("noBillYetNone", { id: ref.id.toString(), where }) : t("noBillYetNewest", { id: ref.id.toString(), where, newest: count.toString() }));
      return;
    }
    // When Arc did not answer, the bill page runs its own read and says plainly if the bill is missing.
    router.push(billHref(ref.contract, ref.id));
  };

  return (
    <form onSubmit={onSubmit} noValidate className="w-full max-w-[44rem]">
      <label htmlFor={inputId} className="type-label text-muted">
        {t("label")}
      </label>
      <div className="mt-3 flex flex-col gap-5 md:flex-row md:items-end md:gap-6">
        <input
          id={inputId}
          name="bill"
          type="text"
          inputMode="text"
          autoComplete="off"
          spellCheck={false}
          placeholder={t("placeholder")}
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
          {busy ? t("checkingArc") : t("openTheBill")}
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
