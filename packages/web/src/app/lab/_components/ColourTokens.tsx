"use client";

import { useEffect, useState } from "react";
import { useTheme } from "@/components/ThemeProvider";

type Role = "ground" | "text" | "edge" | "fill" | "decor" | "on-gold" | "metal";

const TOKENS: { name: string; role: Role; note: string }[] = [
  { name: "--bg", role: "ground", note: "Page" },
  { name: "--surface", role: "ground", note: "Sections, receipts" },
  { name: "--raised", role: "ground", note: "Small cards only" },
  { name: "--text", role: "text", note: "Body and headlines" },
  { name: "--muted", role: "text", note: "Secondary text" },
  { name: "--gold", role: "text", note: "Gold text and marks" },
  { name: "--success", role: "text", note: "Paid" },
  { name: "--pending", role: "text", note: "Open, waiting for Arc" },
  { name: "--danger", role: "text", note: "Void, failed" },
  { name: "--rule-strong", role: "edge", note: "Inputs, focusable edges" },
  { name: "--gold-fill", role: "fill", note: "Primary button, coin" },
  { name: "--gold-hover", role: "fill", note: "Primary hover" },
  { name: "--gold-hover-edge", role: "edge", note: "Primary hover border" },
  { name: "--rule", role: "decor", note: "Decorative lines only" },
  { name: "--on-gold", role: "on-gold", note: "Text on a gold fill" },
  { name: "--coin-hi", role: "metal", note: "Coin highlight" },
  { name: "--coin-mid", role: "metal", note: "Coin body" },
  { name: "--coin-lo", role: "metal", note: "Coin shadow" },
  { name: "--coin-rim", role: "metal", note: "Coin rim" },
];

type Rgb = [number, number, number];

// A real element resolves the variable exactly as the page renders it; transition is killed so a theme fade cannot be sampled mid-way.
function readColour(probe: HTMLElement, variable: string): Rgb | null {
  probe.style.setProperty("color", `var(${variable})`);
  const parts = getComputedStyle(probe).color.match(/[\d.]+/g);
  if (!parts || parts.length < 3) return null;
  return [Number(parts[0]), Number(parts[1]), Number(parts[2])];
}

function toHex([r, g, b]: Rgb) {
  return `#${[r, g, b].map((c) => Math.round(c).toString(16).padStart(2, "0")).join("")}`.toUpperCase();
}

function luminance([r, g, b]: Rgb) {
  const lin = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: Rgb, b: Rgb) {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

type Row = { name: string; role: Role; note: string; hex: string; ratio: number | null; against: string };

function verdict(role: Role, ratio: number | null): { text: string; ok: boolean | null } {
  if (ratio === null) return { text: role === "ground" ? "Ground" : "Metal, no text", ok: null };
  if (role === "decor") return { text: "Decorative, never an only edge", ok: null };
  if (role === "text" || role === "on-gold") {
    if (ratio >= 7) return { text: "AAA text", ok: true };
    if (ratio >= 4.5) return { text: "AA text", ok: true };
    return { text: "Fails AA text", ok: false };
  }
  return ratio >= 3 ? { text: "Passes 3:1 non-text", ok: true } : { text: "Under 3:1 alone", ok: false };
}

export function ColourTokens() {
  const { resolved } = useTheme();
  const [rows, setRows] = useState<Row[] | null>(null);

  useEffect(() => {
    const probe = document.createElement("span");
    probe.style.setProperty("transition", "none", "important");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    document.body.appendChild(probe);

    const bg = readColour(probe, "--bg");
    const goldFill = readColour(probe, "--gold-fill");
    const next: Row[] = TOKENS.map((token) => {
      const colour = readColour(probe, token.name);
      const hex = colour ? toHex(colour) : "unreadable";
      let ratio: number | null = null;
      let against = "--bg";
      if (colour && bg && token.role !== "ground" && token.role !== "metal") {
        if (token.role === "on-gold" && goldFill) {
          ratio = contrast(colour, goldFill);
          against = "--gold-fill";
        } else {
          ratio = contrast(colour, bg);
        }
      }
      return { ...token, hex, ratio, against };
    });
    probe.remove();
    setRows(next);
  }, [resolved]);

  if (!rows) return <p className="type-micro text-muted">Reading the live colour variables</p>;

  return (
    <div>
      <div className="mb-8 flex h-16 overflow-hidden rounded-[2px] border border-rule">
        <div
          className="flex-1"
          style={{ backgroundImage: "linear-gradient(115deg, var(--coin-hi) 0%, var(--coin-mid) 48%, var(--coin-lo) 100%)" }}
        />
        <div className="w-3" style={{ backgroundColor: "var(--coin-rim)" }} />
        <p className="type-micro flex items-center bg-surface px-4 text-muted">Coin metal, both themes</p>
      </div>
      <ul className="grid border-t border-l border-rule sm:grid-cols-2 xl:grid-cols-3">
        {rows.map((row) => {
          const v = verdict(row.role, row.ratio);
          return (
            <li key={row.name} className="group flex items-stretch gap-4 border-r border-b border-rule p-4 transition-colors duration-200 hover:bg-surface">
              <span
                aria-hidden="true"
                className="w-14 flex-none border border-rule transition-transform duration-200 group-hover:scale-[1.04]"
                style={{ backgroundColor: `var(${row.name})` }}
              />
              <span className="flex min-w-0 flex-col gap-1">
                <span className="type-address text-text">{row.name}</span>
                <span className="type-micro text-muted">
                  {row.hex} · {row.note}
                </span>
                <span className="type-micro">
                  {row.ratio !== null && (
                    <span className="text-text">
                      {row.ratio.toFixed(2)} on {row.against}{" "}
                    </span>
                  )}
                  <span className={v.ok === null ? "text-muted" : v.ok ? "text-success" : "text-danger"}>{v.text}</span>
                </span>
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
