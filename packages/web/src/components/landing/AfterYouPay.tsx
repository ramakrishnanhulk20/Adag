"use client";

import "./landing.css";
import Link from "next/link";
import { motion } from "motion/react";
import { Hallmark } from "@/components/Hallmark";
import { Reveal } from "./Reveal";

type Part = {
  id: string;
  title: string;
  body: string;
  // One line worth saying twice, set apart like a callout.
  keyLine?: string;
  after?: string;
  link: { label: string; href: string };
  glyph: React.ReactNode;
};

const draw = {
  hidden: { pathLength: 0, opacity: 0 },
  shown: (i: number) => ({ pathLength: 1, opacity: 1, transition: { duration: 1.1, ease: [0.16, 1, 0.3, 1] as const, delay: 0.15 + i * 0.12 } }),
};

// Hand-drawn marks, one per part, drawn in as the plate scrolls into view.
function Glyph({ children }: { children: React.ReactNode }) {
  return (
    <motion.svg
      viewBox="0 0 48 48"
      width="48"
      height="48"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="after-glyph text-gold"
      initial="hidden"
      whileInView="shown"
      viewport={{ once: true, amount: 0.6 }}
    >
      {children}
    </motion.svg>
  );
}

const PARTS: Part[] = [
  {
    id: "guard",
    title: "The loan guard",
    body: "When a loan crosses a line you choose, the guard repays part of it from your own USDC or EURC, just enough to bring it back to your target.",
    keyLine: "The most this can ever take is your approval.",
    after: "Stop any time: the rule clears and the approval goes to 0.",
    link: { label: "How the loan guard works", href: "/docs/loan-guard" },
    glyph: (
      <Glyph>
        <motion.path d="M4 16h40" strokeDasharray="2 3" variants={draw} custom={0} />
        <motion.path d="M4 38c6 0 9-4 13-12s6-14 10-14 4 10 8 14 6 4 9 4" variants={draw} custom={1} />
        <motion.path d="M31 22v8m-3-3 3 3 3-3" variants={draw} custom={2} />
      </Glyph>
    ),
  },
  {
    id: "alerts",
    title: "Telegram alerts",
    body: "A message when a loan gets close to a level you set, and one each time the guard repays. Adag never tells anyone else whether a wallet has alerts.",
    link: { label: "How alerts work", href: "/docs/alerts" },
    glyph: (
      <Glyph>
        <motion.path d="M6 23 42 8 34 40 22 30 6 23Z" variants={draw} custom={0} />
        <motion.path d="M42 8 22 30v10l6-7" variants={draw} custom={1} />
      </Glyph>
    ),
  },
  {
    id: "safe",
    title: "Pay from a company Safe",
    body: "One bill or up to ten, proposed to the Safe and signed by its owners the way they sign anything else. At execution it lands whole or not at all.",
    link: { label: "Paying from a Safe", href: "/docs/safe" },
    glyph: (
      <Glyph>
        <motion.rect x="6" y="8" width="36" height="32" rx="3" variants={draw} custom={0} />
        <motion.circle cx="24" cy="24" r="8" variants={draw} custom={1} />
        <motion.path d="M24 16v3M24 29v3M16 24h3M29 24h3" variants={draw} custom={2} />
      </Glyph>
    ),
  },
  {
    id: "record",
    title: "Already borrowing on Morpho",
    body: "Record the loan you have once. No money moves. From then on you can pay bills from cash, and Adag checks your loan against the one you recorded.",
    link: { label: "Record an existing loan", href: "/docs/getting-started#record-an-existing-loan" },
    glyph: (
      <Glyph>
        <motion.path d="M12 6h18l8 8v28H12Z" variants={draw} custom={0} />
        <motion.path d="M30 6v8h8" variants={draw} custom={1} />
        <motion.path d="M18 26l5 5 9-10" variants={draw} custom={2} />
      </Glyph>
    ),
  },
];

// After 05 on the home page: what Adag does once the bill is paid. Text only, so nothing here can go stale; every
// figure a reader might want lives on the linked page or the live app.
export function AfterYouPay({ label = "06 · After you pay" }: { label?: string }) {
  return (
    <section id="after" aria-labelledby="after-title" className="landing-section scroll-mt-20 border-t border-rule bg-bg px-5 py-24 md:px-[6vw] md:py-36">
      <div className="grid gap-14 lg:grid-cols-12 lg:gap-8">
        <div className="lg:sticky lg:top-32 lg:col-span-5 lg:self-start">
          <Reveal>
            <Hallmark>{label}</Hallmark>
          </Reveal>
          <Reveal delay={0.08}>
            <h2 id="after-title" className="type-h2 mt-8 max-w-[12ch]">
              Paid. Then <em className="whitespace-nowrap text-gold italic">looked after.</em>
            </h2>
          </Reveal>
          <Reveal delay={0.16}>
            <p className="type-lead mt-8 max-w-[38ch] text-text/88">
              Paying is where most tools stop. Adag keeps working on the loan your bitcoin backs: it repays part when the loan crosses your
              line, tells you on Telegram, and pays from the company Safe your treasury already lives in.
            </p>
          </Reveal>
        </div>
        <ol className="grid gap-px bg-rule lg:col-span-7 lg:grid-cols-2">
          {PARTS.map((part, i) => (
            <li key={part.id} data-after={part.id} className="after-plate group bg-bg">
              <Reveal delay={0.06 * i} className="flex h-full flex-col gap-5 py-9 lg:px-8 lg:py-10">
                <div className="flex items-start justify-between gap-6">
                  {part.glyph}
                  <span className="type-label text-muted transition-colors duration-200 group-hover:text-gold">{String(i + 1).padStart(2, "0")}</span>
                </div>
                <h3 className="type-h3 max-w-[16ch]">{part.title}</h3>
                <p className="type-body max-w-[40ch] text-muted">{part.body}</p>
                {part.keyLine && <p className="after-key type-body text-text">{part.keyLine}</p>}
                {part.after && <p className="type-body max-w-[40ch] text-muted">{part.after}</p>}
                <Link href={part.link.href} className="link-draw tap-target type-label mt-auto self-start text-gold">
                  {part.link.label}
                </Link>
              </Reveal>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
