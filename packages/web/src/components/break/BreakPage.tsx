"use client";

import "./break.css";
import { useEffect, useState } from "react";
import Link from "next/link";
import { motion } from "motion/react";
import { Button } from "@/components/Button";
import { Hallmark } from "@/components/Hallmark";
import { CHECKS, GROUP_NOTES, GROUPS, LEGEND, RESIDUALS, type CheckInfo, type CheckResult } from "@/lib/break/catalogue";
import { billHref } from "@/lib/pay/billId";
import { ADAG_BILLS } from "@/lib/pay/constants";
import { ATTACK_SCRIPT_PATH, GUARD_ATTACK_SCRIPT_PATH } from "@/lib/break/constants";
import { useBreakRun, type BreakRun } from "./useBreakRun";
import { VerdictStamp, type StampKind } from "./VerdictStamp";

const EASE = [0.16, 1, 0.3, 1] as const;
const TOTAL = CHECKS.length;
const BILL_ONE = billHref(ADAG_BILLS, 1n);
const DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" });

// Set once the repository is public. Until then the terminal line is left out rather than pointing nowhere.
const REPO_URL = (process.env.NEXT_PUBLIC_REPO_URL ?? "").replace(/\/+$/, "");

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
  const results = Object.values(run.results) as CheckResult[];
  const held = results.filter((r) => r.pass).length;
  const broken = results.filter((r) => r.verdict === "broken").length;
  const label =
    run.phase === "idle"
      ? "Attacks armed"
      : run.phase === "running"
        ? `Of ${TOTAL} held so far`
        : broken > 0
          ? `Held. ${broken} broke through`
          : held === TOTAL
            ? `Of ${TOTAL} held`
            : `Held. ${TOTAL - held} could not run`;
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

function Row({ info, result, running }: { info: CheckInfo; result: CheckResult | undefined; running: boolean }) {
  const kind: StampKind = result ? result.verdict : running ? "running" : "armed";
  const residual = RESIDUALS[info.id];
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
        {info.simulated === "price drop" && <span className="bk-tag type-micro">Simulated price drop · a mock oracle, 25% lower</span>}
        {info.simulated === "price crash" && <span className="bk-tag type-micro">Simulated price crash · a mock oracle at zero</span>}
        <p className="bk-attack">{info.attack}</p>
        <p className="type-micro mt-2 text-muted">
          What should stop it · <span className="text-text/80">{info.stopper}</span>
        </p>
        {running && !result && (
          <p className="mt-3 flex items-center gap-3">
            <span aria-hidden="true" className="live-shimmer block h-px w-24" />
            <span className="type-micro text-muted">Simulating on Arc</span>
          </p>
        )}
        {result && (
          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
            <p className={`bk-reason ${result.verdict === "broken" ? "text-danger" : result.verdict === "error" ? "text-muted" : "text-text"}`}>{result.reason}</p>
            {residual && result.verdict === "by-design" && (
              <p className="type-micro mt-2 text-muted">
                {residual.text}{" "}
                <Link href={residual.href} className="link-draw text-gold">
                  the threat model
                </Link>
                .
              </p>
            )}
            <details className="bk-details">
              <summary className="type-micro">Raw answer from the chain</summary>
              <dl className="bk-raw">
                <dt>Decoded</dt>
                <dd>{result.raw}</dd>
                {result.gas && (
                  <>
                    <dt>Gas</dt>
                    <dd>{Number(result.gas).toLocaleString("en-US")}</dd>
                  </>
                )}
                <dt>Invariant</dt>
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
  const { run, go } = useBreakRun();
  const running = run.phase === "running";
  const elapsed = useElapsed(running, run.startedAt);
  const answered = Object.keys(run.results).length;
  const nextId = running ? CHECKS.find((c) => !run.results[c.id])?.id : undefined;
  const block = run.start ? Number(run.start.block).toLocaleString("en-US") : null;
  const when = run.start ? `${DATE.format(new Date(run.start.timestamp * 1000))} UTC` : null;

  let status: string;
  if (run.phase === "idle") status = "About a minute. Each simulation waits its turn so Arc's public node is never flooded.";
  else if (running) status = answered === 0 ? `Reading Arc's live state · ${elapsed}s` : `Simulating on Arc · ${answered} of ${TOTAL} · ${elapsed}s`;
  else if (run.fatal) status = run.fatal;
  else if (run.start?.cached) status = `Served from the run ${run.start.ageSeconds}s ago. A fresh run starts at most once a minute.`;
  else status = `Finished in ${elapsed}s.`;

  return (
    <div className="bk-page">
      <header className="bk-nav">
        <Link href="/" className="font-display text-[22px] font-semibold tracking-[0.08em] text-text transition-colors duration-200 hover:text-gold">
          ADAG
        </Link>
        <div className="flex items-center gap-6">
          <Link href="/docs" className="link-draw type-ui text-text/88 transition-colors duration-200 hover:text-text">
            Docs
          </Link>
          <Hallmark tone="quiet" className="hidden md:inline-flex">
            Nothing is signed or sent
          </Hallmark>
        </div>
      </header>

      <section className="bk-hero" aria-labelledby="break-title">
        <div className="bk-hero-copy">
          <div className="bk-in bk-in-1">
            <Hallmark>Attack suite · Arc mainnet</Hallmark>
          </div>
          <h1 id="break-title" className="type-hero bk-title">
            <span className="bk-line bk-line-1 block">Try to</span>
            <span className="bk-line bk-line-2 block">
              <em className="font-semibold text-gold italic">break</em> it.
            </span>
          </h1>
          <p className="type-lead bk-lead bk-in bk-in-2">
            {TOTAL} real attacks on Adag&apos;s live contracts, AdagBills and the loan guard, simulated on Arc mainnet&apos;s current state: the real loan, the
            real bills, the real bitcoin price. Nothing is signed and nothing is sent.
          </p>
          <div className="bk-actions bk-in bk-in-3">
            <Button onClick={go} disabled={running} aria-busy={running}>
              {running ? "Attacking" : run.phase === "done" ? "Run them again" : `Run all ${TOTAL} attacks`}
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
          aria-label="What the stamps mean, and where to go next"
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
                  <span className="font-semibold text-text">{item.term}:</span> {item.means}
                </dd>
              </div>
            ))}
          </dl>
          <nav aria-label="Next" className="bk-next">
            <Button href={BILL_ONE} variant="secondary">
              Bill #1
            </Button>
            <Button href="/docs/security/threat-model" variant="secondary">
              Threat model
            </Button>
            <Button href="/pay">Pay a bill</Button>
          </nav>
        </motion.section>
      )}

      {run.state.length > 0 && (
        <motion.section className="bk-state" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.5, ease: EASE }}>
          <p className="type-label text-gold">
            Live state at block {block}
            {run.start ? `, simulated on ${run.start.provider}` : null}
          </p>
          {run.state.map((line) => (
            <p key={line} className="type-address text-muted">
              {line}
            </p>
          ))}
        </motion.section>
      )}

      <section className="bk-ledger" aria-label="The attacks">
        {GROUPS.map((group, gi) => (
          <div key={group} className="bk-group">
            <motion.div initial={{ opacity: 0, y: 24 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.3 }} transition={{ duration: 0.7, ease: EASE }}>
              <Hallmark as="h2">
                {String(gi + 1).padStart(2, "0")} · {group}
              </Hallmark>
              <p className="type-body bk-group-note mt-4 max-w-[70ch] text-muted">{GROUP_NOTES[group]}</p>
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
          {run.summary}
        </motion.p>
      )}

      <footer className="bk-footer type-micro">
        <span>
          {block
            ? `Simulated on ${run.providers.length ? run.providers.join(" and ") : (run.start?.provider ?? "Arc")} at Arc block ${block} · ${when}`
            : "Every run is pinned to Arc's latest block"}
        </span>
        {REPO_URL && (
          <span>
            The same suites run from the terminal:{" "}
            <a href={`${REPO_URL}/blob/main/${ATTACK_SCRIPT_PATH}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold">
              attack.mjs
            </a>{" "}
            and{" "}
            <a href={`${REPO_URL}/blob/main/${GUARD_ATTACK_SCRIPT_PATH}`} target="_blank" rel="noopener noreferrer" className="link-draw text-gold">
              guard-attack.mjs
            </a>
          </span>
        )}
        <span>Powered by Morpho</span>
      </footer>
    </div>
  );
}
