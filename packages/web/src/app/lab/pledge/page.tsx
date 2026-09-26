import type { Metadata } from "next";
import { Hallmark } from "@/components/Hallmark";
import { ThemeControl } from "@/components/ThemeControl";
import { PledgeStage } from "@/components/pledge/PledgeStage";

export const metadata: Metadata = {
  title: "The pledge · Adag lab",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function PledgeLabPage() {
  return (
    <main>
      {/* Bare spacers, only so the pin's start and end can be judged. */}
      <section className="flex h-[60vh] flex-col justify-between bg-bg px-5 pt-8 pb-10 md:px-[6vw]">
        <div className="flex items-center justify-between">
          <Hallmark tone="quiet">Lab · the pledge</Hallmark>
          <ThemeControl />
        </div>
        <p className="type-micro text-muted">Scroll to play the signature moment</p>
      </section>
      <PledgeStage />
      <section className="flex h-[60vh] items-start bg-bg px-5 pt-16 md:px-[6vw]">
        <Hallmark tone="quiet">04 · One signature</Hallmark>
      </section>
    </main>
  );
}
