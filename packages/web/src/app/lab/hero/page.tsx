import type { Metadata } from "next";
import { Hallmark } from "@/components/Hallmark";
import { Hero } from "@/components/hero/Hero";

export const metadata: Metadata = {
  title: "Hero · Adag lab",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

export default function HeroLabPage() {
  return (
    <main>
      <Hero pending />
      {/* A bare stand-in for section 2, only so the scroll handover can be judged. */}
      <section className="min-h-svh bg-bg px-5 pt-24 md:px-[6vw] md:pt-32">
        <Hallmark>02 · Pledged, not sold</Hallmark>
      </section>
    </main>
  );
}
