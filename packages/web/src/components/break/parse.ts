import { CHECKS, type CheckResult, type RunLine, type Verdict } from "@/lib/break/catalogue";
import { PROVIDER_NAMES } from "@/lib/break/constants";

// Every streamed line is checked field by field. A malformed line is dropped, and a check it should have
// answered ends up as "could not run", never as refused (C19).

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null;
const isDigits = (v: unknown): v is string => typeof v === "string" && /^\d{1,30}$/.test(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v >= 0;
const text = (v: unknown, max = 400): string | null => (typeof v === "string" ? v.slice(0, max) : null);
const VERDICTS: Verdict[] = ["refused", "held", "allowed", "by-design", "broken", "error"];
const IDS = new Set<string>(CHECKS.map((c) => c.id));
// Only a known provider name is ever shown, so nothing else in the answer can be printed as one.
const isProvider = (v: unknown): v is string => typeof v === "string" && (PROVIDER_NAMES as readonly string[]).includes(v);

function readResult(v: unknown): CheckResult | null {
  if (!isObj(v) || typeof v.id !== "string" || !IDS.has(v.id) || typeof v.pass !== "boolean") return null;
  const verdict = VERDICTS.find((x) => x === v.verdict);
  const reason = text(v.reason);
  const raw = text(v.raw, 600);
  if (!verdict || reason === null || raw === null || (v.gas !== null && !isDigits(v.gas))) return null;
  // A pass can only carry the verdict its check expects; anything else is shown as a failure.
  const expected = CHECKS.find((c) => c.id === v.id)!.expect;
  const pass = v.pass && verdict === expected;
  return { id: v.id as CheckResult["id"], pass, verdict: pass ? verdict : verdict === "error" ? "error" : "broken", reason, raw, gas: v.gas as string | null };
}

export function parseLine(line: string): RunLine | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v)) return null;
  switch (v.type) {
    case "start":
      return isDigits(v.block) && isNum(v.timestamp) && isNum(v.total) && typeof v.cached === "boolean" && isNum(v.ageSeconds)
        && isProvider(v.provider)
        ? { type: "start", block: v.block, timestamp: v.timestamp, total: v.total, cached: v.cached, ageSeconds: v.ageSeconds, provider: v.provider }
        : null;
    case "state":
      return Array.isArray(v.lines) && v.lines.length <= 6 && v.lines.every((l) => typeof l === "string")
        ? { type: "state", lines: (v.lines as string[]).map((l) => l.slice(0, 480)) }
        : null;
    case "result": {
      const result = readResult(v.result);
      return result ? { type: "result", result } : null;
    }
    case "done": {
      const summary = text(v.summary);
      return isNum(v.passed) && isNum(v.total) && summary !== null && Array.isArray(v.providers) && v.providers.every(isProvider)
        ? { type: "done", passed: v.passed, total: v.total, summary, providers: v.providers as string[] }
        : null;
    }
    case "fatal": {
      const reason = text(v.reason);
      return reason !== null ? { type: "fatal", reason } : null;
    }
    default:
      return null;
  }
}
