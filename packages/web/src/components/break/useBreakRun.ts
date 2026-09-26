"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CHECKS, type CheckId, type CheckResult, type RunStart } from "@/lib/break/catalogue";
import { parseLine } from "./parse";

const RUN_TIMEOUT_MS = 150_000;
const MAX_STREAM_CHARS = 200_000;

export type BreakRun = {
  phase: "idle" | "running" | "done";
  start: RunStart | null;
  state: string[];
  results: Partial<Record<CheckId, CheckResult>>;
  summary: string | null;
  providers: string[];
  fatal: string | null;
  startedAt: number;
};

const IDLE: BreakRun = { phase: "idle", start: null, state: [], results: {}, summary: null, providers: [], fatal: null, startedAt: 0 };

// Anything the stream never answered is marked "could not run" with the reason, never left looking refused (C19).
function closeOut(run: BreakRun, reason: string): BreakRun {
  const results = { ...run.results };
  for (const c of CHECKS) if (!results[c.id]) results[c.id] = { id: c.id, pass: false, verdict: "error", reason, raw: reason, gas: null };
  return { ...run, phase: "done", results, fatal: run.fatal ?? reason };
}

export function useBreakRun() {
  const [run, setRun] = useState<BreakRun>(IDLE);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  const go = useCallback(async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const timer = window.setTimeout(() => controller.abort(), RUN_TIMEOUT_MS);
    let current: BreakRun = { ...IDLE, phase: "running", startedAt: Date.now() };
    setRun(current);
    let finished = false;

    try {
      const res = await fetch("/api/break", { method: "POST", cache: "no-store", signal: controller.signal });
      if (!res.ok || !res.body) throw new Error(`the server answered ${res.status}`);
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let seen = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        seen += chunk.length;
        if (seen > MAX_STREAM_CHARS) throw new Error("the answer was too large");
        buffer += chunk;
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const raw of lines) {
          if (!raw.trim()) continue;
          const line = parseLine(raw);
          if (!line) continue;
          if (line.type === "start") current = { ...current, start: line };
          else if (line.type === "state") current = { ...current, state: line.lines };
          else if (line.type === "result") current = { ...current, results: { ...current.results, [line.result.id]: line.result } };
          else if (line.type === "done") {
            current = { ...current, summary: line.summary, providers: line.providers, phase: "done" };
            finished = true;
          } else if (line.type === "fatal") {
            current = closeOut({ ...current, fatal: line.reason }, line.reason);
            finished = true;
          }
          setRun(current);
        }
      }
      if (!finished) current = closeOut(current, "could not run: the answer ended early");
      else if (current.phase === "done" && CHECKS.some((c) => !current.results[c.id])) current = closeOut(current, "could not run: no answer for this check");
    } catch (e) {
      const aborted = (e as Error).name === "AbortError";
      current = closeOut(current, `could not run: ${aborted ? "no answer within 150 seconds" : (e as Error).message}`);
    } finally {
      window.clearTimeout(timer);
    }
    setRun(current);
  }, []);

  return { run, go };
}
