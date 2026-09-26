import "./landing.css";
import { Hallmark } from "@/components/Hallmark";
import { HeroAction } from "@/components/hero/HeroAction";
import { BillCard } from "./BillCard";
import { Reveal } from "./Reveal";

const STEPS = ["Write a bill", "Share its link", "Get paid in USDC or EURC, invoice number attached"];

// Section 6: the supplier's side, with one real bill read from Arc.
export function ForSuppliers() {
  return (
    <section aria-labelledby="suppliers-title" className="landing-section border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <div className="grid gap-14 md:grid-cols-12 md:items-center md:gap-8">
        <div className="md:col-span-5">
          <Reveal>
            <Hallmark>06 · For suppliers</Hallmark>
          </Reveal>
          <Reveal delay={0.08}>
            <h2 id="suppliers-title" className="type-h2 mt-8 max-w-[11ch]">
              Send a bill. <em className="text-gold italic">Get paid.</em>
            </h2>
          </Reveal>
          <Reveal delay={0.16}>
            <ol className="mt-10 flex flex-col">
              {STEPS.map((step, i) => (
                <li key={step} className="flex items-baseline gap-5 border-t border-rule py-4 last:border-b">
                  <span className="type-label text-gold">{String(i + 1).padStart(2, "0")}</span>
                  <span className="type-lead text-text/88">{step}</span>
                </li>
              ))}
            </ol>
          </Reveal>
          <Reveal delay={0.24} className="mt-10">
            <HeroAction href="/bill/new" variant="secondary">
              Write a bill
            </HeroAction>
          </Reveal>
        </div>
        <div className="md:col-span-6 md:col-start-7">
          <Reveal>
            <p className="type-micro mb-4 text-muted">The latest payment on Arc, read live</p>
            <BillCard />
          </Reveal>
        </div>
      </div>
    </section>
  );
}
