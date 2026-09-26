"use client";

import { useLayoutEffect, useState, type RefObject } from "react";
import { COIN_CENTRE, COIN_SIZE } from "./geometry";

export type LoanLine = { id: string; d: string; label: { x: number; y: number; anchor: "start" | "end" } | null };
type Geometry = { w: number; h: number; wide: boolean; lines: LoanLine[] };

const EMPTY: Geometry = { w: 1, h: 1, wide: true, lines: [] };
const WIDE = 768;

// The point where the line leaves the photographed coin's rim, heading for (tx, ty).
function rimPoint(cx: number, cy: number, rx: number, ry: number, tx: number, ty: number) {
  const dx = tx - cx;
  const dy = ty - cy;
  const t = 1 / Math.sqrt((dx / rx) ** 2 + (dy / ry) ** 2 || 1);
  return { x: cx + dx * t, y: cy + dy * t };
}

const r = (n: number) => Math.round(n * 10) / 10;

function measure(stage: HTMLElement): Geometry {
  const s = stage.getBoundingClientRect();
  const frame = stage.querySelector<HTMLElement>("[data-pl-frame]");
  const slots = Array.from(stage.querySelectorAll<HTMLElement>("[data-pl-slot]"));
  if (!frame || s.width === 0) return EMPTY;
  const f = frame.getBoundingClientRect();
  const cx = f.left - s.left + f.width * COIN_CENTRE.x;
  const cy = f.top - s.top + f.height * COIN_CENTRE.y;
  const rx = (f.width * COIN_SIZE.w) / 2;
  const ry = (f.height * COIN_SIZE.h) / 2;
  const wide = window.innerWidth >= WIDE;
  const gutter = s.width - 10;

  const lines = slots.map((slot, i): LoanLine => {
    const id = slot.dataset.plSlot ?? "";
    const b = slot.getBoundingClientRect();
    if (wide) {
      const ex = b.right - s.left - 8;
      const ey = b.top - s.top + b.height * 0.4;
      const start = rimPoint(cx, cy, rx, ry, ex, ey);
      const dx = start.x - ex;
      const c1 = { x: start.x - dx * 0.45, y: start.y };
      const c2 = { x: ex + dx * 0.45, y: ey };
      const mid = { x: 0.125 * start.x + 0.375 * c1.x + 0.375 * c2.x + 0.125 * ex, y: 0.125 * start.y + 0.375 * c1.y + 0.375 * c2.y + 0.125 * ey };
      return {
        id,
        d: `M${r(start.x)} ${r(start.y)} C${r(c1.x)} ${r(c1.y)} ${r(c2.x)} ${r(c2.y)} ${r(ex)} ${r(ey)}`,
        label: { x: r(mid.x), y: r(mid.y - 10), anchor: "start" },
      };
    }
    // Phones stack the bills under the photo, so each line runs out to the right gutter and down to its bill.
    const sx = cx + rx;
    const ey = b.top - s.top + 26;
    const ex = b.right - s.left - 4;
    const k = 8;
    return {
      id,
      d: `M${r(sx)} ${r(cy)} H${r(gutter - k)} Q${r(gutter)} ${r(cy)} ${r(gutter)} ${r(cy + k)} V${r(ey - k)} Q${r(gutter)} ${r(ey)} ${r(gutter - k)} ${r(ey)} H${r(ex)}`,
      label: i === 0 ? { x: r(gutter - 14), y: r(cy - 10), anchor: "end" } : null,
    };
  });
  return { w: r(s.width), h: r(s.height), wide, lines };
}

export function useLoanGeometry(stageRef: RefObject<HTMLElement | null>, key: string): Geometry {
  const [geo, setGeo] = useState<Geometry>(EMPTY);

  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    let frame = 0;
    const run = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => setGeo(measure(stage)));
    };
    run();
    const ro = new ResizeObserver(run);
    ro.observe(stage);
    // Fonts change card heights once they land, which moves every line end.
    void document.fonts?.ready.then(run);
    return () => {
      cancelAnimationFrame(frame);
      ro.disconnect();
    };
  }, [stageRef, key]);

  return geo;
}

// Wide screens label every line with its own bill; phones carry one label with the total.
export function LoanLines({ geometry, ids, labels, total }: { geometry: Geometry; ids: string[]; labels: Record<string, string>; total: string }) {
  const byId = new Map(geometry.lines.map((l) => [l.id, l]));
  return (
    <svg className="pl-lines" viewBox={`0 0 ${geometry.w} ${geometry.h}`} preserveAspectRatio="none" aria-hidden="true">
      {ids.map((id) => {
        const line = byId.get(id);
        const d = line?.d ?? "M0 0";
        return (
          <g key={id}>
            <path d={d} pathLength={1} data-pl="line" className="pl-line-glow" />
            <path d={d} pathLength={1} data-pl="line" className="pl-line" />
            <text
              data-pl="line-label"
              x={line?.label?.x ?? 0}
              y={line?.label?.y ?? 0}
              textAnchor={line?.label?.anchor ?? "start"}
              className={line?.label ? "pl-line-label" : "pl-line-label pl-hidden"}
            >
              {geometry.wide ? labels[id] : total}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
