import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AppShell } from "@/components/app/AppShell";
import { ProtectPage } from "@/components/guard/ProtectPage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta.protect");
  return { title: t("title"), description: t("description"), robots: { index: false, follow: false } };
}

export default function ProtectRoute() {
  return (
    <AppShell>
      <ProtectPage />
    </AppShell>
  );
}
