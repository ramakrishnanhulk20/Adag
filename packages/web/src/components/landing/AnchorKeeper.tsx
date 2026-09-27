"use client";

import { useEffect } from "react";

// How long after a jump the page may still grow above the target (live data landing, the pledge stage's bills on a
// phone). Past this, or once the reader scrolls, the page is left exactly where they put it.
const KEEP_MS = 8_000;
const TOLERANCE_PX = 4;

// Keeps an in-page link on its section while the page is still filling in. A click on "Proof" before the live data
// arrives would otherwise land short, because sections above it grow after the jump.
export function AnchorKeeper() {
  useEffect(() => {
    let target: string | null = null;
    let since = 0;

    const aim = (hash: string) => {
      const id = decodeURIComponent(hash.replace(/^#/, ""));
      if (!id || id === "top") return;
      target = id;
      since = Date.now();
    };
    const release = () => {
      target = null;
    };
    const realign = () => {
      if (!target) return;
      if (Date.now() - since > KEEP_MS) return release();
      const el = document.getElementById(target);
      if (!el) return;
      const margin = parseFloat(getComputedStyle(el).scrollMarginTop) || 0;
      if (Math.abs(el.getBoundingClientRect().top - margin) > TOLERANCE_PX) el.scrollIntoView({ block: "start", behavior: "instant" });
    };

    // A link clicked before this component loaded has already put its hash in the address bar.
    if (window.location.hash) {
      aim(window.location.hash);
      realign();
    }

    const onClick = (e: MouseEvent) => {
      const link = (e.target as Element | null)?.closest?.("a[href]");
      if (!(link instanceof HTMLAnchorElement)) return;
      const url = new URL(link.href, window.location.href);
      if (url.pathname === window.location.pathname && url.hash) aim(url.hash);
    };
    const onHash = () => aim(window.location.hash);
    const onKey = (e: KeyboardEvent) => {
      if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(e.key)) release();
    };

    const observer = new ResizeObserver(() => realign());
    observer.observe(document.body);
    document.addEventListener("click", onClick, true);
    window.addEventListener("hashchange", onHash);
    window.addEventListener("wheel", release, { passive: true });
    window.addEventListener("touchmove", release, { passive: true });
    window.addEventListener("keydown", onKey);
    return () => {
      observer.disconnect();
      document.removeEventListener("click", onClick, true);
      window.removeEventListener("hashchange", onHash);
      window.removeEventListener("wheel", release);
      window.removeEventListener("touchmove", release);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  return null;
}
