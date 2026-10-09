import type { CSSProperties } from "react";
import { AppShell } from "@/components/app/AppShell";
import { Button } from "@/components/Button";

const d = (n: number) => ({ "--d": n }) as CSSProperties;

export default function NotFound() {
  return (
    <AppShell>
      <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[14vh] md:pb-[18vh]">
        <p className="type-label app-rise text-gold" style={d(0)}>
          404 · NOT ON ADAG
        </p>
        <h1 className="type-h2 app-rise mt-6 text-text" style={d(1)}>
          This page is <em className="font-semibold text-gold italic">not on Adag</em>.
        </h1>
        <p className="type-body app-rise mt-6 max-w-[38rem] text-muted md:mt-8" style={d(2)}>
          The address may be mistyped, or the bill may live on a different contract.
        </p>
        <div className="app-rise mt-10 flex flex-col gap-3 md:flex-row" style={d(3)}>
          <Button href="/" variant="primary" className="w-full md:w-auto">
            Back to the home page
          </Button>
          <Button href="/pay" variant="secondary" className="w-full md:w-auto">
            Pay a bill
          </Button>
          <Button href="/docs" variant="secondary" className="w-full md:w-auto">
            Read the docs
          </Button>
        </div>
      </section>
    </AppShell>
  );
}
