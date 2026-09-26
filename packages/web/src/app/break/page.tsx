import type { Metadata } from "next";
import { BreakPage } from "@/components/break/BreakPage";

export const metadata: Metadata = {
  title: "Try to break it",
  description: "Sixteen real attacks on Adag's live contract, simulated on Arc mainnet's current state. Nothing is signed or sent.",
};

export default function BreakRoute() {
  return (
    <main>
      <BreakPage />
    </main>
  );
}
