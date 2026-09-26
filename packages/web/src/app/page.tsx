import type { Metadata } from "next";
import { Hero } from "@/components/hero/Hero";
import { LiveData } from "@/components/hero/LiveData";
import { CloseAndFooter } from "@/components/landing/CloseAndFooter";
import { FortyLine } from "@/components/landing/FortyLine";
import { ForSuppliers } from "@/components/landing/ForSuppliers";
import { Ledger } from "@/components/landing/Ledger";
import { OneSignature } from "@/components/landing/OneSignature";
import { PledgedNotSold } from "@/components/landing/PledgedNotSold";
import { PledgeStage } from "@/components/pledge/PledgeStage";

export const metadata: Metadata = {
  title: { absolute: "Adag · Pay your bills with your bitcoin, without selling it" },
  description:
    "Pledge your bitcoin on Morpho, borrow exactly the bill, and pay your supplier in USDC or EURC in one signature on Arc. Adag refuses any payment that would push the loan past 40%.",
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <main>
      <Hero />
      {/* The hero keeps its own live-data reader; this second one is answered from the route's 15-second cache. */}
      <LiveData>
        <PledgedNotSold />
        <PledgeStage />
        <OneSignature />
        <FortyLine />
        <ForSuppliers />
        <Ledger />
        <CloseAndFooter />
      </LiveData>
    </main>
  );
}
