import { Hallmark } from "@/components/Hallmark";

// Lab only: a stand-in for the signature moment, which another work order builds on /lab/pledge.
export function PledgePlaceholder() {
  return (
    <section id="pledge" aria-label="The pledge" className="landing-section flex min-h-svh flex-col gap-6 border-t border-rule bg-bg px-5 pt-24 md:px-[6vw] md:pt-32">
      <Hallmark className="self-start">03 · The pledge</Hallmark>
      <p className="type-body max-w-[52ch] text-muted">The pledge stage is built on /lab/pledge and drops in here once it is approved.</p>
    </section>
  );
}
