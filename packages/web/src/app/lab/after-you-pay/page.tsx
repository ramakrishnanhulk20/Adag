import type { Metadata } from "next";
import { Hallmark } from "@/components/Hallmark";
import { ThemeControl } from "@/components/ThemeControl";
import { AfterYouPay } from "@/components/landing/AfterYouPay";
import { HeroCopyTweaks } from "./HeroCopyTweaks";

export const metadata: Metadata = {
  title: "After you pay · Adag lab",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

// For Ram's review on the dev server before the section reaches the home page, after 05 · The 40% line.
export default function AfterYouPayLab() {
  return (
    <main>
      <section className="flex h-[40vh] flex-col justify-between bg-bg px-5 pt-8 pb-10 md:px-[6vw]">
        <div className="flex items-center justify-between">
          <Hallmark tone="quiet">Lab · after you pay</Hallmark>
          <ThemeControl />
        </div>
        <p className="type-micro max-w-[60ch] text-muted">
          The proposed section 06, shown on its own. It goes on the home page after 05 · The 40% line once approved; For suppliers and The
          ledger then become 07 and 08.
        </p>
      </section>
      <AfterYouPay />
      <HeroCopyTweaks />
    </main>
  );
}
