"use client";

import { MotionConfig } from "motion/react";

// With "user", every Framer animation drops its movement and keeps only opacity when the OS asks for reduced motion.
export function MotionPreferences({ children }: { children: React.ReactNode }) {
  return <MotionConfig reducedMotion="user">{children}</MotionConfig>;
}
