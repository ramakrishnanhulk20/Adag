import type { Metadata } from "next";
import { AppShell } from "@/components/app/AppShell";
import { WriteBill } from "@/components/app/WriteBill";

export const metadata: Metadata = {
  title: "Write a bill · Adag",
  description: "Write a bill on Arc in USDC or EURC, payable to your wallet exactly once, and share its link.",
};

export default function WriteBillPage() {
  return (
    <AppShell>
      <WriteBill />
    </AppShell>
  );
}
