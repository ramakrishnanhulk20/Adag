"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ThemeControl } from "@/components/ThemeControl";
import { ConnectButton } from "./ConnectButton";
import { WalletNotice } from "./WalletNotice";

const SOLID_AFTER_PX = 24;

export function AppNav() {
  const [solid, setSolid] = useState(false);

  useEffect(() => {
    let frame = 0;
    const check = () => {
      frame = 0;
      setSolid(window.scrollY > SOLID_AFTER_PX);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(check);
    };
    check();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 border-b transition-[background-color,border-color,backdrop-filter] duration-300 ${
        solid ? "border-rule bg-bg/92 backdrop-blur-[12px]" : "border-transparent bg-bg/60 backdrop-blur-[6px]"
      }`}
    >
      <div className="flex h-14 items-center justify-between gap-3 px-5 md:h-[72px] md:px-[6vw]">
        <div className="flex items-center gap-10">
          <Link href="/" className="font-display text-[22px] font-semibold tracking-[0.08em] text-text transition-colors duration-200 hover:text-gold">
            ADAG
          </Link>
          <nav aria-label="App" className="hidden items-center gap-8 md:flex">
            <Link href="/pay" className="link-draw type-ui text-text/88 transition-colors duration-200 hover:text-text">
              Pay a bill
            </Link>
          </nav>
        </div>
        <div className="flex items-center gap-2.5 md:gap-3">
          <ThemeControl variant="cycle" tipAlign="end" />
          <ConnectButton />
        </div>
      </div>
      <WalletNotice />
    </header>
  );
}
