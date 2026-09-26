import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { ProtectPage } from "@/components/guard/ProtectPage";

export const metadata: Metadata = {
  title: "Loan guard and alerts",
  description: "Telegram alerts for your loans against cirBTC, and the loan guard that repays before Morpho's line.",
  robots: { index: false, follow: false },
};

export default function ProtectRoute() {
  return (
    <AppShell>
      <ProtectPage />
    </AppShell>
  );
}
