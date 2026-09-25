import { RUN_CACHE_MS } from "./constants";
import type { RunLine } from "./catalogue";
import { runSuite } from "./suite";

type Listener = (line: RunLine | null) => void;
type Run = { lines: RunLine[]; listeners: Set<Listener>; done: boolean; finishedAt: number; failed: boolean };

// A failed run is kept briefly too, so a dRPC outage is not hammered by every visitor pressing the button.
const FAILED_CACHE_MS = 15_000;

// One run per server process. Everyone who presses the button inside the window shares it, which is what keeps a
// busy page under dRPC's rate limit.
let current: Run | null = null;

async function execute(run: Run) {
  const push = (line: RunLine) => {
    run.lines.push(line);
    run.listeners.forEach((f) => f(line));
  };
  try {
    await runSuite(push);
    const results = run.lines.flatMap((l) => (l.type === "result" ? [l.result] : []));
    const passed = results.filter((r) => r.pass).length;
    push({
      type: "done",
      passed,
      total: results.length,
      summary:
        passed === results.length
          ? `All ${results.length} checks behaved as the threat model says: every attack was refused, and the named residual (A4) behaved exactly as documented.`
          : `${results.length - passed} of ${results.length} checks did not behave as expected.`,
    });
  } catch (e) {
    run.failed = true;
    push({ type: "fatal", reason: `could not run: ${((e as Error).message || "unknown error").slice(0, 240)}` });
  } finally {
    run.done = true;
    run.finishedAt = Date.now();
    run.listeners.forEach((f) => f(null));
    run.listeners.clear();
  }
}

export type Joined = { run: Run; state: "hit" | "joined" | "miss" };

export function joinRun(): Joined {
  const now = Date.now();
  if (current?.done && now - current.finishedAt < (current.failed ? FAILED_CACHE_MS : RUN_CACHE_MS)) return { run: current, state: "hit" };
  if (current && !current.done) return { run: current, state: "joined" };
  const run: Run = { lines: [], listeners: new Set(), done: false, finishedAt: 0, failed: false };
  current = run;
  void execute(run);
  return { run, state: "miss" };
}

// Replays what the run has said so far, then follows it live until it finishes.
export function streamRun({ run, state }: Joined): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let listener: Listener | null = null;
  const ageSeconds = run.done ? Math.round((Date.now() - run.finishedAt) / 1000) : 0;
  const shape = (line: RunLine): RunLine => (line.type === "start" && state === "hit" ? { ...line, cached: true, ageSeconds } : line);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (line: RunLine) => controller.enqueue(encoder.encode(`${JSON.stringify(shape(line))}\n`));
      run.lines.forEach(send);
      if (run.done) {
        controller.close();
        return;
      }
      listener = (line) => {
        if (line) send(line);
        else controller.close();
      };
      run.listeners.add(listener);
    },
    cancel() {
      if (listener) run.listeners.delete(listener);
    },
  });
}
