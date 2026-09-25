"use client";

import { useEffect } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// SPEC section 4, scroll motion: over the first screen of scroll the camera pushes in, the words lift and dim,
// and the ground rises to --bg to hand over to section 2. Reduced motion keeps the still frame.
export function HeroScroll({ rootId }: { rootId: string }) {
  useEffect(() => {
    const root = document.getElementById(rootId);
    if (!root) return;
    gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();

    mm.add("(prefers-reduced-motion: no-preference)", () => {
      const media = root.querySelector("[data-hero-parallax]");
      const copy = root.querySelector("[data-hero-copy]");
      const handover = root.querySelector("[data-hero-handover]");
      const trigger = { trigger: root, start: "top top", end: () => `+=${window.innerHeight}`, scrub: 0.6 };

      const tl = gsap.timeline({ scrollTrigger: trigger, defaults: { ease: "none" } });
      if (media) tl.fromTo(media, { yPercent: 0, scale: 1 }, { yPercent: 12, scale: 1.08, duration: 1 }, 0);
      if (copy) tl.fromTo(copy, { yPercent: 0, opacity: 1 }, { yPercent: -8, opacity: 0.2, duration: 0.6 }, 0);
      if (handover) tl.fromTo(handover, { opacity: 0 }, { opacity: 1, duration: 1 }, 0);
    });

    return () => mm.revert();
  }, [rootId]);

  return null;
}
