import "./landing.css";
import Link from "next/link";
import { Hallmark } from "@/components/Hallmark";
import { PledgeStill } from "./PledgeStill";
import { Reveal } from "./Reveal";

// Section 2: the name's story. Plain sentences, no statistics.
export function PledgedNotSold() {
  return (
    <section aria-labelledby="pledged-title" className="landing-section bg-bg px-5 pt-24 pb-28 md:px-[6vw] md:pt-36 md:pb-40">
      <div className="grid gap-14 md:grid-cols-12 md:items-center md:gap-8">
        <Reveal className="md:col-span-5">
          <PledgeStill />
        </Reveal>
        <div className="md:col-span-6 md:col-start-7">
          <Reveal>
            <Hallmark>02 · Pledged, not sold</Hallmark>
          </Reveal>
          <Reveal delay={0.08}>
            <h2 id="pledged-title" className="type-h2 mt-8 max-w-[11ch]">
              Pledged, <em className="text-gold italic">not sold.</em>
            </h2>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="type-lead mt-8 max-w-[34ch] text-text/88">
              In India, families pledge their gold for cash instead of selling it, and take it home again when the loan is
              repaid.
            </p>
          </Reveal>
          <Reveal delay={0.24}>
            <p className="type-lead mt-5 max-w-[34ch] text-text/88">
              Adag, from the Tamil word <em className="font-display text-[1.12em] italic">adagu</em>, a pledge, does the same
              with bitcoin, on Arc.
            </p>
          </Reveal>
          <Reveal delay={0.32}>
            <p className="type-micro mt-8 max-w-[52ch] border-t border-rule pt-5 leading-[1.7] text-muted">
              <Link href="/docs/faq#where-is-the-bitcoin" className="link-draw text-gold">
                Where is the bitcoin?
              </Link>{" "}
              <span className="normal-case tracking-normal">
                cirBTC is Circle&apos;s wrapped bitcoin, backed 1:1 and held by Circle, with{" "}
                <a href="https://www.circle.com/cirbtc" target="_blank" rel="noopener noreferrer" className="text-text underline decoration-rule-strong underline-offset-4 transition-colors duration-200 hover:text-gold hover:decoration-gold">
                  public reserves
                </a>
                . Pledged, it sits in your own Morpho position and is not lent out. Adag never holds it.
              </span>
            </p>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
