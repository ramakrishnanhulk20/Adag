import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { Hallmark } from "@/components/Hallmark";
import { AppShell } from "@/components/app/AppShell";
import { PayForm } from "@/components/app/PayForm";
import { readTotalBillCount } from "@/lib/pay/read";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta.pay");
  return { title: t("title"), description: t("description") };
}

export const dynamic = "force-dynamic";

export default async function PayPage() {
  const [count, t, tc] = await Promise.all([readTotalBillCount(), getTranslations("pay"), getTranslations("common")]);

  return (
    <AppShell>
      <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[14vh] md:pb-[18vh]">
        <div
          aria-hidden="true"
          className="app-watermark absolute right-[4vw] top-[8vh] -z-10 invisible text-[clamp(14rem,30vw,32rem)] md:visible"
        >
          <span className="app-watermark-sign">№</span>
          {count.ok ? count.total.toString() : ""}
        </div>

        <div className="app-rise" style={{ "--d": 0 } as React.CSSProperties}>
          <Hallmark>{t("hallmark")}</Hallmark>
        </div>
        <h1 className="app-title app-rise mt-6 max-w-[11ch] text-text" style={{ "--d": 1 } as React.CSSProperties}>
          {t.rich("title", { em: (chunks) => <em className="font-semibold text-gold italic">{chunks}</em> })}
        </h1>
        <p className="type-lead app-rise mt-6 max-w-[40rem] text-text/88 md:mt-8" style={{ "--d": 2 } as React.CSSProperties}>
          {t("lead")}
        </p>

        <div className="app-rise mt-10 md:mt-14" style={{ "--d": 3 } as React.CSSProperties}>
          <PayForm />
        </div>

        <div className="app-rise mt-6 flex items-baseline gap-4 border-t border-rule pt-6 md:mt-10 md:max-w-[44rem]" style={{ "--d": 4 } as React.CSSProperties}>
          <span className={count.ok ? "type-number text-text" : "type-label text-muted"}>{count.ok ? count.total.toString() : tc("unavailable")}</span>
          <span className="type-body text-muted">
            {count.ok
              ? t("countNote", { count: Number(count.total), current: count.current.toString(), first: count.first.toString() })
              : t("countUnknown")}
          </span>
        </div>
      </section>
    </AppShell>
  );
}
