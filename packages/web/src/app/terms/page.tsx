import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Hallmark } from "@/components/Hallmark";
import { AppShell } from "@/components/app/AppShell";
import { CONTRACTS } from "@/components/landing/contracts";
import { getLocale } from "@/i18n/server";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta.terms");
  return { title: t("title"), description: t("description") };
}

const d = (n: number) => ({ "--d": n }) as CSSProperties;

// Set once the repository is public; until then the documents are named by their path in the repository.
const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL;

const DOCS = [
  { key: "threatModel", path: "docs/security/threat-model.md" },
  { key: "attackSuite", path: "packages/contracts/deployments/attacks-2026-09-25.md" },
  { key: "staticAnalysis", path: "packages/contracts/analysis/STATIC-ANALYSIS.md" },
] as const;

function DocLink({ label, path }: { label: string; path: string }) {
  return (
    <li className="flex flex-col gap-1 border-t border-rule py-4 md:flex-row md:items-baseline md:justify-between md:gap-6">
      <span className="type-body text-text">{label}</span>
      {REPO_URL ? (
        <a href={`${REPO_URL}/blob/main/${path}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address break-all text-muted hover:text-gold">
          {path}
        </a>
      ) : (
        <span className="type-address break-all text-muted">{path}</span>
      )}
    </li>
  );
}

const SECTIONS = ["whatAdagIs", "youSign", "liquidation", "tokens", "noAudit", "notAdvice", "ownRisk"] as const;

export default async function TermsPage() {
  const [t, tc, locale] = await Promise.all([getTranslations("terms"), getTranslations("common"), getLocale()]);
  // The contract names and their explorer links, spelled out like "AdagBills, AdagGuard and AdagBills, first deployment".
  const contractLinks = CONTRACTS.map((c, i) => (
    <span key={c.address}>
      {i > 0 ? (i === CONTRACTS.length - 1 ? t("and") : ", ") : null}
      <a href={c.explorer} target="_blank" rel="noopener noreferrer" className="link-draw text-gold">
        {tc(`contractNames.${c.key}`)}
      </a>
    </span>
  ));
  return (
    <AppShell>
      <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[12vh]">
        <div className="app-rise" style={d(0)}>
          <Hallmark>{t("hallmark")}</Hallmark>
        </div>
        <h1 className="app-title app-rise mt-6 max-w-[12ch] text-text" style={d(1)}>
          {t.rich("title", { em: (chunks) => <em className="font-semibold text-gold italic">{chunks}</em> })}
        </h1>
        <p className="type-lead app-rise mt-8 max-w-[40rem] text-text/88" style={d(2)}>
          {t("lead")}
        </p>
        {locale !== "en" && (
          <p className="type-body app-rise mt-4 max-w-[40rem] text-muted" style={d(2)} lang={locale} data-terms-english>
            {t("englishApplies")}
          </p>
        )}

        <ol className="mt-16 grid gap-x-16 md:mt-24 md:grid-cols-12">
          {SECTIONS.map((key, i) => (
            <li key={key} className="app-rise border-t border-rule py-8 md:col-span-10 md:grid md:grid-cols-10 md:gap-8 md:py-10" style={d(3 + i)}>
              <p className="type-micro text-gold md:col-span-1">{String(i + 1).padStart(2, "0")}</p>
              <h2 className="type-h4 mt-2 text-text md:col-span-3 md:mt-0">{t(`sections.${key}.title`)}</h2>
              <p className="type-body mt-4 max-w-[40rem] text-text/88 md:col-span-6 md:mt-0">
                {key === "noAudit" ? t.rich("sections.noAudit.body", { contracts: () => <>{contractLinks}</> }) : t(`sections.${key}.body`)}
              </p>
            </li>
          ))}
        </ol>

        <div className="app-rise mt-6 md:max-w-[83%]" style={d(10)}>
          <p className="type-label text-muted">{t("publishedReview")}</p>
          <ul className="mt-4 border-b border-rule">
            {DOCS.map((doc) => (
              <DocLink key={doc.path} label={t(`docs.${doc.key}`)} path={doc.path} />
            ))}
          </ul>
        </div>
      </section>
    </AppShell>
  );
}
