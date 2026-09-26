import type { Metadata } from "next";
import { BillRoute, billMetadata } from "../../BillRoute";

// Bills on the first AdagBills deployment. Every visit reads the chain; a cached page could show a paid bill as open.
export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  return billMetadata(["first", (await params).id]);
}

export default async function FirstDeploymentBillPage({ params }: Params) {
  return <BillRoute segments={["first", (await params).id]} />;
}
