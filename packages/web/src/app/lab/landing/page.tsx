import type { Metadata } from "next";
import { Hero } from "@/components/hero/Hero";
import { LiveData } from "@/components/hero/LiveData";
import { CloseAndFooter } from "@/components/landing/CloseAndFooter";
import { FortyLine } from "@/components/landing/FortyLine";
import { ForSuppliers } from "@/components/landing/ForSuppliers";
import { Ledger } from "@/components/landing/Ledger";
import { OneSignature } from "@/components/landing/OneSignature";
import { PledgedNotSold } from "@/components/landing/PledgedNotSold";
import { PledgePlaceholder } from "@/components/landing/PledgePlaceholder";

export const metadata: Metadata = {
  title: "Landing · Adag lab",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

// On /lab every page a button opens is still to be built, so actions explain themselves instead of navigating.
const PENDING = true;

export default function LandingLabPage() {
  return (
    <main>
      <Hero pending={PENDING} />
      {/* The hero keeps its own live-data reader; this second one is answered from the route's 15-second cache. */}
      <LiveData>
        <PledgedNotSold />
        <PledgePlaceholder />
        <OneSignature />
        <FortyLine pending={PENDING} />
        <ForSuppliers pending={PENDING} />
        <Ledger />
        <CloseAndFooter pending={PENDING} />
      </LiveData>
    </main>
  );
}
