"use client";

import { useEffect, useState } from "react";

// Widths measured before the webfonts arrive describe the fallback font, not ours. Returns a counter that bumps on each re-measure point.
export function useMeasureAfterFonts(): number {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    let alive = true;
    const bump = () => alive && setTick((t) => t + 1);
    document.fonts.ready.then(bump);
    window.addEventListener("resize", bump);
    return () => {
      alive = false;
      window.removeEventListener("resize", bump);
    };
  }, []);

  return tick;
}
