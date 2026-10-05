import type { Metadata } from "next";
import { MarkHallmarkBtc, MarkHallmarkBtcTab, MarkSeal, MarkStampedCoin, MarkToday } from "./_marks";

export const metadata: Metadata = {
  title: "Lab: logo",
  robots: { index: false, follow: false, nocache: true, googleBot: { index: false, follow: false } },
};

const INK = "#0D0B08";
const PAPER = "#F2EDE3";
const MUTED = "#A39B8C";
const RULE = "#2E2920";
const GOLD_ON_DARK = "#D9A94A";
const GOLD_MID = "#B07A22";

const SYSTEM_SANS = 'system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif';
const GITHUB_SANS = '-apple-system, BlinkMacSystemFont, "Segoe UI", "Noto Sans", Helvetica, Arial, sans-serif';

const TAB_TITLE = "Adag: pay your bills with bitcoin";
const README_LINE = "Pay your bills with your bitcoin, without selling it.";

type MarkComponent = typeof MarkToday;

const MARKS: { id: string; letter?: string; name: string; story: React.ReactNode; Mark: MarkComponent }[] = [
  { id: "today", name: "Today", story: "The hallmark frame around a gold coin.", Mark: MarkToday },
  {
    id: "seal",
    letter: "A",
    name: "Seal",
    story: (
      <>
        <span lang="ta">அ</span>, the first letter of <span lang="ta">அடகு</span>, cut from a gold seal: the name&apos;s own story.
      </>
    ),
    Mark: MarkSeal,
  },
  {
    id: "hallmark",
    letter: "B",
    name: "Hallmark",
    story: "Today's frame, bolder, with the coin stamped as bitcoin: the bitcoin stays inside the pledge.",
    Mark: MarkHallmarkBtc,
  },
  {
    id: "stamped-coin",
    letter: "C",
    name: "Stamped coin",
    story: "A gold coin minted with Adag's A, the way pledged gold is weighed and stamped.",
    Mark: MarkStampedCoin,
  },
];

function labelOf(mark: (typeof MARKS)[number]): string {
  return mark.letter ? `${mark.letter} ${mark.name}` : mark.name;
}

function Row({ title, note, children }: { title: string; note: string; children: React.ReactNode }) {
  return (
    <section className="border-t py-14 md:py-20" style={{ borderColor: RULE }}>
      <div className="mb-10 flex flex-col gap-3 md:mb-14 md:flex-row md:items-baseline md:justify-between md:gap-12">
        <h2 className="type-label" style={{ color: GOLD_ON_DARK }}>
          {title}
        </h2>
        <p className="type-micro max-w-[60ch] md:text-right" style={{ color: MUTED }}>
          {note}
        </p>
      </div>
      {children}
    </section>
  );
}

function CellLabel({ children }: { children: React.ReactNode }) {
  return (
    <p className="type-micro mb-4" style={{ color: MUTED }}>
      {children}
    </p>
  );
}

function ChromeTab({ mode, Mark }: { mode: "dark" | "light"; Mark: MarkComponent }) {
  const dark = mode === "dark";
  const bar = dark ? "#202124" : "#dee1e6";
  const tab = dark ? "#35363a" : "#ffffff";
  const text = dark ? "#e8eaed" : "#1f1f1f";
  const omnibox = dark ? "#202124" : "#f1f3f4";
  const closeColour = dark ? "#9aa0a6" : "#5f6368";

  return (
    <div style={{ background: bar, width: 264, fontFamily: SYSTEM_SANS }} className="shrink-0 select-none overflow-hidden rounded-md px-3 pt-2.5">
      <div
        style={{ background: tab, width: 240, height: 34, borderRadius: "8px 8px 0 0", color: text }}
        className="flex items-center gap-2 pr-2 pl-3"
      >
        <Mark size={16} gold={dark ? GOLD_ON_DARK : GOLD_MID} />
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap" style={{ fontSize: 12, lineHeight: "16px" }}>
          {TAB_TITLE}
        </span>
        <svg width={16} height={16} viewBox="0 0 16 16" aria-hidden="true" style={{ flexShrink: 0 }}>
          <path d="M4.5 4.5l7 7m0-7l-7 7" stroke={closeColour} strokeWidth={1.2} strokeLinecap="round" fill="none" />
        </svg>
      </div>
      <div style={{ background: tab, height: 32 }} className="-mx-3 flex items-center px-3">
        <div style={{ background: omnibox, height: 20 }} className="w-full rounded-full" />
      </div>
    </div>
  );
}

const TAB_SIZE_CUTS: { name: string; Mark: MarkComponent }[] = [
  { name: "Full mark", Mark: MarkHallmarkBtc },
  { name: "Tab cut", Mark: MarkHallmarkBtcTab },
];

function TabSizePanel({ mode }: { mode: "dark" | "light" }) {
  const dark = mode === "dark";
  const gold = dark ? GOLD_ON_DARK : GOLD_MID;
  return (
    <div
      className="flex flex-col gap-8 rounded-md px-6 py-8 sm:flex-row sm:gap-16"
      style={{
        background: dark ? "#35363a" : "#ffffff",
        color: dark ? "#e8eaed" : "#1f1f1f",
        fontFamily: SYSTEM_SANS,
      }}
    >
      {TAB_SIZE_CUTS.map(({ name, Mark }) => (
        <div key={name}>
          <p style={{ fontSize: 12, lineHeight: "16px", marginBottom: 16 }}>{name}</p>
          <div className="flex items-end gap-6">
            <Mark size={16} gold={gold} />
            <Mark size={32} gold={gold} />
          </div>
        </div>
      ))}
    </div>
  );
}

function ReadmePanel({ mode, Mark }: { mode: "dark" | "light"; Mark: MarkComponent }) {
  const light = mode === "light";
  return (
    <div
      className="flex flex-col items-center px-6 py-9 text-center"
      style={{
        background: light ? "#ffffff" : "#0d1117",
        color: light ? "#1f2328" : "#e6edf3",
        border: `1px solid ${light ? "#d1d9e0" : "#30363d"}`,
        borderRadius: 6,
        fontFamily: GITHUB_SANS,
      }}
    >
      <Mark size={88} gold={GOLD_MID} />
      <div style={{ fontSize: 32, fontWeight: 700, lineHeight: 1.25, marginTop: 16 }}>Adag</div>
      <p style={{ fontSize: 16, lineHeight: 1.5, marginTop: 8 }}>{README_LINE}</p>
    </div>
  );
}

function PhoneScreen({ Mark }: { Mark: MarkComponent }) {
  return (
    <div
      className="flex flex-col items-center gap-2 rounded-2xl px-4 py-9"
      style={{ background: "linear-gradient(160deg, #3b4054 0%, #1b1d29 100%)", fontFamily: SYSTEM_SANS }}
    >
      <div
        className="flex items-center justify-center"
        style={{
          width: 180,
          height: 180,
          borderRadius: "22%",
          background: INK,
          boxShadow: "0 10px 28px rgba(0, 0, 0, 0.45), inset 0 0 0 1px rgba(255, 255, 255, 0.07)",
        }}
      >
        <Mark size={120} gold={GOLD_ON_DARK} />
      </div>
      <span style={{ fontSize: 12, color: "#ffffff", textShadow: "0 1px 3px rgba(0, 0, 0, 0.5)" }}>Adag</span>
    </div>
  );
}

export default function MarkLabPage() {
  return (
    <main className="relative isolate min-h-screen overflow-x-clip px-5 pb-24 md:px-[6vw]" style={{ background: INK, color: PAPER }}>
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-48 -right-40 -z-10 h-[640px] w-[640px]"
        style={{ background: "radial-gradient(closest-side, rgba(217, 169, 74, 0.16), transparent)" }}
      />
      <header className="relative pt-16 pb-14 md:pt-28 md:pb-20">
        <h1
          className="relative font-display font-semibold"
          style={{ fontSize: "clamp(3.5rem, 11vw, 10rem)", lineHeight: 0.9, letterSpacing: "-0.03em" }}
        >
          Logo <em className="italic" style={{ color: GOLD_ON_DARK }}>options</em>
        </h1>
      </header>

      <ul className="grid grid-cols-1 gap-x-8 gap-y-14 md:grid-cols-2 xl:grid-cols-4">
        {MARKS.map((entry) => (
          <li key={entry.id} className="border-t pt-8" style={{ borderColor: RULE }}>
            <entry.Mark size={144} gold={GOLD_ON_DARK} title={`${labelOf(entry)} logo`} />
            <h2 className="mt-8 font-display font-semibold" style={{ fontSize: "clamp(1.75rem, 2.2vw, 2.5rem)", lineHeight: 1, letterSpacing: "-0.01em" }}>
              {entry.letter ? (
                <>
                  <span style={{ color: GOLD_ON_DARK }}>{entry.letter}</span> {entry.name}
                </>
              ) : (
                entry.name
              )}
            </h2>
            <p className="type-body mt-4 max-w-[34ch]" style={{ color: MUTED }}>
              {entry.story}
            </p>
          </li>
        ))}
      </ul>

      <div className="mt-20 md:mt-28">
        <Row title="B at tab size" note="The tab cut is what the browser tab uses. The full mark is for everything larger.">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <TabSizePanel mode="dark" />
            <TabSizePanel mode="light" />
          </div>
        </Row>

        <Row title="Browser tab, real size" note="16 by 16 CSS pixels. Gold #D9A94A on the dark tab, #B07A22 on the light tab.">
          <div className="flex flex-col">
            {MARKS.map((entry) => (
              <div
                key={entry.id}
                className="flex flex-col gap-4 border-t py-6 md:flex-row md:items-center md:gap-10"
                style={{ borderColor: RULE }}
              >
                <p className="type-label shrink-0 md:w-44">{labelOf(entry)}</p>
                <div className="flex flex-wrap gap-4">
                  <ChromeTab mode="dark" Mark={entry.Mark} />
                  <ChromeTab mode="light" Mark={entry.Mark} />
                </div>
              </div>
            ))}
          </div>
        </Row>

        <Row title="GitHub README" note="88px in #B07A22, the one mid gold that holds 3:1 on both GitHub themes.">
          <ul className="grid grid-cols-1 gap-x-8 gap-y-14 md:grid-cols-2 xl:grid-cols-4">
            {MARKS.map((entry) => (
              <li key={entry.id}>
                <CellLabel>{labelOf(entry)}</CellLabel>
                <div className="flex flex-col gap-4">
                  <ReadmePanel mode="light" Mark={entry.Mark} />
                  <ReadmePanel mode="dark" Mark={entry.Mark} />
                </div>
              </li>
            ))}
          </ul>
        </Row>

        <Row title="Phone home screen" note="A 180px tile with 22% corners, the mark at 120px in #D9A94A.">
          <ul className="grid grid-cols-1 gap-x-8 gap-y-14 md:grid-cols-2 xl:grid-cols-4">
            {MARKS.map((entry) => (
              <li key={entry.id}>
                <CellLabel>{labelOf(entry)}</CellLabel>
                <PhoneScreen Mark={entry.Mark} />
              </li>
            ))}
          </ul>
        </Row>

        <Row title="Site header" note="The mark at 28px in #D9A94A beside the wordmark in Bodoni Moda 24px.">
          <ul className="grid grid-cols-1 gap-x-8 gap-y-10 md:grid-cols-2 xl:grid-cols-4">
            {MARKS.map((entry) => (
              <li key={entry.id}>
                <CellLabel>{labelOf(entry)}</CellLabel>
                <div className="flex h-[72px] items-center gap-3 border px-5" style={{ background: INK, borderColor: RULE }}>
                  <entry.Mark size={28} gold={GOLD_ON_DARK} />
                  <span className="font-display font-semibold" style={{ fontSize: 24, lineHeight: 1, color: PAPER }}>
                    Adag
                  </span>
                </div>
              </li>
            ))}
          </ul>
        </Row>
      </div>
    </main>
  );
}
