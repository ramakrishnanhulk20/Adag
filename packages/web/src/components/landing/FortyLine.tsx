import "./landing.css";
import Link from "next/link";
import { getTranslations } from "next-intl/server";
import { Hallmark } from "@/components/Hallmark";
import { CONTRACTS, CURRENT_BILLS } from "./contracts";
import { FortyGauge } from "./FortyGauge";
import { Reveal } from "./Reveal";

const CONTRACT = CURRENT_BILLS.explorer;

// Section 5: the pinned 40% while the facts scroll past. Reduced motion drops the pin and shows everything at once.
export async function FortyLine() {
  const t = await getTranslations("landing.forty");
  const tc = await getTranslations("common");
  const facts: { key: "noOwner" | "neverHolds" | "verified" | "refuses"; links: { label: string; href: string; internal?: boolean }[] }[] = [
    { key: "noOwner", links: [{ label: t("links.contractOnArc"), href: CONTRACT }] },
    { key: "neverHolds", links: [{ label: t("links.tokenBalances"), href: `${CONTRACT}?tab=tokens` }] },
    {
      key: "verified",
      links: CONTRACTS.flatMap((c) => [
        { label: t("links.onSourcify", { name: tc(`contractNames.${c.key}`) }), href: c.sourcify },
        { label: t("links.onExplorer", { name: tc(`contractNames.${c.key}`) }), href: `${c.explorer}?tab=contract` },
      ]),
    },
    { key: "refuses", links: [{ label: tc("tryToBreakIt"), href: "/break", internal: true }] },
  ];
  return (
    <section id="safety" aria-labelledby="safety-title" className="landing-section scroll-mt-20 border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <div className="grid gap-16 md:grid-cols-12 md:gap-8">
        <div className="md:sticky md:top-24 md:col-span-6 md:self-start motion-reduce:md:static">
          <Reveal>
            <Hallmark>{t("label")}</Hallmark>
          </Reveal>
          <Reveal delay={0.08}>
            <h2 id="safety-title" className="sr-only">
              {t("title")}
            </h2>
            <p aria-hidden="true" className="type-pinned mt-6 text-gold">
              40%
            </p>
          </Reveal>
          <Reveal delay={0.16} className="mt-6 max-w-[34rem]">
            <p className="type-lead mb-8 max-w-[34ch] text-text/88">{t("lead")}</p>
            <FortyGauge />
          </Reveal>
        </div>
        <ol className="flex flex-col gap-16 md:col-span-5 md:col-start-8 md:gap-[38vh] md:pt-[30vh] md:pb-[20vh] motion-reduce:md:gap-16 motion-reduce:md:pt-0 motion-reduce:md:pb-0">
          {facts.map((fact, i) => (
            <li key={fact.key}>
              <Reveal>
                <p className="type-label text-gold">{String(i + 1).padStart(2, "0")}</p>
                <h3 className="type-h3 mt-4 max-w-[18ch]">{t(`facts.${fact.key}.title`)}</h3>
                <p className="type-body mt-4 max-w-[46ch] text-muted">{t(`facts.${fact.key}.body`)}</p>
                <p className="mt-2 flex flex-wrap gap-x-6">
                  {fact.links.map((link) =>
                    link.internal ? (
                      <Link key={link.label} href={link.href} className="link-draw tap-target type-label text-gold">
                        {link.label}
                      </Link>
                    ) : (
                      <a key={link.label} href={link.href} target="_blank" rel="noopener noreferrer" className="link-draw tap-target type-label text-gold">
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
