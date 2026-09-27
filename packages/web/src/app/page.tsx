import type { Metadata } from "next";
import { Hero } from "@/components/hero/Hero";
import { LiveData } from "@/components/hero/LiveData";
import { AfterYouPay } from "@/components/landing/AfterYouPay";
import { AnchorKeeper } from "@/components/landing/AnchorKeeper";
import { CheckIt } from "@/components/landing/CheckIt";
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
    "Pay your suppliers from your company's bitcoin without selling it: up to 10 bills in one signature on Arc, invoice numbers attached, and a loan Adag caps at 40%.",
  alternates: { canonical: "/" },
};

export default function Home() {
  return (
    <main>
      <AnchorKeeper />
      <Hero />
      {/* The hero keeps its own live-data reader; this second one is answered from the route's 15-second cache. */}
      <LiveData>
        <PledgedNotSold />
        <PledgeStage />
        <OneSignature />
        <FortyLine />
        <CheckIt />
        <AfterYouPay />
        <ForSuppliers />
        <Ledger />
        <CloseAndFooter />
      </LiveData>
    </main>
  );
}
