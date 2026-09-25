import type { CSSProperties } from "react";
import type { Metadata } from "next";
import { Hallmark } from "@/components/Hallmark";
import { AppShell } from "@/components/app/AppShell";
import { ADAG_BILLS, EXPLORER } from "@/lib/pay/constants";

export const metadata: Metadata = {
  title: "Terms of Use · Adag",
  description: "The plain-English terms for using Adag, an interface to immutable bill contracts on Arc mainnet.",
};

const d = (n: number) => ({ "--d": n }) as CSSProperties;

// Set once the repository is public; until then the documents are named by their path in the repository.
const REPO_URL = process.env.NEXT_PUBLIC_REPO_URL;

const DOCS = [
  { label: "Threat model and the standards the app is held to", path: "docs/security/threat-model.md" },
  { label: "Attack suite simulated against the deployed contract", path: "packages/contracts/deployments/attacks-2026-09-25.md" },
  { label: "Static analysis results", path: "packages/contracts/analysis/STATIC-ANALYSIS.md" },
];

function DocLink({ label, path }: { label: string; path: string }) {
  return (
    <li className="flex flex-col gap-1 border-t border-rule py-4 md:flex-row md:items-baseline md:justify-between md:gap-6">
      <span className="type-body text-text">{label}</span>
      {REPO_URL ? (
        <a href={`${REPO_URL}/blob/main/${path}`} target="_blank" rel="noopener noreferrer" className="link-draw type-address break-all text-muted hover:text-gold">
          {path}
        </a>
      ) : (
        <span className="type-address break-all text-muted">{path}</span>
      )}
    </li>
  );
}

const SECTIONS: { title: string; body: React.ReactNode }[] = [
  {
    title: "What Adag is",
    body: (
      <>
        Adag is a website that talks to one smart contract, AdagBills, on Arc mainnet. The contract is immutable: it has no owner and no
        admin key, and no one, including the people who built it, can pause it, upgrade it or change its rules. The website is only an
        interface to it.
      </>
    ),
  },
  {
    title: "You sign everything",
    body: (
      <>
        Every payment, loan and cancellation is a transaction you review and sign in your own wallet. Adag never holds your money, never
        holds your keys, and cannot move anything without your signature. The contract passes the exact bill amount from the payer to the
        supplier within the same transaction and keeps nothing.
      </>
    ),
  },
  {
    title: "Borrowing can end in liquidation",
    body: (
      <>
        Paying from bitcoin pledges your cirBTC on Morpho and borrows the bill amount against it. If bitcoin&apos;s price falls far enough,
        Morpho can liquidate the loan and sell part of your pledge. Adag refuses a payment that would leave the loan above 40% of your
        bitcoin&apos;s value, but it checks this only at the moment you pay. After that, interest and price keep moving, Adag does not watch
        the loan, and Morpho can liquidate once the loan reaches 86%. Watching and repaying the loan is up to you.
      </>
    ),
  },
  {
    title: "Tokens carry their issuers' risks",
    body: (
      <>
        USDC, EURC and cirBTC are issued by third parties who can freeze addresses, pause transfers or change how their tokens behave. If
        they do, a payment can fail or funds can become stuck. Adag cannot override any of that.
      </>
    ),
  },
  {
    title: "No audit beyond our own review",
    body: (
      <>
        The contract has not had a paid third-party audit. What exists is published: a threat model, a self-review with an attack suite simulated
        against the deployed contract on live mainnet state, and static analysis. The contract source is verified on the{" "}
        <a href={`${EXPLORER}/address/${ADAG_BILLS}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold">
          Arc explorer
        </a>
        .
      </>
    ),
  },
  {
    title: "Not advice, not affiliated",
    body: (
      <>
        Nothing on this site is financial, legal or tax advice. Adag is an independent project. It is not affiliated with, endorsed by or
        operated by Circle, Arc or Morpho.
      </>
    ),
  },
  {
    title: "Use at your own risk",
    body: (
      <>
        Adag is provided as it is, with no warranty of any kind. You use it at your own risk, and you are responsible for checking every
        bill, every address and every transaction before you sign.
      </>
    ),
  },
];

export default function TermsPage() {
  return (
    <AppShell>
      <section className="relative px-5 pt-14 pb-24 md:px-[6vw] md:pt-[12vh]">
        <div className="app-rise" style={d(0)}>
          <Hallmark>Terms of Use · Adag</Hallmark>
        </div>
        <h1 className="app-title app-rise mt-6 max-w-[12ch] text-text" style={d(1)}>
          The plain <em className="font-semibold text-gold italic">terms</em>.
        </h1>
        <p className="type-lead app-rise mt-8 max-w-[40rem] text-text/88" style={d(2)}>
          Short, because the contract does the talking. By using this website you accept the terms below.
        </p>

        <ol className="mt-16 grid gap-x-16 md:mt-24 md:grid-cols-12">
          {SECTIONS.map((s, i) => (
            <li key={s.title} className="app-rise border-t border-rule py-8 md:col-span-10 md:grid md:grid-cols-10 md:gap-8 md:py-10" style={d(3 + i)}>
              <p className="type-micro text-gold md:col-span-1">{String(i + 1).padStart(2, "0")}</p>
              <h2 className="type-h4 mt-2 text-text md:col-span-3 md:mt-0">{s.title}</h2>
              <p className="type-body mt-4 max-w-[40rem] text-text/88 md:col-span-6 md:mt-0">{s.body}</p>
            </li>
          ))}
        </ol>

        <div className="app-rise mt-6 md:max-w-[83%]" style={d(10)}>
          <p className="type-label text-muted">The published review</p>
          <ul className="mt-4 border-b border-rule">
            {DOCS.map((doc) => (
              <DocLink key={doc.path} {...doc} />
            ))}
          </ul>
        </div>
      </section>
    </AppShell>
  );
}
