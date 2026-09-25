import type { ReactNode } from "react";

type CalloutType = "info" | "note" | "warn" | "warning" | "error" | "success" | "idea";

const LABEL: Record<CalloutType, string> = {
  info: "Note",
  note: "Note",
  warn: "Watch out",
  warning: "Watch out",
  error: "Not covered",
  success: "Proven",
  idea: "Why",
};

// SPEC section 3: callouts in the docs are framed as hallmarks, a chamfered 1px edge in the tone of the message.
export function Callout({ type = "info", title, children }: { type?: CalloutType; title?: ReactNode; children?: ReactNode }) {
  const tone =
    type === "warn" || type === "warning" ? "var(--pending)" : type === "error" ? "var(--danger)" : type === "success" ? "var(--success)" : "var(--gold)";
  return (
    <aside className="docs-callout not-prose my-7" style={{ "--callout-edge": tone } as React.CSSProperties}>
      <p className="docs-callout-label">{title ?? LABEL[type]}</p>
      <div className="docs-callout-body">{children}</div>
    </aside>
  );
}
