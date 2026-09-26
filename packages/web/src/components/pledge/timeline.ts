import { gsap } from "gsap";

// SPEC section 5. The timeline is laid out in scroll share (0 to 1), so a scrub maps straight onto it;
// autoplay walks the same timeline beat by beat at each beat's own duration.
export const BEATS = [0, 0.12, 0.3, 0.48, 0.62, 0.8, 1] as const;
export const BEAT_SECONDS = [0.6, 0.8, 0.7, 0.6, 0.9, 0.8] as const;

// The photographed coin is 13.00% of the image tall and 14.33% wide, so a face-on coin lies down at this ratio.
const LIE_FLAT = (0.13 * 1792) / (0.1433 * 2400);

// gapless: phones hold multi-line captions in a narrow box, so the old one is fully gone before the new one appears.
export function buildTimeline(stage: HTMLElement, { stamps, gapless = false }: { stamps: boolean; gapless?: boolean }): gsap.core.Timeline {
  const q = gsap.utils.selector(stage);
  const pl = (name: string) => q(`[data-pl="${name}"]`);
  const cap = (beat: number) => q(`[data-pl-cap="${beat}"]`);
  const frame = stage.querySelector<HTMLElement>("[data-pl-frame]");
  const hang = () => -(frame?.offsetHeight ?? 0) * 0.3;

  const coin = pl("coin");
  const shade = pl("shade");
  const push = pl("push");
  const cone = pl("cone");
  const tray = q(".pl-tray");
  const cards = pl("card");

  const tl = gsap.timeline({ paused: true, defaults: { ease: "none" } });
  // Before the bills land there are no cards, lines or gauge; skipping empty targets keeps GSAP from warning.
  const empty = (targets: gsap.TweenTarget) => Array.isArray(targets) && targets.length === 0;
  const tw = {
    to: (targets: gsap.TweenTarget, vars: gsap.TweenVars, at: number) => {
      if (!empty(targets)) tl.to(targets, vars, at);
    },
    fromTo: (targets: gsap.TweenTarget, from: gsap.TweenVars, to: gsap.TweenVars, at: number) => {
      if (!empty(targets)) tl.fromTo(targets, from, to, at);
    },
  };
  const swapCaption = (from: number, to: number, at: number) => {
    tw.to(cap(from), { opacity: 0, y: -14, duration: 0.03, ease: "power2.in" }, at);
    tw.fromTo(cap(to), { opacity: 0, y: 14 }, { opacity: 1, y: 0, duration: 0.04, ease: "power2.out" }, at + (gapless ? 0.03 : 0.02));
  };

  // 1. The coin hangs in the light.
  tw.fromTo(cap(1), { opacity: 1, y: 0 }, { opacity: 1, y: 0, duration: 0.001 }, 0);
  tw.fromTo(pl("tag-1"), { opacity: 0, y: 8 }, { opacity: 1, y: 0, duration: 0.05, ease: "power2.out" }, 0.01);
  tw.fromTo(cone, { opacity: 0.55 }, { opacity: 1, duration: 0.12 }, 0);
  tw.fromTo(push, { scale: 1 }, { scale: 1.04, duration: 0.62, ease: "power1.inOut" }, 0);

  // 2. The bills slide in as a fan, 90ms apart.
  tw.fromTo(cards, { x: -140, opacity: 0, rotation: -6 }, { x: 0, opacity: 1, rotation: 0, duration: 0.1, stagger: 0.02, ease: "power3.out" }, 0.13);

  // 3. The pledge: the coin falls onto the photographed coin, settles, and hands over to it in 150ms.
  swapCaption(1, 3, 0.3);
  tw.to(pl("tag-1"), { opacity: 0, duration: 0.03 }, 0.3);
  tw.fromTo(coin, { y: hang, scaleY: 1, opacity: 1 }, { y: 6, scaleY: LIE_FLAT, duration: 0.1, ease: "power3.in" }, 0.3);
  tw.to(coin, { y: 0, duration: 0.04, ease: "back.out(2)" }, 0.4);
  tw.to(cone, { opacity: 0, duration: 0.08 }, 0.38);
  tw.to(coin, { opacity: 0, duration: 0.035 }, 0.44);
  tw.fromTo(shade, { opacity: 1 }, { opacity: 0, duration: 0.035 }, 0.44);
  tw.fromTo(tray, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.05 }, 0.42);
  tw.fromTo(pl("tag-3"), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.04, ease: "power2.out" }, 0.44);

  // 4. The loan: a line to each bill, and the gauge fills to the live loan-to-value.
  swapCaption(3, 4, 0.48);
  tw.fromTo(pl("borrowed"), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.04, ease: "power2.out" }, 0.49);
  tw.fromTo(pl("line"), { strokeDashoffset: 1 }, { strokeDashoffset: 0, duration: 0.08, stagger: 0.006, ease: "power2.inOut" }, 0.49);
  tw.fromTo(pl("gauge"), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.03, ease: "power2.out" }, 0.5);
  tw.fromTo(pl("gauge"), { "--fill": 0 }, { "--fill": 1, duration: 0.08, ease: "power2.out" }, 0.52);
  tw.fromTo(pl("line-label"), { opacity: 0 }, { opacity: 1, duration: 0.03, stagger: 0.01 }, 0.56);

  // 5. Paid: each bill is stamped 180ms after the last, and its card takes a 2px knock.
  swapCaption(4, 5, 0.62);
  if (stamps) {
    cards.forEach((card, i) => {
      const at = 0.64 + i * 0.036;
      const open = card.querySelector('[data-pl="stamp-open"]');
      const paid = card.querySelector('[data-pl="stamp-paid"]');
      const tx = card.querySelector('[data-pl="tx"]');
      if (open) tw.fromTo(open, { opacity: 1, scale: 1 }, { opacity: 0, scale: 0.92, duration: 0.02 }, at);
      if (paid) tw.fromTo(paid, { opacity: 0, scale: 1.35, rotation: 5 }, { opacity: 1, scale: 1, rotation: 0, duration: 0.05, ease: "back.out(2.4)" }, at);
      tw.to(card, { keyframes: { x: [-2, 2, -1, 0] }, duration: 0.03 }, at + 0.035);
      if (tx) tw.fromTo(tx, { opacity: 0, y: 4 }, { opacity: 1, y: 0, duration: 0.03, ease: "power2.out" }, at + 0.04);
      // The "Paid" date is only true once the stamp lands, so it appears with it rather than while the bill reads OPEN.
      const paidRow = Array.from(card.querySelectorAll('[data-pl="paid-row"]'));
      tw.fromTo(paidRow, { opacity: 0 }, { opacity: 1, duration: 0.03, ease: "power2.out" }, at + 0.03);
    });
  }

  // 6. Never sold: the camera eases back and the coin lifts out of the slot, glowing.
  swapCaption(5, 6, 0.8);
  tw.to(pl("tag-3"), { opacity: 0, duration: 0.03 }, 0.8);
  tw.to(push, { scale: 1, duration: 0.15, ease: "power2.out" }, 0.8);
  tw.to(coin, { opacity: 1, duration: 0.035 }, 0.82);
  tw.to(coin, { y: -8, duration: 0.08, ease: "power2.out" }, 0.84);
  tw.fromTo(pl("coin-glow"), { opacity: 0 }, { opacity: 1, duration: 0.08 }, 0.84);
  tw.to(shade, { opacity: 0.5, duration: 0.08 }, 0.84);
  tw.fromTo(pl("tag-6"), { opacity: 0, y: 6 }, { opacity: 1, y: 0, duration: 0.05, ease: "power2.out" }, 0.86);
  tw.fromTo(pl("final"), { opacity: 0, y: 10 }, { opacity: 1, y: 0, duration: 0.05, ease: "power2.out" }, 0.88);

  tl.set({}, {}, 1);
  return tl;
}
