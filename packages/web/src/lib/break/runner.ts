import { RUN_CACHE_MS } from "./constants";
import { publicReason } from "./errors";
import type { RunLine } from "./catalogue";
import { providersUsed } from "./simulate";
import { runSuite } from "./suite";

// One full run makes 31 eth_simulateV1 calls on dRPC, plus eth_chainId and eth_getBlockByNumber once each:
// AdagBills 19 (3 baseline reads, then A1 to A9 in 12 and E1 to E5 in 5) and AdagGuard 12 (a baseline read, one
// pass of the 38% premise alone, then one per group G1 to G10). At 1.5 seconds apart that is about a minute.

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
    const broken = results.filter((r) => r.verdict === "broken").length;
    const notRun = results.filter((r) => r.verdict === "error").length;
    const allowedRows = results.filter((r) => r.verdict === "allowed" || r.verdict === "by-design").length;
    const allowedClause = allowedRows > 0 ? `, or, in ${allowedRows} ${allowedRows === 1 ? "row" : "rows"}, allowed by design` : "";
    push({
      type: "done",
      passed,
      total: results.length,
      providers: providersUsed(),
      summary:
        passed === results.length
          ? `All ${results.length} checks behaved as the threat model says: every attack was refused or held${allowedClause}. The two known, accepted gaps, A4 and E5, behaved as the threat model says: each only affects the attacker's own loan.`
          : [
              broken ? `${broken} of ${results.length} checks did not behave as expected.` : null,
              notRun ? `${notRun} could not run this time; nothing is claimed for ${notRun === 1 ? "it" : "them"}.` : null,
            ]
              .filter(Boolean)
              .join(" "),
    });
  } catch (e) {
    run.failed = true;
    push({ type: "fatal", reason: `could not run: ${publicReason(e)}` });
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
