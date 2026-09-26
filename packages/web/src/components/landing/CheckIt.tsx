import Link from "next/link";
import { EXPLORER } from "@/lib/arc/constants";
import { CHECKS } from "@/lib/break/catalogue";
import { Reveal } from "./Reveal";

// The live proof payment from the deployment record; the bill page itself reads its status from Arc on every visit.
const BILL_ONE_TX = `${EXPLORER}/tx/0x6987964bddd7f8a8fe2a59d6de9baaa6ac37b8a720aae5900d8cb9af0eaf2292`;

type Proof = { title: string; body: string; links: { label: string; href: string; external?: boolean }[] };

const PROOFS: Proof[] = [
  {
    title: "Bill #1, paid",
    body: "A real 1.00 USDC bill, settled from a bitcoin-backed Morpho loan in one signature.",
    links: [
      { label: "Open bill #1", href: "/bill/1" },
      { label: "Its transaction", href: BILL_ONE_TX, external: true },
    ],
  },
  {
    title: "Try to break it",
    body: `${CHECKS.length} attacks against the live contract, simulated on Arc while you watch. Each shows what stops it.`,
    links: [{ label: "Run the attacks", href: "/break" }],
  },
  {
    title: "Audit status",
    body: "Self-audited, not by an outside firm. What was tested, what was found, and what is not covered.",
    links: [{ label: "Read the record", href: "/docs/security/audit-status" }],
  },
];

// A short strip, not a numbered section: three ways to check the claims above without taking our word for it.
export function CheckIt() {
  return (
    <section aria-labelledby="check-title" className="landing-section border-t border-rule bg-bg px-5 py-16 md:px-[6vw] md:py-20">
      <div className="grid gap-10 md:grid-cols-12 md:gap-8">
        <Reveal className="md:col-span-3">
          <p className="type-label text-gold">Proof</p>
          <h2 id="check-title" className="type-h3 mt-4 max-w-[12ch]">
            Check it <em className="text-gold italic">yourself.</em>
          </h2>
        </Reveal>
        <ul className="grid gap-px bg-rule md:col-span-9 md:grid-cols-3">
          {PROOFS.map((proof, i) => (
            <li key={proof.title} className="group bg-bg py-6 md:px-8 md:py-2 md:first:pl-0">
              <Reveal delay={0.08 * (i + 1)} className="flex h-full flex-col gap-4">
                <p className="type-label text-muted transition-colors duration-200 group-hover:text-gold">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="type-h4">{proof.title}</h3>
                <p className="type-body max-w-[34ch] text-muted">{proof.body}</p>
                <p className="mt-auto flex flex-wrap gap-x-6 gap-y-2 pt-2">
                  {proof.links.map((link) =>
                    link.external ? (
                      <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="link-draw type-label text-gold">
                        {link.label}
                      </a>
                    ) : (
                      <Link key={link.label} href={link.href} className="link-draw type-label text-gold">
                        {link.label}
                      </Link>
                    ),
                  )}
                </p>
              </Reveal>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
