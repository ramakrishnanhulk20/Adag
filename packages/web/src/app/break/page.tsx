import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { BreakPage } from "@/components/break/BreakPage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta.break");
  return { title: t("title"), description: t("description") };
}

export default function BreakRoute() {
  return (
    <main>
      <BreakPage />
    </main>
  );
}
