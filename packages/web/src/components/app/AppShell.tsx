import "./app.css";
import { ADAG_BILLS, EXPLORER } from "@/lib/pay/constants";
import { AppNav } from "./AppNav";

export function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AppNav />
      <main className="relative isolate min-h-svh overflow-x-clip pt-14 md:pt-[72px]">
        <div aria-hidden="true" className="app-light" />
        <div aria-hidden="true" className="app-rule-grid hidden md:block" />
        {children}
      </main>
      <AppFooter />
    </>
  );
}

function AppFooter() {
  return (
    <footer className="border-t border-rule px-5 py-10 md:px-[6vw]">
      <div className="flex flex-col gap-6 md:flex-row md:items-end md:justify-between">
        <div>
          <p className="font-display text-[22px] font-semibold tracking-[0.08em] text-text">ADAG</p>
          <p className="type-body mt-2 max-w-[34rem] text-muted">Bills on Arc mainnet, paid from balance or from a loan against pledged bitcoin.</p>
        </div>
        <div className="flex flex-col gap-3 md:items-end">
          <a
            href="https://morpho.org"
            target="_blank"
            rel="noopener noreferrer"
            className="type-label inline-flex items-center gap-2 text-text transition-colors duration-200 hover:text-gold"
          >
            <span aria-hidden="true" className="diamond" />
            Powered by Morpho
          </a>
          <a
            href={`${EXPLORER}/address/${ADAG_BILLS}`}
            target="_blank"
            rel="noopener noreferrer"
            className="link-draw type-address text-muted transition-colors duration-200 hover:text-text"
          >
            AdagBills {ADAG_BILLS}
          </a>
        </div>
      </div>
    </footer>
  );
}
