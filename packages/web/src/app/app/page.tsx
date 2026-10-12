import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import { AppShell } from "@/components/app/AppShell";
import { WalletPage } from "@/components/app/WalletPage";

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta.wallet");
  return { title: t("title"), description: t("description"), robots: { index: false, follow: false } };
}

export default function WalletRoute() {
  return (
    <AppShell>
      <WalletPage />
    </AppShell>
  );
}
