import "./landing.css";
import { Hallmark } from "@/components/Hallmark";
import { ADAG_BILLS } from "@/lib/arc/constants";
import { FortyGauge } from "./FortyGauge";
import { PendingLink } from "./PendingLink";
import { Reveal } from "./Reveal";

const CONTRACT = `https://explorer.arc.io/address/${ADAG_BILLS}`;

type Fact = { title: string; body: string; links: { label: string; href: string; internal?: boolean }[] };

const FACTS: Fact[] = [
  {
    title: "No owner, no upgrade, no pause",
    body: "There is no admin key and no switch. The 40% line and every address Adag trusts were fixed when it was deployed.",
    links: [{ label: "The contract on Arc", href: CONTRACT }],
  },
  {
    title: "Never holds your money",
    body: "Each payment moves from your wallet to the supplier inside one transaction. Nothing of yours waits in Adag.",
    links: [{ label: "Its token balances", href: `${CONTRACT}?tab=tokens` }],
  },
  {
    title: "Source verified",
    body: "The code running on Arc matches the published source exactly, checked by Sourcify and by Arc's explorer.",
    links: [
      { label: "Sourcify", href: `https://repo.sourcify.dev/5042/${ADAG_BILLS}` },
      { label: "explorer.arc.io", href: `${CONTRACT}?tab=contract` },
    ],
  },
  {
    title: "Refuses anything past 40%, even hand-built transactions",
    body: "The check lives in the contract, not the website. A payment that would push the loan past 40% reverts, whoever builds it.",
    links: [{ label: "Try to break it", href: "/break", internal: true }],
  },
];

// Section 5: the pinned 40% while the facts scroll past. Reduced motion drops the pin and shows everything at once.
export function FortyLine({ pending }: { pending: boolean }) {
  return (
    <section id="safety" aria-labelledby="safety-title" className="landing-section scroll-mt-20 border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <div className="grid gap-16 md:grid-cols-12 md:gap-8">
        <div className="md:sticky md:top-24 md:col-span-6 md:self-start motion-reduce:md:static">
          <Reveal>
            <Hallmark>05 · The 40% line</Hallmark>
          </Reveal>
          <Reveal delay={0.08}>
            <h2 id="safety-title" className="sr-only">
              The 40% line
            </h2>
            <p aria-hidden="true" className="type-pinned mt-6 text-gold">
              40%
            </p>
          </Reveal>
          <Reveal delay={0.16} className="mt-6 max-w-[34rem]">
            <p className="type-lead mb-8 max-w-[34ch] text-text/88">
              Adag never lets a payment push your loan past 40% of your bitcoin&apos;s value. Morpho&apos;s own line is far beyond it.
            </p>
            <FortyGauge />
          </Reveal>
        </div>
        <ol className="flex flex-col gap-16 md:col-span-5 md:col-start-8 md:gap-[38vh] md:pt-[30vh] md:pb-[20vh] motion-reduce:md:gap-16 motion-reduce:md:pt-0 motion-reduce:md:pb-0">
          {FACTS.map((fact, i) => (
            <li key={fact.title}>
              <Reveal>
                <p className="type-label text-gold">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="type-h3 mt-4 max-w-[18ch]">{fact.title}</h3>
                <p className="type-body mt-4 max-w-[46ch] text-muted">{fact.body}</p>
                <p className="mt-5 flex flex-wrap gap-x-6 gap-y-2">
                  {fact.links.map((link) =>
                    link.internal ? (
                      <PendingLink key={link.label} href={link.href} pending={pending} className="type-label text-gold">
                        {link.label}
                      </PendingLink>
                    ) : (
                      <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="link-draw type-label text-gold">
                        {link.label}
                      </a>
                    ),
                  )}
                </p>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
