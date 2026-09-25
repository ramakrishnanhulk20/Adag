"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const TOUCH_ONLY = "(hover: none) and (pointer: coarse)";

export function SmoothScroll() {
  useEffect(() => {
    gsap.registerPlugin(ScrollTrigger);
    const reduce = window.matchMedia(REDUCED_MOTION);
    const touch = window.matchMedia(TOUCH_ONLY);
    let lenis: Lenis | null = null;
    const tick = (time: number) => lenis?.raf(time * 1000);

    const start = () => {
      if (lenis) return;
      lenis = new Lenis({ lerp: 0.1, syncTouch: false });
      lenis.on("scroll", ScrollTrigger.update);
      gsap.ticker.add(tick);
      // Lenis owns the frame timing; GSAP's lag catch-up would make the scroll jump after a slow frame.
      gsap.ticker.lagSmoothing(0);
    };

    const stop = () => {
      if (!lenis) return;
      gsap.ticker.remove(tick);
      gsap.ticker.lagSmoothing(500, 33);
      lenis.destroy();
      lenis = null;
    };

    const sync = () => (reduce.matches || touch.matches ? stop() : start());
    sync();
    reduce.addEventListener("change", sync);
    touch.addEventListener("change", sync);
    return () => {
      reduce.removeEventListener("change", sync);
      touch.removeEventListener("change", sync);
      stop();
    };
  }, []);

  return null;
}
