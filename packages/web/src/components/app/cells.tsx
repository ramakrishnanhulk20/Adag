"use client";

import { createContext, useContext, useState } from "react";
import { useElapsed } from "./TxProgress";

export type Cell<T> = { state: "loading" } | { state: "unavailable" } | { state: "ok"; value: T };

export const ok = <T,>(value: T): Cell<T> => ({ state: "ok", value });

// A panel that owns the reads under it offers its refetch here, so any failed figure can say "Try again".
export const RetryContext = createContext<(() => void) | null>(null);

// Any wait past two seconds says what it is waiting for, and counts, instead of a bar that looks stuck.
export function Reading({ className = "" }: { className?: string }) {
  const [since] = useState(() => Date.now());
  const seconds = useElapsed(since);
  if (seconds < 2) return <span aria-label="Reading Arc" className={`live-shimmer inline-block h-[0.9em] w-24 rounded-[2px] align-middle ${className}`} />;
  return (
    <span className={`type-micro whitespace-nowrap text-muted ${className}`} data-reading>
      Reading Arc · {seconds}s
    </span>
  );
}

export function Unavailable() {
  const retry = useContext(RetryContext);
  return (
    <span className="inline-flex flex-wrap items-baseline gap-x-2">
      {/* C19: a failed read says so. It never falls back to zero. */}
      <span className="type-label text-muted">unavailable</span>
      {retry && (
        <button type="button" onClick={retry} className="type-micro text-gold underline-offset-4 transition-colors duration-200 hover:text-text hover:underline" data-retry>
          Try again
        </button>
      )}
    </span>
  );
}

export function Value<T>({ cell, render, className = "" }: { cell: Cell<T>; render: (v: T) => React.ReactNode; className?: string }) {
  if (cell.state === "loading") return <Reading />;
  if (cell.state === "unavailable") return <Unavailable />;
  return <span className={className}>{render(cell.value)}</span>;
}

export const reveal = {
  initial: { opacity: 0, y: 24 },
  whileInView: { opacity: 1, y: 0 },
  viewport: { once: true, amount: 0.2 },
};
export const rise = (i: number) => ({ ...reveal, transition: { duration: 0.7, delay: i * 0.08, ease: [0.16, 1, 0.3, 1] as const } });
