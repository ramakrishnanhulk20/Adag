import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AppShell } from "@/components/app/AppShell";
import { WriteBill } from "@/components/app/WriteBill";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta.write");
  return { title: t("title"), description: t("description") };
}

export default function WriteBillPage() {
  return (
    <AppShell>
      <WriteBill />
    </AppShell>
  );
}
