import type { CSSProperties } from "react";
import { getTranslations } from "next-intl/server";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { libTextServer } from "@/i18n/server";

const d = (n: number) => ({ "--d": n }) as CSSProperties;

type BillMissingProps =
  | { kind: "none"; id: bigint; count: bigint | null; first?: boolean }
  | { kind: "invalid"; raw: string }
  | { kind: "unavailable"; id: bigint }
  | { kind: "refused"; message: string };

// Three different truths, never merged: no such bill, not a bill number, and Arc not answering (C19).
export async function BillMissing(props: BillMissingProps) {
  const t = await getTranslations("bill.missing");
  const tc = await getTranslations("common");
  const em = (chunks: React.ReactNode) => <em className="font-semibold text-gold italic">{chunks}</em>;
  let mark = t("bill");
  let title: React.ReactNode;
  let body: string;
  if (props.kind === "none") {
    const id = props.id.toString();
    mark = props.first ? t("markFirst", { id }) : t("mark", { id });
    title = t.rich("noneTitle", { id, em });
    const where = props.first ? t("onFirstDeployment") : t("onArc");
    body = props.count === null ? t("noRecord") : props.count === 0n ? t("noneWritten", { where }) : t("newestIs", { where, count: props.count.toString() });
  } else if (props.kind === "refused") {
    title = t.rich("refusedTitle", { em });
    body = (await libTextServer())(props.message);
  } else if (props.kind === "invalid") {
    title = t.rich("invalidTitle", { em });
    body = t("invalidBody");
  } else {
    mark = t("mark", { id: props.id.toString() });
    title = t.rich("unavailableTitle", { em });
    body = t("unavailableBody");
  }

  return (
    <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[14vh] md:pb-[18vh]">
      <div className="app-rise" style={d(0)}>
        <Hallmark tone="quiet">{mark}</Hallmark>
      </div>
      <h1 className="app-title app-rise mt-6 max-w-[14ch] text-text" style={d(1)}>
        {title}
      </h1>
      <p className="type-lead app-rise mt-8 max-w-[38rem] text-text/88" style={d(2)}>
        {body}
      </p>
      <div className="app-rise mt-10 flex flex-col gap-3 md:flex-row" style={d(3)}>
        <Button href="/pay" variant="primary" className="w-full md:w-auto">
          {t("findAnother")}
        </Button>
        <Button href="/" variant="secondary" className="w-full md:w-auto">
          {tc("backToAdag")}
        </Button>
      </div>
    </section>
  );
}
