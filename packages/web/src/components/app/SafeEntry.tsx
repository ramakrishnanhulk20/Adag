"use client";

import { useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import type { Bill } from "@/lib/pay/build";
import { SafePay } from "./SafePay";

// Next to paying from the wallet: for a company whose money sits in a Safe on Arc.
// Once a proposal is out it stays on screen even when the page stops offering payment, so the owner sees it land.
export function SafeEntry({ bills, available, className = "" }: { bills: Bill[]; available: boolean; className?: string }) {
  const [open, setOpen] = useState(false);
  const [proposed, setProposed] = useState(false);
  if (!available && !proposed) return null;
  return (
    <div className={className}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="type-label inline-flex items-center gap-2 text-muted transition-colors duration-200 hover:text-gold"
        data-action="safe-open"
      >
        <span aria-hidden="true" className={`inline-block transition-transform duration-200 ${open ? "rotate-45" : ""}`}>
          +
        </span>
        Pay from a Safe
      </button>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div key="safe" initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: "auto" }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
            <div className="pt-4">
              <SafePay bills={bills} onProposed={() => setProposed(true)} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
