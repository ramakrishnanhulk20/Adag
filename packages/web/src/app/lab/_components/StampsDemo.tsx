"use client";

import { useEffect, useState } from "react";
import { motion, useReducedMotion } from "motion/react";
import { BillStamp, type BillStatus } from "@/components/BillStamp";
import { Button } from "@/components/Button";

const STAMPS: { status: BillStatus; ink: string; meaning: string }[] = [
  { status: "paid", ink: "--success", meaning: "The supplier has the money, invoice number attached." },
  { status: "open", ink: "--pending", meaning: "Written and waiting to be paid." },
  { status: "void", ink: "--danger", meaning: "Cancelled by the supplier before payment." },
];

export function StampsDemo() {
  const [take, setTake] = useState(0);
  const reduce = useReducedMotion();

  return (
    <div className="flex flex-col gap-8">
      <div className="grid gap-px overflow-hidden border border-rule bg-rule md:grid-cols-3">
        {STAMPS.map((stamp, i) => (
          <motion.div
            key={`${stamp.status}-${take}`}
            className="flex min-h-64 flex-col justify-between gap-10 bg-surface p-6 md:p-8"
            // The card jolts 2px as the stamp lands, timed to the spring's first contact.
            animate={reduce || take === 0 ? undefined : { x: [0, -2, 2, -1, 1, 0] }}
            transition={{ duration: 0.28, delay: 0.12 + i * 0.18 }}
          >
            <p className="type-micro text-muted">
              {stamp.status} · {stamp.ink}
            </p>
            <div className="flex justify-center py-4">
              <StampAfter delay={take === 0 ? 0 : i * 0.18}>
                <BillStamp status={stamp.status} entrance="in-view" />
              </StampAfter>
            </div>
            <p className="type-body max-w-[32ch] text-muted">{stamp.meaning}</p>
          </motion.div>
        ))}
      </div>
      <div>
        <Button variant="secondary" onClick={() => setTake((t) => t + 1)}>
          Stamp again
        </Button>
      </div>
    </div>
  );
}

// Staggers each stamp 180ms after the one before, as on the landing page.
function StampAfter({ delay, children }: { delay: number; children: React.ReactNode }) {
  const [ready, setReady] = useState(delay === 0);
  useEffect(() => {
    if (ready) return;
    const timer = window.setTimeout(() => setReady(true), delay * 1000);
    return () => window.clearTimeout(timer);
  }, [ready, delay]);
  return <span className="inline-flex min-h-16 items-center">{ready ? children : null}</span>;
}
