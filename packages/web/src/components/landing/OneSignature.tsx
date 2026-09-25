import "./landing.css";
import { Hallmark } from "@/components/Hallmark";
import { Receipt } from "./Receipt";
import { Reveal } from "./Reveal";

const PROOF_TX = "https://explorer.arc.io/tx/0x6987964bddd7f8a8fe2a59d6de9baaa6ac37b8a720aae5900d8cb9af0eaf2292";

// Section 4: the real batch, printed like a receipt.
export function OneSignature() {
  return (
    <section id="how" aria-labelledby="how-title" className="landing-section scroll-mt-20 border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <div className="grid gap-14 md:grid-cols-12 md:gap-8">
        <div className="md:sticky md:top-32 md:col-span-5 md:self-start">
          <Reveal>
            <Hallmark>04 · One signature</Hallmark>
          </Reveal>
          <Reveal delay={0.08}>
            <h2 id="how-title" className="type-h2 mt-8 max-w-[13ch]">
              Five steps, <em className="whitespace-nowrap text-gold italic">one signature.</em>
            </h2>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="type-lead mt-8 max-w-[36ch] text-text/88">
              Paying a bill from bitcoin is five calls on Arc. You sign them once, as one batch, and they land together.
            </p>
          </Reveal>
        </div>
        <div className="md:col-span-7">
          <Reveal>
            <Receipt />
          </Reveal>
          <Reveal delay={0.08} className="mt-12 flex flex-col gap-5">
            <p className="type-h3 max-w-[22ch]">If any step fails, none of it happened.</p>
            <a href={PROOF_TX} target="_blank" rel="noopener noreferrer" className="link-draw type-label self-start text-gold">
              See the real one on Arc
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
