"use client";

import { useEffect, useRef } from "react";
import Image from "next/image";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { Grain } from "@/components/Grain";
import { images } from "@/lib/images";

const RANGE = 6;
// Scaling by 1.14 leaves 7% of overhang on each side, enough for a 6% travel measured on the scaled layer.
const SCALE = 1.14;

export function PledgeStill() {
  const frame = useRef<HTMLDivElement>(null);
  const layer = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!frame.current || !layer.current) return;
    gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();
    mm.add("(prefers-reduced-motion: no-preference)", () => {
      gsap.fromTo(
        layer.current,
        { yPercent: -RANGE, scale: SCALE },
        { yPercent: RANGE, scale: SCALE, ease: "none", scrollTrigger: { trigger: frame.current, start: "top bottom", end: "bottom top", scrub: 0.6 } },
      );
    });
    return () => mm.revert();
  }, []);

  const { width, height } = images.pledgeHands;
  return (
    <figure aria-label="Gold pledged, not sold.">
      <div
        ref={frame}
        className="still-frame relative overflow-hidden border border-rule bg-surface"
        style={{ aspectRatio: `${width} / ${height}` }}
      >
        <div ref={layer} className="still-layer-move">
          <Image
            src={images.pledgeHands}
            alt="Hands laying gold jewellery on a brass tray beside a handwritten pledge ticket"
            fill
            sizes="(min-width: 768px) 40vw, 100vw"
            quality={85}
            placeholder="blur"
            className="object-cover"
          />
          <div aria-hidden="true" className="ticket-soften" />
        </div>
        <div aria-hidden="true" className="still-layer scrim-caption tone-ink" />
        <Grain local />
        <p className="type-micro on-ink absolute bottom-5 left-5 z-10">Gold pledged, not sold.</p>
      </div>
    </figure>
  );
}
