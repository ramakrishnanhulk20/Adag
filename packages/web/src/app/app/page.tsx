import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { WalletPage } from "@/components/app/WalletPage";

export const metadata: Metadata = {
  title: "Your wallet · Adag",
  description: "The bills you wrote, the bills you paid, and your loans against cirBTC on Morpho, read live from Arc.",
  robots: { index: false, follow: false },
};

export default function WalletRoute() {
  return (
    <AppShell>
      <WalletPage />
    </AppShell>
  );
}
