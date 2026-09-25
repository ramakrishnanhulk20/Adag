"use client";

import { useSyncExternalStore } from "react";

function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
  return () => observer.disconnect();
}

// Lenis marks the root element with a "lenis" class while it is running.
const isOn = () => document.documentElement.classList.contains("lenis");

export function SmoothScrollStatus() {
  const on = useSyncExternalStore(subscribe, isOn, () => null);
  return (
    <p className="type-label" aria-live="polite">
      {on === null ? (
        <span className="text-muted">Checking smooth scroll</span>
      ) : on ? (
        <span className="text-success">Lenis is on · lerp 0.1 · synced to the GSAP ticker</span>
      ) : (
        <span className="text-pending">Lenis is off here · native scroll for reduced motion or touch</span>
      )}
    </p>
  );
}
