"use client";

import { useEffect, useId, useState } from "react";
import { Button } from "@/components/Button";

type HeroActionProps = {
  href: string;
  variant: "primary" | "secondary";
  size?: "md" | "sm";
  children: React.ReactNode;
  // While the target screen does not exist yet, the button explains that instead of navigating to a 404.
  pending?: boolean;
  // Must include the display value (for example "inline-flex" or "hidden md:inline-flex"), so hiding it always works.
  className?: string;
  tipAlign?: "start" | "end" | "center";
};

const PENDING_TEXT = "Wired in the next step";

export function HeroAction({ href, variant, size = "md", children, pending = false, className = "inline-flex", tipAlign = "start" }: HeroActionProps) {
  const tipId = useId();
  const [flash, setFlash] = useState(false);

  useEffect(() => {
    if (!flash) return;
    const t = window.setTimeout(() => setFlash(false), 1800);
    return () => window.clearTimeout(t);
  }, [flash]);

  if (!pending) {
    return (
      <Button href={href} variant={variant} size={size} className={className}>
        {children}
      </Button>
    );
  }

  const align = tipAlign === "end" ? "right-0" : tipAlign === "center" ? "left-1/2 -translate-x-1/2" : "left-0";
  return (
    <span className={`group relative ${className}`}>
      <Button variant={variant} size={size} aria-describedby={tipId} onClick={() => setFlash(true)} className="w-full">
        {children}
      </Button>
      <span
        id={tipId}
        role="tooltip"
        className={`type-micro pointer-events-none absolute top-full z-30 mt-2 whitespace-nowrap rounded-[4px] border border-rule bg-raised px-2.5 py-1.5 text-muted transition duration-200 ${align} ${
          flash ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0 group-focus-within:translate-y-0 group-focus-within:opacity-100 group-hover:translate-y-0 group-hover:opacity-100"
        }`}
      >
        {PENDING_TEXT}
      </span>
    </span>
  );
}
