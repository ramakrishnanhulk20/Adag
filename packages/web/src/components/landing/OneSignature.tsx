import "./landing.css";
import { getTranslations } from "next-intl/server";
import { Hallmark } from "@/components/Hallmark";
import { Receipt } from "./Receipt";
import { Reveal } from "./Reveal";

const PROOF_TX = "https://explorer.arc.io/tx/0x6987964bddd7f8a8fe2a59d6de9baaa6ac37b8a720aae5900d8cb9af0eaf2292";

// Section 4: the real batch, printed like a receipt.
export async function OneSignature() {
  const t = await getTranslations("landing.oneSignature");
  return (
    <section id="how" aria-labelledby="how-title" className="landing-section scroll-mt-20 border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <div className="grid gap-14 lg:grid-cols-12 lg:gap-8">
        <div className="lg:sticky lg:top-32 lg:col-span-6 lg:self-start">
          <Reveal>
            <Hallmark>{t("label")}</Hallmark>
          </Reveal>
          <Reveal delay={0.08}>
            <h2 id="how-title" className="type-h2 mt-8 max-w-[13ch]">
              {t.rich("title", { em: (chunks) => <em className="whitespace-nowrap text-gold italic">{chunks}</em> })}
            </h2>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="type-lead mt-8 max-w-[36ch] text-text/88">{t("lead")}</p>
          </Reveal>
        </div>
        <div className="lg:col-span-6">
          <Reveal>
            <Receipt />
          </Reveal>
          <Reveal delay={0.08} className="mt-12 flex flex-col gap-2">
            <p className="type-h3 max-w-[22ch]">{t("ifAnyFails")}</p>
            <a href={PROOF_TX} target="_blank" rel="noopener noreferrer" className="link-draw tap-target type-label self-start text-gold">
              {t("seeTheRealOne")}
            </a>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
