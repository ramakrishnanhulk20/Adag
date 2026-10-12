"use client";

import "./break.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useLocale, useTranslations } from "next-intl";
import { motion } from "motion/react";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { LanguageSwitcher } from "@/components/LanguageSwitcher";
import { dateTimeIn } from "@/i18n/dates";
import { localeOf } from "@/i18n/locales";
import { useLibText } from "@/i18n/useLibText";
import { CHECKS, GROUPS, LEGEND, RESIDUALS, type CheckInfo, type CheckResult } from "@/lib/break/catalogue";
import { billHref } from "@/lib/pay/billId";
import { ADAG_BILLS } from "@/lib/pay/constants";
import { ATTACK_SCRIPT_PATH, GUARD_ATTACK_SCRIPT_PATH } from "@/lib/break/constants";
import { useBreakRun, type BreakRun } from "./useBreakRun";
import { VerdictStamp, type StampKind } from "./VerdictStamp";

const EASE = [0.16, 1, 0.3, 1] as const;
const TOTAL = CHECKS.length;
const BILL_ONE = billHref(ADAG_BILLS, 1n);

// Set once the repository is public. Until then the terminal line is left out rather than pointing nowhere.
const REPO_URL = (process.env.NEXT_PUBLIC_REPO_URL ?? "").replace(/\/+$/, "");

// Catalog keys cannot carry a dot, so "A6.1" is spelled A6_1 there; group names are keyed by their place in the list.
const checkKey = (id: string) => id.replace(".", "_");
const legendKey = (verdict: string) => (verdict === "by-design" ? "byDesign" : verdict);
const GROUP_KEYS = ["bills", "enrol", "guard"] as const;

function useElapsed(running: boolean, since: number) {
  const [now, setNow] = useState(since);
  useEffect(() => {
    if (!running) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [running]);
  return Math.max(0, Math.round((now - since) / 1000));
}

function Tally({ run }: { run: BreakRun }) {
  const t = useTranslations("break.tally");
  const results = Object.values(run.results) as CheckResult[];
  const held = results.filter((r) => r.pass).length;
  const broken = results.filter((r) => r.verdict === "broken").length;
  const total = String(TOTAL);
  const label =
    run.phase === "idle"
      ? t("armed")
      : run.phase === "running"
        ? t("soFar", { total })
        : broken > 0
          ? t("brokeThrough", { n: String(broken) })
          : held === TOTAL
            ? t("allHeld", { total })
            : t("couldNotRun", { n: String(TOTAL - held) });
  return (
    <div className="bk-tally" aria-live="polite">
      <motion.p key={run.phase === "idle" ? "idle" : held} className="bk-tally-number" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
        {run.phase === "idle" ? TOTAL : held}
        {run.phase !== "idle" && <span className="bk-tally-of">/{TOTAL}</span>}
      </motion.p>
      <p className="type-label text-muted">{label}</p>
    </div>
  );
}

// Every sentence the server streams is English (the run is shared by every visitor for a minute); the row translates it
// through the lib table. The raw chain answer stays exactly as the chain gave it.
function Row({ info, result, running }: { info: CheckInfo; result: CheckResult | undefined; running: boolean }) {
  const t = useTranslations("break");
  const tl = useLibText();
  const kind: StampKind = result ? result.verdict : running ? "running" : "armed";
  const residual = RESIDUALS[info.id];
  const key = checkKey(info.id);
  return (
    <motion.li
      className={`bk-row ${result ? "is-landed" : ""} ${running ? "is-running" : ""}`}
      data-check={info.id}
      data-verdict={result?.verdict ?? "waiting"}
      animate={result && result.verdict !== "error" ? { x: [0, -2, 2, -1, 0] } : undefined}
      transition={{ duration: 0.28, delay: 0.08 }}
    >
      <span className="bk-id">{info.id}</span>
      <div className="bk-body">
        {info.simulated === "price drop" && <span className="bk-tag type-micro">{t("simulatedDrop")}</span>}
        {info.simulated === "price crash" && <span className="bk-tag type-micro">{t("simulatedCrash")}</span>}
        <p className="bk-attack">{t(`checks.${key}.attack`)}</p>
        <p className="type-micro mt-2 text-muted">
          {t.rich("whatShouldStopIt", { stopper: t(`checks.${key}.stopper`), span: (chunks) => <span className="text-text/80">{chunks}</span> })}
        </p>
        {running && !result && (
          <p className="mt-3 flex items-center gap-3">
            <span aria-hidden="true" className="live-shimmer block h-px w-24" />
            <span className="type-micro text-muted">{t("simulatingOnArc")}</span>
          </p>
        )}
        {result && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
            <p className={`bk-reason ${result.verdict === "broken" ? "text-danger" : result.verdict === "error" ? "text-muted" : "text-text"}`}>{tl(result.reason)}</p>
            {residual && result.verdict === "by-design" && (
              <p className="type-micro mt-2 text-muted">
                {t.rich(`residuals.${key}`, {
                  link: (chunks) => (
                    <Link href={residual.href} className="link-draw text-gold">
                      {chunks}
                    </Link>
                  ),
                })}
              </p>
            )}
            <details className="bk-details">
              <summary className="type-micro">{t("rawAnswer")}</summary>
              <dl className="bk-raw">
                <dt>{t("decoded")}</dt>
                <dd>{result.raw}</dd>
                {result.gas && (
                  <>
                    <dt>{t("gas")}</dt>
                    <dd>{Number(result.gas).toLocaleString("en-US")}</dd>
                  </>
                )}
                <dt>{t("invariant")}</dt>
                <dd>{info.invariant}</dd>
              </dl>
            </details>
          </motion.div>
        )}
      </div>
      <div className="bk-verdict">
        <VerdictStamp kind={kind} />
      </div>
    </motion.li>
  );
}

export function BreakPage() {
  const t = useTranslations("break");
  const tc = useTranslations("common");
  const tl = useLibText();
  const locale = localeOf(useLocale());
  const { run, go } = useBreakRun();
  const running = run.phase === "running";
  const elapsed = useElapsed(running, run.startedAt);
  const answered = Object.keys(run.results).length;
  const nextId = running ? CHECKS.find((c) => !run.results[c.id])?.id : undefined;
  const block = run.start ? Number(run.start.block).toLocaleString("en-US") : null;
  const when = run.start ? `${dateTimeIn(locale, run.start.timestamp).replace(/\s*UTC$/, "")} UTC` : null;
  const total = String(TOTAL);
  const seconds = String(elapsed);

  let status: string;
  if (run.phase === "idle") status = t("status.idle");
  else if (running) status = answered === 0 ? t("status.reading", { seconds }) : t("status.simulating", { answered: String(answered), total, seconds });
  else if (run.fatal) status = tl(run.fatal);
  else if (run.start?.cached) status = t("status.cached", { age: String(run.start.ageSeconds) });
  else status = t("status.finished", { seconds });

  return (
    <div className="bk-page">
      <header className="bk-nav">
        <Link href="/" className="inline-flex min-h-10 items-center font-display text-[22px] font-semibold tracking-[0.08em] text-text transition-colors duration-200 hover:text-gold">
          ADAG
        </Link>
        <div className="flex items-center gap-6">
          <Link href="/docs" className="link-draw type-ui text-text/88 transition-colors duration-200 hover:text-text">
            {tc("docs")}
          </Link>
          <LanguageSwitcher variant="nav" />
          <Hallmark tone="quiet" className="hidden md:inline-flex">
            {t("nothingSigned")}
          </Hallmark>
        </div>
      </header>

      <section className="bk-hero" aria-labelledby="break-title">
        <div className="bk-hero-copy">
          <div className="bk-in bk-in-1">
            <Hallmark>{t("hallmark")}</Hallmark>
          </div>
          <h1 id="break-title" className="type-hero bk-title">
            <span className="bk-line bk-line-1 block">{t("titleLine1")}</span>
            <span className="bk-line bk-line-2 block">{t.rich("titleLine2", { em: (chunks) => <em className="font-semibold text-gold italic">{chunks}</em> })}</span>
          </h1>
          <p className="type-lead bk-lead bk-in bk-in-2">{t("lead", { total })}</p>
          <div className="bk-actions bk-in bk-in-3">
            <Button onClick={go} disabled={running} aria-busy={running}>
              {running ? t("attacking") : run.phase === "done" ? t("runAgain") : t("runAll", { total })}
            </Button>
            <p className={`type-micro bk-status ${run.fatal ? "text-danger" : "text-muted"}`} role="status">
              {status}
            </p>
          </div>
        </div>
        <div className="bk-in bk-in-late">
          <Tally run={run} />
        </div>
      </section>

      {run.phase === "done" && (
        <motion.section
          className="bk-after"
          aria-label={t("legendLabel")}
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: EASE }}
        >
          <dl className="bk-legend">
            {LEGEND.map((item) => (
              <div key={item.verdict} className="bk-legend-item">
                <dt className="bk-legend-stamp">
                  <VerdictStamp kind={item.verdict} />
                </dt>
                <dd className="type-body text-text/88">
                  <span className="font-semibold text-text">{t(`legend.${legendKey(item.verdict)}.term`)}:</span> {t(`legend.${legendKey(item.verdict)}.means`)}
                </dd>
              </div>
            ))}
          </dl>
          <nav aria-label={t("next")} className="bk-next">
            <Button href={BILL_ONE} variant="secondary">
              {tc("billNumber", { id: "1" })}
            </Button>
            <Button href="/docs/security/threat-model" variant="secondary">
              {t("threatModel")}
            </Button>
            <Button href="/pay">{tc("payABill")}</Button>
          </nav>
        </motion.section>
      )}

      {run.state.length > 0 && (
        <motion.section className="bk-state" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
          <p className="type-label text-gold">
            {t("liveStateAt", { block: block ?? "" })}
            {run.start ? t("simulatedOn", { provider: tl(run.start.provider) }) : null}
          </p>
          {run.state.map((line) => (
            <p key={line} className="type-address text-muted">
              {tl(line)}
            </p>
          ))}
        </motion.section>
      )}

      <section className="bk-ledger" aria-label={t("theAttacks")}>
        {GROUPS.map((group, gi) => (
          <div key={group} className="bk-group">
            <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} transition={{ duration: 0.7, ease: EASE }}>
              <Hallmark as="h2">
                {String(gi + 1).padStart(2, "0")} · {t(`groups.${GROUP_KEYS[gi]}.name`)}
              </Hallmark>
              <p className="type-body bk-group-note mt-4 max-w-[70ch] text-muted">{t(`groups.${GROUP_KEYS[gi]}.note`)}</p>
            </motion.div>
            <ol className="bk-rows">
              {CHECKS.filter((c) => c.group === group).map((info) => (
                <Row key={info.id} info={info} result={run.results[info.id]} running={nextId === info.id} />
              ))}
            </ol>
          </div>
        ))}
      </section>

      {run.summary && (
        <motion.p className="bk-summary" initial={{ opacity: 0, y: 16 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.6, ease: EASE }}>
          {tl(run.summary)}
        </motion.p>
      )}

      <footer className="bk-footer type-micro">
        <span>
          {block
            ? t("footer.simulatedAt", { providers: run.providers.length ? run.providers.map((p) => tl(p)).join(t("footer.and")) : tl(run.start?.provider ?? "Arc"), block, when: when ?? "" })
            : t("footer.pinned")}
        </span>
        {REPO_URL && (
          <span>
            {t.rich("footer.terminal", {
              attack: (chunks) => (
                <a href={`${REPO_URL}/blob/main/${ATTACK_SCRIPT_PATH}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold">
                  {chunks}
                </a>
              ),
              guard: (chunks) => (
                <a href={`${REPO_URL}/blob/main/${GUARD_ATTACK_SCRIPT_PATH}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold">
                  {chunks}
                </a>
              ),
            })}
          </span>
        )}
        <span>{tc("poweredByMorpho")}</span>
      </footer>
    </div>
  );
}
