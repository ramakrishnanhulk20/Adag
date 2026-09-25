"use client";

import { useEffect, useId, useState } from "react";
import Link from "next/link";

// A text link whose page is built in a later work order. While pending it explains instead of opening a 404.
export function PendingLink({ href, pending, children, className = "" }: { href: string; pending: boolean; children: React.ReactNode; className?: string }) {
  const tipId = useId();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(false), 1800);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (!pending) {
    return (
      <Link href={href} className={`link-draw ${className}`}>
        {children}
      </Link>
    );
  }
  return (
    <span className="group relative inline-flex">
      <button type="button" aria-describedby={tipId} onClick={() => setFlash(true)} className={`link-draw cursor-pointer text-left [text-transform:inherit] ${className}`}>
        {children}
      </button>
      <span
        id={tipId}
        role="tooltip"
        className={`type-micro pointer-events-none absolute top-full left-0 z-30 mt-2 whitespace-nowrap rounded-[4px] border border-rule bg-raised px-2.5 py-1.5 text-muted transition duration-200 ${
          flash ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0 group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100"
        }`}
      >
        Wired in the next step
      </span>
    </span>
  );
}
