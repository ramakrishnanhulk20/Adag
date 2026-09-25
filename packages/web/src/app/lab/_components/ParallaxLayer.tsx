"use client";

import { useEffect, useRef } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Moves its content between -range% and +range% of its own height while the frame crosses the screen.
export function ParallaxLayer({ range = 6, children }: { range?: number; children: React.ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    const frame = el?.parentElement;
    if (!el || !frame) return;
    gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        el,
        { yPercent: -range },
        { yPercent: range, ease: "none", scrollTrigger: { trigger: frame, start: "top bottom", end: "bottom top", scrub: 0.6 } },
      );
    });
    return () => mm.revert();
  }, [range]);

  return (
    // One extra percent of overhang, because yPercent is measured on this taller layer, not the frame.
    <div ref={ref} className="absolute inset-x-0 will-change-transform" style={{ top: `-${range + 1}%`, bottom: `-${range + 1}%` }}>
      {children}
    </div>
  );
}
