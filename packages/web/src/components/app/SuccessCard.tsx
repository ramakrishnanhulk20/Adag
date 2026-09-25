"use client";

import { motion } from "motion/react";
import { BillStamp } from "@/components/BillStamp";
import { EXPLORER } from "@/lib/pay/constants";
import { shortAddress } from "@/lib/pay/format";

type SuccessCardProps = {
  status: "paid" | "void";
  hash: string;
  title: string;
  rows: { label: string; value: React.ReactNode }[];
};

export function SuccessCard({ status, hash, title, rows }: SuccessCardProps) {
  return (
    <motion.div
      data-tx-result={status}
      initial={{ opacity: 0, y: 24 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.6, ease: [0.16, 1, 0.3, 1] }}
      className="app-panel app-stamp relative p-6 md:p-8"
    >
      <div className="flex flex-wrap items-start justify-between gap-6">
        <div>
          <p className={`type-label ${status === "paid" ? "text-success" : "text-danger"}`}>Confirmed on Arc</p>
          <p className="type-h3 mt-3 max-w-[18ch] text-text">{title}</p>
        </div>
        <BillStamp status={status} entrance="in-view" tilt={status === "paid" ? -9 : -11} />
      </div>
      <dl className="mt-8 grid gap-x-8 gap-y-4 border-t border-rule pt-6 sm:grid-cols-2">
        <div>
          <dt className="type-micro text-muted">Transaction</dt>
          <dd className="mt-1">
            <a href={`${EXPLORER}/tx/${hash}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address text-text hover:text-gold">
              {shortAddress(hash)} on the explorer
            </a>
          </dd>
        </div>
        {rows.map((r) => (
          <div key={r.label}>
            <dt className="type-micro text-muted">{r.label}</dt>
            <dd className="type-body mt-1 tabular-nums text-text">{r.value}</dd>
          </div>
        ))}
      </dl>
    </motion.div>
  );
}
