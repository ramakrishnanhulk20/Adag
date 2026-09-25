"use client";

import { useEffect, useRef, useState } from "react";
import { useMeasureAfterFonts } from "./useMeasureAfterFonts";

// SPEC open item 2: line two must fit on one line inside the layout at 1280, 1440 and 1920.
export function HeroSentence() {
  const tick = useMeasureAfterFonts();
  const boxRef = useRef<HTMLHeadingElement>(null);
  const lineRef = useRef<HTMLSpanElement>(null);
  const [fit, setFit] = useState<{ line: number; box: number; size: number; lines: number } | null>(null);

  useEffect(() => {
    const box = boxRef.current;
    const line = lineRef.current;
    if (!box || !line) return;
    const size = parseFloat(getComputedStyle(box).fontSize);
    const lineHeight = size * 0.92;
    setFit({
      line: Math.round(line.getBoundingClientRect().width),
      box: Math.round(box.getBoundingClientRect().width),
      size: Math.round(size),
      lines: Math.round(box.getBoundingClientRect().height / lineHeight),
    });
  }, [tick]);

  return (
    <div>
      <h2 ref={boxRef} className="type-hero text-text">
        <span className="block">Pay the bill.</span>
        <span className="block">
          <span ref={lineRef} className="inline">
            Keep the <em className="font-display font-semibold text-gold italic">bitcoin</em>.
          </span>
        </span>
      </h2>
      <p className="type-micro mt-4 text-muted">
        {fit
          ? `Measured live: ${fit.size}px, ${fit.lines} lines, line two ${fit.line}px wide in a ${fit.box}px column`
          : "Measuring once the fonts load"}
      </p>
    </div>
  );
}
