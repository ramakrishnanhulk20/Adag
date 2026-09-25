"use client";

import { motion } from "motion/react";

type RevealProps = {
  children: React.ReactNode;
  delay?: number;
  className?: string;
  // "load" plays on first paint for the page header; "view" waits until the block scrolls in.
  on?: "view" | "load";
};

export function Reveal({ children, delay = 0, className, on = "view" }: RevealProps) {
  const transition = { duration: 0.8, ease: [0.16, 1, 0.3, 1] as const, delay };
  if (on === "load") {
    return (
      <motion.div className={className} initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }} transition={transition}>
        {children}
      </motion.div>
    );
  }
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.3 }}
      transition={transition}
    >
      {children}
    </motion.div>
  );
}
