"use client";

import { useRef } from "react";
import { motion, useReducedMotion, useScroll, useTransform } from "motion/react";

type ParallaxProps = {
  children: React.ReactNode;
  // Pixels the layer travels over one screen of scrolling. Negative drifts up, slower than the page.
  distance?: number;
  className?: string;
};

export function Parallax({ children, distance = -120, className = "" }: ParallaxProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduce = useReducedMotion();
  const { scrollYProgress } = useScroll({ target: ref, offset: ["start start", "end start"] });
  const y = useTransform(scrollYProgress, [0, 1], [0, reduce ? 0 : distance]);

  return (
    <motion.div ref={ref} style={{ y }} className={className}>
      {children}
    </motion.div>
  );
}
