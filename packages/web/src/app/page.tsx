import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
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

export async function generateMetadata(): Promise<Metadata> {
  const t = await getTranslations("meta.home");
  return { title: { absolute: t("title") }, description: t("description"), alternates: { canonical: "/" } };
}

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
