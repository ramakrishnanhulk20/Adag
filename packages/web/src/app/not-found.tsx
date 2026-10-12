import type { CSSProperties } from "react";
import { getTranslations } from "next-intl/server";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/Button";

const d = (n: number) => ({ "--d": n }) as CSSProperties;

export default async function NotFound() {
  const t = await getTranslations("notFound");
  const tc = await getTranslations("common");
  return (
    <AppShell>
      <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[14vh] md:pb-[18vh]">
        <p className="type-label app-rise text-gold" style={d(0)}>
          {t("label")}
        </p>
        <h1 className="type-h2 app-rise mt-6 text-text" style={d(1)}>
          {t.rich("title", { em: (chunks) => <em className="font-semibold text-gold italic">{chunks}</em> })}
        </h1>
        <p className="type-body app-rise mt-6 max-w-[38rem] text-muted md:mt-8" style={d(2)}>
          {t("body")}
        </p>
        <div className="app-rise mt-10 flex flex-col gap-3 md:flex-row" style={d(3)}>
          <Button href="/" variant="primary" className="w-full md:w-auto">
            {t("backHome")}
          </Button>
          <Button href="/pay" variant="secondary" className="w-full md:w-auto">
            {tc("payABill")}
          </Button>
          <Button href="/docs" variant="secondary" className="w-full md:w-auto">
            {t("readTheDocs")}
          </Button>
        </div>
      </section>
    </AppShell>
  );
}
