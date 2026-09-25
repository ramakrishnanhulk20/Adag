"use client";

import { useCallback, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import { BEAT_SECONDS, BEATS, buildTimeline } from "./timeline";

export type MotionKind = "scrub" | "autoplay" | "reduced";

type Options = {
  pinRef: RefObject<HTMLDivElement | null>;
  stageRef: RefObject<HTMLDivElement | null>;
  // A new key rebuilds the timeline: the bills on stage changed, or the data landed.
  key: string;
  ready: boolean;
  stamps: boolean;
  onFinal: (final: boolean) => void;
};

const PIN_SCREENS = 2.4;
const FINAL_AT = 0.9;

export function usePledgeMotion({ pinRef, stageRef, key, ready, stamps, onFinal }: Options) {
  const [kind, setKind] = useState<MotionKind>("scrub");
  const replayRef = useRef<() => void>(() => {});

  // A layout effect, so the pin is undone before React removes the nodes the pin spacer wraps.
  useLayoutEffect(() => {
    const pin = pinRef.current;
    const stage = stageRef.current;
    if (!pin || !stage) return;
    gsap.registerPlugin(ScrollTrigger);
    const mm = gsap.matchMedia();
    let final = false;

    // matchMedia only calls back when a condition matches, so "narrow" is listed for phones with motion on.
    mm.add({ wide: "(min-width: 768px)", narrow: "(max-width: 767.98px)", reduce: "(prefers-reduced-motion: reduce)" }, (ctx) => {
      const { wide, reduce } = ctx.conditions as { wide: boolean; reduce: boolean };
      const tl = buildTimeline(stage, { stamps });
      let run: gsap.core.Timeline | null = null;

      tl.eventCallback("onUpdate", () => {
        const p = tl.progress();
        stage.style.setProperty("--p", p.toFixed(4));
        const now = p >= FINAL_AT;
        if (now !== final) {
          final = now;
          onFinal(now);
        }
      });

      if (reduce) {
        setKind("reduced");
        tl.progress(1);
        // SPEC section 8: no movement, only a 1.2s cross-fade from the first beat to the last.
        replayRef.current = ctx.add("plReplay", () => {
          run?.kill();
          run = gsap
            .timeline()
            .to(stage, { opacity: 0, duration: 0.2 })
            .add(() => {
              tl.progress(0.07);
            })
            .to(stage, { opacity: 1, duration: 0.2 })
            .to({}, { duration: 0.4 })
            .to(stage, { opacity: 0, duration: 0.2 })
            .add(() => {
              tl.progress(1);
            })
            .to(stage, { opacity: 1, duration: 0.2 });
        }) as () => void;
        return () => run?.kill();
      }

      if (wide) {
        setKind("scrub");
        replayRef.current = () => {};
        ScrollTrigger.create({
          trigger: pin,
          start: "top top",
          end: () => `+=${window.innerHeight * PIN_SCREENS}`,
          pin: true,
          scrub: 0.6,
          animation: tl,
          anticipatePin: 1,
          invalidateOnRefresh: true,
        });
        return;
      }

      setKind("autoplay");
      tl.progress(0);
      const play = ctx.add("plPlay", () => {
        run?.kill();
        tl.progress(0);
        run = gsap.timeline();
        BEAT_SECONDS.forEach((seconds, i) => run!.to(tl, { progress: BEATS[i + 1], duration: seconds, ease: "none" }));
      }) as () => void;
      replayRef.current = play;
      if (!ready) return () => run?.kill();

      // "40% in view", unless the stage is too tall for 40% of it to ever fit on screen.
      const threshold = Math.min(0.4, (window.innerHeight * 0.9) / Math.max(stage.offsetHeight, 1));
      const io = new IntersectionObserver(
        (entries) => {
          if (entries.some((e) => e.isIntersecting && e.intersectionRatio >= threshold - 0.01)) {
            io.disconnect();
            play();
          }
        },
        { threshold: [threshold] },
      );
      io.observe(stage);
      return () => {
        io.disconnect();
        run?.kill();
      };
    });

    return () => {
      mm.revert();
      stage.style.removeProperty("--p");
      if (final) onFinal(false);
    };
  }, [pinRef, stageRef, key, ready, stamps, onFinal]);

  const replay = useCallback(() => replayRef.current(), []);
  return { kind, replay };
}
