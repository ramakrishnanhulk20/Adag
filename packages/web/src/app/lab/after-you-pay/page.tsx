import type { Metadata } from "next";
import { Hallmark } from "@/components/Hallmark";
import { ThemeControl } from "@/components/ThemeControl";
import { AfterYouPay } from "@/components/landing/AfterYouPay";
import { HeroCopyTweaks } from "./HeroCopyTweaks";

export const metadata: Metadata = {
  title: "After you pay · Lab",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

// The section as Ram reviewed and approved it; it is live on the home page, and this page stays for further design work.
export default function AfterYouPayLab() {
  return (
    <main>
      <section className="flex h-[40vh] flex-col justify-between bg-bg px-5 pt-8 pb-10 md:px-[6vw]">
        <div className="flex items-center justify-between">
          <Hallmark tone="quiet">Lab · after you pay</Hallmark>
          <ThemeControl />
        </div>
        <p className="type-micro max-w-[60ch] text-muted">
          Approved and now live on the home page as 06, after Check it yourself; For suppliers and The ledger are 07 and 08.
        </p>
      </section>
      <AfterYouPay />
      <HeroCopyTweaks />
    </main>
  );
}
