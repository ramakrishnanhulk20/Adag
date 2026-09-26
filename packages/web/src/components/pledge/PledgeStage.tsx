"use client";

import "./pledge.css";
import { useRef, useState } from "react";
import Image from "next/image";
import { AnimatePresence, motion } from "motion/react";
import { Grain } from "@/components/Grain";
import { Hallmark } from "@/components/Hallmark";
import { HeroAction } from "@/components/hero/HeroAction";
import type { Pledge, StageBill, StageBills } from "@/lib/arc/pledge";
import { images } from "@/lib/images";
import { BillCard } from "./BillCard";
import { Coin } from "./Coin";
import { countWord, formatBtc, formatPercentWad, formatToken, formatUsd } from "./format";
import { TRAY } from "./geometry";
import { LoanGauge } from "./LoanGauge";
import { LoanLines, useLoanGeometry } from "./LoanLines";
import { usePledge, type PledgeState } from "./usePledge";
import { usePledgeMotion } from "./usePledgeMotion";

const EASE = [0.16, 1, 0.3, 1] as const;
const CHAPTERS = ["The coin", "The bills", "The pledge", "The loan", "Paid", "Never sold"];
const CHAPTER_STARTS = [0, 0.12, 0.3, 0.48, 0.62, 0.8];

type Beat = 1 | 3 | 4 | 5 | 6;
type Caption = { head: string; sub?: string };
type Story = { honesty: string; captions: Record<Beat, Caption> };

// Two contracts can each have a bill #1, so the title names the bills by what they are, not by number.
function replayOf(bills: StageBill[]): string {
  const onFirst = bills.filter((b) => b.first).length;
  const spansBoth = onFirst > 0 && onFirst < bills.length;
  if (bills.length === 2 && spansBoth) return "Replay of two real bills, one on each Adag contract";
  if (bills.length === 1) return `Replay of one real bill${onFirst ? ", on Adag's first contract" : ""}, paid on Arc`;
  return `Replay of ${countWord(bills.length).toLowerCase()} real bills${spansBoth ? " across both Adag contracts" : ""}, paid on Arc`;
}

function tell(state: PledgeState, bills: StageBills | null, pledge: Pledge | null): Story {
  const cap = pledge ? formatPercentWad(pledge.maxLtvWad) : "40%";
  const n = bills?.bills.length ?? 0;
  const billWord = n === 1 ? "bill" : "bills";
  const shared = {
    3: { head: "Your bitcoin is pledged, not sold.", sub: "It sits on Morpho as collateral, in your name." },
    4: { head: `Adag borrows exactly the ${billWord}.`, sub: `And refuses anything past ${cap} of the bitcoin's value.` },
    6: { head: "Never sold.", sub: "It stays pledged in your name. Repay any time to take it back." },
  };
  if (state.status === "loading") {
    return { honesty: "Reading Arc", captions: { 1: { head: "Reading the latest bills from Arc." }, ...shared, 5: { head: "" } } };
  }
  if (!bills) {
    return {
      honesty: "Could not read Arc. Nothing is shown in its place.",
      captions: { 1: { head: "The bills could not be read from Arc.", sub: "No bill is invented to fill the stage. Try again in a minute." }, ...shared, 5: { head: "" } },
    };
  }
  const them = n === 1 ? "it" : "them";
  // Only paid bills ever reach the stage; with none, it shows no bill rather than an open one anyone could write.
  if (bills.mode === "none") {
    return {
      honesty: "No bill has been paid on Arc yet. Nothing is invented to fill this.",
      captions: { 1: { head: "No bill paid on Arc yet.", sub: "The first payment on Arc will appear here." }, ...shared, 5: { head: "" } },
    };
  }
  const due = `${countWord(n)} real ${billWord} ${n === 1 ? "is" : "are"} due.`;
  return {
    honesty: `${replayOf(bills.bills)}. Numbers read live.`,
    captions: {
      1: {
        head: due,
        sub: `${n === 1 ? "It was" : n === 2 ? "Both were" : "All were"} really paid on Arc. The pledge is what a new wallet would put up today to pay ${them} from bitcoin.`,
      },
      ...shared,
      5: {
        head: n === 1 ? "The supplier is paid." : `${countWord(n)} bills paid.`,
        sub: `Invoice ${n === 1 ? "number" : "numbers"} attached. One signature.`,
      },
    },
  };
}

function Reading({ slow }: { slow: boolean }) {
  return (
    <span className="flex h-[1em] flex-col justify-center gap-2" aria-label="Reading Arc">
      <span aria-hidden="true" className="live-shimmer block h-px w-40" />
      <span className={`type-micro text-muted transition-opacity duration-300 ${slow ? "opacity-100" : "opacity-0"}`}>Reading Arc</span>
    </span>
  );
}

const Unavailable = () => <span className="font-display text-[1.5rem] italic text-muted">unavailable</span>;

export function PledgeStage() {
  const state = usePledge();
  const pinRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [final, setFinal] = useState(false);

  const snapshot = state.status === "ready" ? state.snapshot : null;
  const bills = snapshot?.bills.ok ? snapshot.bills.value : null;
  const pledge = snapshot?.pledge.ok ? snapshot.pledge.value : null;
  const list = bills?.bills ?? [];
  const n = list.length;
  const mode = bills?.mode ?? "none";
  const story = tell(state, bills, pledge);

  const motionKey = `${state.status}:${mode}:${list.map((b) => b.key).join(",")}:${pledge ? "p" : "-"}`;
  const geometry = useLoanGeometry(stageRef, motionKey);
  const { kind, replay } = usePledgeMotion({ pinRef, stageRef, key: motionKey, ready: state.status !== "loading", stamps: mode === "paid", onFinal: setFinal });

  const btc = pledge ? formatBtc(pledge.totalPledgeSat) : null;
  const usd = pledge?.totalValueUsdBaseUnits ? formatUsd(pledge.totalValueUsdBaseUnits) : null;
  const perBtc = pledge?.usdPerBtcBaseUnits ? formatUsd(pledge.usdPerBtcBaseUnits, false) : null;
  const borrowed = pledge ? pledge.markets.map((m) => formatToken(m.billsBaseUnits, m.currency)).join(" + ") : null;
  const paused = pledge?.markets.some((m) => m.fresh === false) ?? false;
  const lineLabels = Object.fromEntries(list.map((b) => [b.key, `${formatToken(b.amountBaseUnits, b.currency)} borrowed`]));

  const figure = (value: React.ReactNode) =>
    state.status === "loading" ? <Reading slow={state.slow} /> : pledge ? value : <Unavailable />;

  return (
    <section className="pl-section" aria-labelledby="pledge-title">
      <div ref={pinRef} className="pl-pin">
        <div ref={stageRef} className="pl-stage" data-kind={kind}>
          <motion.div
            className="pl-honesty type-micro"
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, amount: 0.3 }}
            transition={{ duration: 0.6, ease: EASE }}
          >
            <span className="flex items-center gap-2.5 text-text">
              <span className="diamond" aria-hidden="true" />
              {story.honesty}
            </span>
            {snapshot?.blockNumber && <span className="hidden text-muted md:inline">Arc block {Number(snapshot.blockNumber).toLocaleString("en-US")}</span>}
          </motion.div>

          <div className="pl-head">
            <motion.div
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.8, ease: EASE }}
            >
              {/* The label follows the beat, read from the timeline's --p like the chapter bar, so it never re-renders per frame. */}
              <Hallmark as="h2" className="pl-title">
                <span id="pledge-title">
                  03 ·{" "}
                  <span className="pl-beat-names" aria-hidden="true">
                    {CHAPTERS.map((name, i) => (
                      <span
                        key={name}
                        className="pl-beat-name"
                        style={{ "--start": CHAPTER_STARTS[i], "--end": CHAPTER_STARTS[i + 1] ?? 2 } as React.CSSProperties}
                      >
                        {name}
                      </span>
                    ))}
                  </span>
                  <span className="sr-only">Paying bills from pledged bitcoin, in six beats</span>
                </span>
              </Hallmark>
            </motion.div>
            <motion.div
              className="pl-captions"
              initial={{ opacity: 0, y: 24 }}
              whileInView={{ opacity: 1, y: 0 }}
              viewport={{ once: true, amount: 0.3 }}
              transition={{ duration: 0.8, ease: EASE, delay: 0.08 }}
              aria-live="polite"
            >
              {([1, 3, 4, 5, 6] as const).map((beat) => (
                <div key={beat} data-pl-cap={beat} className="pl-caption-block">
                  <p className="pl-caption">{story.captions[beat].head}</p>
                  {story.captions[beat].sub && <p className="pl-sub">{story.captions[beat].sub}</p>}
                </div>
              ))}
            </motion.div>
          </div>

          <div data-pl-frame className="pl-frame">
            <div data-pl="push" className="pl-push">
              <div className="pl-photo">
                <Image
                  src={images.vaultCoin}
                  alt="An open safe deposit drawer lined with blue velvet"
                  fill
                  sizes="(min-width: 768px) 62vw, 100vw"
                  quality={85}
                  placeholder="blur"
                  className="object-cover"
                />
                <div className="pl-photo-vignette" />
                <Grain local />
              </div>
              <div data-pl="cone" className="pl-cone" />
              <svg className="pl-tray" viewBox="0 0 100 100" preserveAspectRatio="none" aria-hidden="true">
                <polygon data-pl="plate" points={TRAY.map(([x, y]) => `${x * 100},${y * 100}`).join(" ")} />
              </svg>
              <div data-pl="shade" className="pl-shade" />
              <div data-pl="coin" className="pl-coin">
                <div data-pl="coin-glow" className="pl-coin-glow" />
                <div className="pl-coin-float">
                  <Coin className="pl-coin-svg" />
                </div>
              </div>
              <div data-pl="tag-1" className="pl-tag pl-tag-1">
                <Hallmark className="pl-hallmark">{btc ? `${btc} cirBTC${usd ? ` · ${usd}` : ""} · in your wallet` : "Your cirBTC"}</Hallmark>
              </div>
              <div data-pl="tag-3" className="pl-tag pl-tag-3">
                <Hallmark className="pl-hallmark">Pledged on Morpho · still in your name</Hallmark>
              </div>
              <div data-pl="tag-6" className="pl-tag pl-tag-6">
                <Hallmark className="pl-hallmark pl-hallmark-wrap">
                  {btc
                    ? `${btc} cirBTC, pledged in your name, never sold. Repay any time to take it back.`
                    : "Pledged in your name, never sold. Repay any time to take it back."}
                </Hallmark>
              </div>
            </div>
          </div>

          <LoanLines geometry={geometry} ids={list.map((b) => b.key)} labels={lineLabels} total={borrowed ? `${borrowed} borrowed` : ""} />

          {n > 0 && (
            <ol className="pl-cards" data-count={n} aria-label={mode === "paid" ? "Bills paid on Arc" : "Open bills on Arc"}>
              {list.map((bill, i) => (
                <BillCard key={bill.key} bill={bill} index={i} count={n} />
              ))}
            </ol>
          )}

          <div className="pl-figures">
            <div className="pl-figure">
              <span className="type-label text-muted">Your pledge</span>
              <p className="pl-figure-number">
                {figure(
                  <>
                    {btc}
                    <span className="type-micro ml-2 normal-case tracking-[0.06em] text-muted">cirBTC</span>
                  </>,
                )}
              </p>
              <p className="type-micro text-muted">
                {pledge
                  ? `${usd ?? "value unavailable"}${perBtc ? ` at ${perBtc} a bitcoin` : ""} · 5% margin${pledge.markets.length > 1 ? " · 2 markets" : ""}`
                  : snapshot && !snapshot.pledge.ok
                    ? "Could not read this from Arc"
                    : " "}
              </p>
              {paused && <p className="type-micro mt-1 text-pending">New loans are paused until the price feed updates.</p>}
            </div>

            <div data-pl="borrowed" className="pl-figure">
              <span className="type-label text-muted">Borrowed</span>
              <p className="pl-figure-small">{figure(borrowed)}</p>
              <p className="type-micro text-muted">Exactly the {n === 1 ? "bill" : "bills"}, nothing more</p>
            </div>

            {pledge && <LoanGauge ltvWad={pledge.headlineLtvWad} maxLtvWad={pledge.maxLtvWad} lltvWad={pledge.lltvWad} />}

            <p data-pl="final" className="pl-final">
              {pledge
                ? `Loan at ${formatPercentWad(pledge.headlineLtvWad)} of the bitcoin. Morpho's line is ${formatPercentWad(pledge.lltvWad)}. Bitcoin would have to fall ${(pledge.fallToLiquidation * 100).toFixed(1)}% to reach it.`
                : " "}
            </p>

            <div className="pl-actions">
              <AnimatePresence>
                {final && (
                  <motion.div
                    key="cta"
                    initial={{ opacity: 0, y: 16 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 8 }}
                    transition={{ duration: 0.6, ease: EASE }}
                  >
                    <HeroAction href="/pay" variant="primary">
                      Pay a bill
                    </HeroAction>
                  </motion.div>
                )}
              </AnimatePresence>
              {kind !== "scrub" && (
                <motion.button
                  type="button"
                  onClick={replay}
                  className="pl-replay type-label"
                  whileHover={{ y: -1 }}
                  whileTap={{ y: 0 }}
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  transition={{ duration: 0.3 }}
                >
                  <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
                    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2.5v3h-3" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                  Replay
                </motion.button>
              )}
            </div>
          </div>

          <ol className="pl-chapters" aria-hidden="true">
            {CHAPTERS.map((name, i) => (
              <li key={name} className="pl-chapter type-micro" style={{ "--start": CHAPTER_STARTS[i] } as React.CSSProperties}>
                <span className="text-gold">{String(i + 1).padStart(2, "0")}</span> {name}
              </li>
            ))}
            <li className="pl-chapter-rule" />
          </ol>
        </div>
      </div>
    </section>
  );
}
