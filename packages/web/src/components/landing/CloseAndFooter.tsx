import "./landing.css";
import Link from "next/link";
import { ThemeControl } from "@/components/ThemeControl";
import { HeroAction } from "@/components/hero/HeroAction";
import { ADAG_BILLS } from "@/lib/arc/constants";
import { Reveal } from "./Reveal";

// Section 8: the last ask, then the footer. "Powered by Morpho" is required by Morpho's UI rules (ARCHITECTURE.md section 8).
export function CloseAndFooter() {
  return (
    <>
      <section aria-labelledby="close-title" className="landing-section border-t border-rule bg-bg px-5 py-28 md:px-[6vw] md:py-40">
        <div className="grid gap-12 md:grid-cols-12 md:items-end md:gap-8">
          <div className="md:col-span-7">
            <Reveal>
              <h2 id="close-title" className="type-h2 max-w-[12ch]">
                The bill is due. <em className="text-gold italic">The bitcoin stays.</em>
              </h2>
            </Reveal>
            <Reveal delay={0.08} className="mt-10">
              <HeroAction href="/pay" variant="primary">
                Pay a bill
              </HeroAction>
            </Reveal>
          </div>
          <Reveal delay={0.16} className="md:col-span-4 md:col-start-9">
            <p lang="ta" className="tamil-word text-[clamp(4rem,2rem+6vw,7.5rem)] text-gold">
              அடகு
            </p>
            <p className="type-micro mt-4 text-muted">
              <span className="normal-case tracking-normal">adagu</span> · Tamil for a pledge
            </p>
          </Reveal>
        </div>
      </section>

      <footer className="border-t border-rule bg-bg px-5 py-12 md:px-[6vw]">
        <div className="flex flex-col gap-10 md:flex-row md:items-end md:justify-between">
          <div className="flex flex-col gap-4">
            <span className="font-display text-[22px] font-semibold tracking-[0.08em]">ADAG</span>
            <p className="type-micro text-muted">Powered by Morpho · on Arc mainnet</p>
          </div>
          <nav aria-label="Footer" className="type-label flex flex-wrap gap-x-8 gap-y-3 text-text/88">
            <Link href="/docs" className="link-draw hover:text-gold">
              Docs
            </Link>
            <Link href="/terms" className="link-draw hover:text-gold">
              Terms of Use
            </Link>
            <a href={`https://explorer.arc.io/address/${ADAG_BILLS}`} target="_blank" rel="noopener noreferrer" className="link-draw hover:text-gold">
              The contract
            </a>
          </nav>
          <ThemeControl variant="segmented" />
        </div>
      </footer>
    </>
  );
}
