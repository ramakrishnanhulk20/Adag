"use client";

import { useTheme } from "@/components/ThemeProvider";

export function ResolvedThemeLine() {
  const { choice, resolved } = useTheme();
  const shown = resolved ?? "reading";
  return (
    <p className="type-lead text-muted" aria-live="polite">
      Showing the <span className="font-display text-[1.15em] italic text-gold">{shown}</span> theme
      {choice === "system" ? ", because the choice is System and follows this device." : `, because the choice is ${choice === "light" ? "Light" : "Dark"}.`}
    </p>
  );
}
