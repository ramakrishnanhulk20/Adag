"use client";

export type Cell<T> = { state: "loading" } | { state: "unavailable" } | { state: "ok"; value: T };

export const ok = <T,>(value: T): Cell<T> => ({ state: "ok", value });

export function Value<T>({ cell, render, className = "" }: { cell: Cell<T>; render: (v: T) => React.ReactNode; className?: string }) {
  if (cell.state === "loading") return <span aria-label="Loading" className="live-shimmer inline-block h-[0.9em] w-24 rounded-[2px] align-middle" />;
  // C19: a failed read says so. It never falls back to zero.
  if (cell.state === "unavailable") return <span className="type-label text-muted">unavailable</span>;
  return <span className={className}>{render(cell.value)}</span>;
}

export const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
};
export const rise = (i: number) => ({ ...reveal, transition: { duration: 0.7, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] as const } });
