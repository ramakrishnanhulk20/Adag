"use client";

import "./pledge.css";
import { useRef, useState } from "react";
import Image from "next/image";
import { useTranslations } from "next-intl";
import { AnimatePresence, motion } from "motion/react";
import { Grain } from "@/components/Grain";
import { Hallmark } from "@/components/Hallmark";
import { HeroAction } from "@/components/hero/HeroAction";
import type { Pledge, StageBill, StageBills } from "@/lib/arc/pledge";
import { images } from "@/lib/images";
import { BillCard } from "./BillCard";
import { Coin } from "./Coin";
import { formatBtc, formatPercentWad, formatToken, formatUsd } from "./format";
import { TRAY } from "./geometry";
import { LoanGauge } from "./LoanGauge";
import { LoanLines, useLoanGeometry } from "./LoanLines";
import { usePledge, type PledgeState } from "./usePledge";
import { usePledgeMotion } from "./usePledgeMotion";

const EASE = [0.16, 1, 0.3, 1] as const;
const CHAPTERS = ["coin", "bills", "pledge", "loan", "paid", "neverSold"] as const;
const CHAPTER_STARTS = [0, 0.12, 0.3, 0.48, 0.62, 0.8];

type Beat = 1 | 3 | 4 | 5 | 6;
type Caption = { head: string; sub?: string };
type Story = { honesty: string; captions: Record<Beat, Caption> };
type T = ReturnType<typeof useTranslations<"pledge">>;

// Two contracts can each have a bill #1, so the title names the bills by what they are, not by number.
function replayOf(t: T, bills: StageBill[]): string {
  const onFirst = bills.filter((b) => b.first).length;
  const spansBoth = onFirst > 0 && onFirst < bills.length;
  const n = bills.length;
  if (n === 2 && spansBoth) return t("replay.twoBoth");
  if (n === 1) return onFirst ? t("replay.oneFirst") : t("replay.one");
  return spansBoth ? t("replay.manyBoth", { count: n, n: String(n) }) : t("replay.many", { count: n, n: String(n) });
}

function tell(t: T, state: PledgeState, bills: StageBills | null, pledge: Pledge | null): Story {
  const cap = pledge ? formatPercentWad(pledge.maxLtvWad) : "40%";
  const n = bills?.bills.length ?? 0;
  const shared = {
    3: { head: t("captions.pledgedHead"), sub: t("captions.pledgedSub") },
    4: { head: t("captions.borrowsHead", { count: n }), sub: t("captions.borrowsSub", { cap }) },
    6: { head: t("captions.neverSoldHead"), sub: t("captions.neverSoldSub") },
  };
  if (state.status === "loading") {
    return { honesty: t("readingArc"), captions: { 1: { head: t("captions.readingHead") }, ...shared, 5: { head: "" } } };
  }
  if (!bills) {
    return {
      honesty: t("honestyFailed"),
      captions: { 1: { head: t("captions.failedHead"), sub: t("captions.failedSub") }, ...shared, 5: { head: "" } },
    };
  }
  // Only paid bills ever reach the stage; with none, it shows no bill rather than an open one anyone could write.
  if (bills.mode === "none") {
    return {
      honesty: t("honestyNone"),
      captions: { 1: { head: t("captions.noneHead"), sub: t("captions.noneSub") }, ...shared, 5: { head: "" } },
    };
  }
  return {
    honesty: t("honesty", { replay: replayOf(t, bills.bills) }),
    captions: {
      1: { head: t("captions.dueHead", { count: n, n: String(n) }), sub: t("captions.dueSub", { count: n }) },
      ...shared,
      5: { head: t("captions.paidHead", { count: n, n: String(n) }), sub: t("captions.paidSub", { count: n }) },
    },
  };
}

function Reading({ slow }: { slow: boolean }) {
  const t = useTranslations("common");
  return (
    <span className="flex h-[1em] flex-col justify-center gap-2" aria-label={t("readingArc")}>
      <span aria-hidden="true" className="live-shimmer block h-px w-40" />
      <span className={`type-micro text-muted transition-opacity duration-300 ${slow ? "opacity-100" : "opacity-0"}`}>{t("readingArc")}</span>
    </span>
  );
}

function Unavailable() {
  const t = useTranslations("common");
  return <span className="font-display text-[1.5rem] italic text-muted">{t("unavailable")}</span>;
}

export function PledgeStage() {
  const t = useTranslations("pledge");
  const tc = useTranslations("common");
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
  const story = tell(t, state, bills, pledge);

  const motionKey = `${state.status}:${mode}:${list.map((b) => b.key).join(",")}:${pledge ? "p" : "-"}`;
  const geometry = useLoanGeometry(stageRef, motionKey);
  const { kind, replay } = usePledgeMotion({ pinRef, stageRef, key: motionKey, ready: state.status !== "loading", stamps: mode === "paid", onFinal: setFinal });

  const btc = pledge ? formatBtc(pledge.totalPledgeSat) : null;
  const usd = pledge?.totalValueUsdBaseUnits ? formatUsd(pledge.totalValueUsdBaseUnits) : null;
  const perBtc = pledge?.usdPerBtcBaseUnits ? formatUsd(pledge.usdPerBtcBaseUnits, false) : null;
  const borrowed = pledge ? pledge.markets.map((m) => formatToken(m.billsBaseUnits, m.currency)).join(" + ") : null;
  const paused = pledge?.markets.some((m) => m.fresh === false) ?? false;
  const lineLabels = Object.fromEntries(list.map((b) => [b.key, t("borrowedLabel", { amount: formatToken(b.amountBaseUnits, b.currency) })]));

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
            {snapshot?.blockNumber && <span className="hidden text-muted min-[1300px]:inline">{t("arcBlock", { block: Number(snapshot.blockNumber).toLocaleString("en-US") })}</span>}
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
                        {t(`chapters.${name}`)}
                      </span>
                    ))}
                  </span>
                  <span className="sr-only">{t("srTitle")}</span>
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
                  alt={t("imageAlt")}
                  fill
                  sizes="(min-width: 1300px) 62vw, 100vw"
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
                <Hallmark className="pl-hallmark">{btc ? t("tagWallet", { btc, usd: usd ? ` · ${usd}` : "" }) : t("tagYourCirbtc")}</Hallmark>
              </div>
              <div data-pl="tag-3" className="pl-tag pl-tag-3">
                <Hallmark className="pl-hallmark">{t("tagPledged")}</Hallmark>
              </div>
              <div data-pl="tag-6" className="pl-tag pl-tag-6">
                <Hallmark className="pl-hallmark pl-hallmark-wrap">{btc ? t("tagNeverSoldBtc", { btc }) : t("tagNeverSold")}</Hallmark>
              </div>
            </div>
          </div>

          <LoanLines geometry={geometry} ids={list.map((b) => b.key)} labels={lineLabels} total={borrowed ? t("borrowedLabel", { amount: borrowed }) : ""} />

          {n > 0 && (
            <ol className="pl-cards" data-count={n} aria-label={mode === "paid" ? t("billsPaidOnArc") : t("openBillsOnArc")}>
              {list.map((bill, i) => (
                <BillCard key={bill.key} bill={bill} index={i} count={n} />
              ))}
            </ol>
          )}

          <div className="pl-figures">
            <div className="pl-figure">
              <span className="type-label text-muted">{t("yourPledge")}</span>
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
                  ? t("pledgeNote", {
                      usd: usd ?? t("valueUnavailable"),
                      perBtc: perBtc ? t("atPerBitcoin", { perBtc }) : "",
                      markets: pledge.markets.length > 1 ? t("twoMarkets") : "",
                    })
                  : snapshot && !snapshot.pledge.ok
                    ? tc("couldNotReadFromArc")
                    : " "}
              </p>
              {paused && <p className="type-micro mt-1 text-pending">{t("pausedFeed")}</p>}
            </div>

            <div data-pl="borrowed" className="pl-figure">
              <span className="type-label text-muted">{t("borrowed")}</span>
              <p className="pl-figure-small">{figure(borrowed)}</p>
              <p className="type-micro text-muted">{t("exactlyTheBills", { count: n })}</p>
            </div>

            {pledge && <LoanGauge ltvWad={pledge.headlineLtvWad} maxLtvWad={pledge.maxLtvWad} lltvWad={pledge.lltvWad} />}

            <p data-pl="final" className="pl-final">
              {pledge
                ? t("final", { ltv: formatPercentWad(pledge.headlineLtvWad), lltv: formatPercentWad(pledge.lltvWad), fall: (pledge.fallToLiquidation * 100).toFixed(1) })
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
                      {tc("payABill")}
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
                  {t("replayButton")}
                </motion.button>
              )}
            </div>
          </div>

          <ol className="pl-chapters" aria-hidden="true">
            {CHAPTERS.map((name, i) => (
              <li key={name} className="pl-chapter type-micro" style={{ "--start": CHAPTER_STARTS[i] } as React.CSSProperties}>
                <span className="text-gold">{String(i + 1).padStart(2, "0")}</span> {t(`chapters.${name}`)}
              </li>
            ))}
            <li className="pl-chapter-rule" />
          </ol>
        </div>
      </div>
    </section>
  );
}
