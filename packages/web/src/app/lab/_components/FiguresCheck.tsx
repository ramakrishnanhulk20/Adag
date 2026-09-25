"use client";

import { useEffect, useRef, useState } from "react";
import { useMeasureAfterFonts } from "./useMeasureAfterFonts";

const FACES = [
  { key: "display", name: "Bodoni Moda 500", className: "font-display font-medium" },
  { key: "body", name: "DM Sans 500", className: "font-body font-medium" },
  { key: "mono", name: "IBM Plex Mono 500", className: "font-mono font-medium" },
] as const;

const FIGURES = ["1,111.11", "8,888.88"] as const;

type Reading = { a: number; b: number };

function FaceColumn({ name, className, tick }: { name: string; className: string; tick: number }) {
  const firstRef = useRef<HTMLSpanElement>(null);
  const secondRef = useRef<HTMLSpanElement>(null);
  const [reading, setReading] = useState<Reading | null>(null);

  useEffect(() => {
    if (!firstRef.current || !secondRef.current) return;
    setReading({
      a: firstRef.current.getBoundingClientRect().width,
      b: secondRef.current.getBoundingClientRect().width,
    });
  }, [tick]);

  const aligned = reading ? Math.abs(reading.a - reading.b) < 0.5 : null;

  return (
    <div className="flex flex-col gap-5 border-t border-rule pt-5">
      <p className="type-label text-muted">{name}</p>
      <div
        className={`${className} flex flex-col items-end text-[clamp(2.25rem,1.5rem+1.8vw,3.125rem)] leading-[1.05] tracking-[-0.01em] tabular-nums text-text`}
      >
        <span ref={firstRef}>{FIGURES[0]}</span>
        <span ref={secondRef}>{FIGURES[1]}</span>
      </div>
      <p className="type-micro" aria-live="polite">
        {reading === null ? (
          <span className="text-muted">Measuring once the fonts load</span>
        ) : aligned ? (
          <span className="text-success">Columns align: both {reading.a.toFixed(1)}px</span>
        ) : (
          <span className="text-danger">
            Columns drift: {reading.a.toFixed(1)}px against {reading.b.toFixed(1)}px
          </span>
        )}
      </p>
    </div>
  );
}

export function FiguresCheck() {
  const tick = useMeasureAfterFonts();
  return (
    <div className="grid gap-10 md:grid-cols-3 md:gap-8">
      {FACES.map((face) => (
        <FaceColumn key={face.key} name={face.name} className={face.className} tick={tick} />
      ))}
    </div>
  );
}
