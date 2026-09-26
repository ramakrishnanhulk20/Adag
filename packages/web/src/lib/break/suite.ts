import { CHAIN_ID } from "@/lib/arc/constants";
import { BILL_IDS, runBills } from "./bills";
import { CHECKS, type CheckId, type CheckResult, type RunLine } from "./catalogue";
import { publicReason, SuiteError } from "./errors";
import { GUARD_IDS, runGuard } from "./guard";
import { tidy, type Row } from "./kit";
import { primaryProvider, simChainId, simHead, startUsage } from "./simulate";

// Runs every check on /break against one pinned block: AdagBills (A1 to A9 and E1 to E5), then AdagGuard (G1 to G10).
// Each part has its own baseline, so a part that cannot start marks only its own rows "could not run".
export async function runSuite(emit: (line: RunLine) => void): Promise<void> {
  startUsage();
  const provider = primaryProvider();
  const chain = await simChainId();
  if (chain !== CHAIN_ID) throw new SuiteError(`${provider} reports chain ${chain}, not Arc mainnet ${CHAIN_ID}.`);
  const pin = await simHead();
  emit({ type: "start", block: pin.number.toString(), timestamp: Number(pin.timestamp), total: CHECKS.length, cached: false, ageSeconds: 0, provider });

  const done = new Set<CheckId>();
  const row: Row = (id, pass, reason, raw, gas) => {
    if (done.has(id)) return;
    const info = CHECKS.find((c) => c.id === id)!;
    done.add(id);
    const couldNotRun = reason.startsWith("could not run");
    const result: CheckResult = {
      id,
      pass,
      verdict: pass ? info.expect : couldNotRun ? "error" : "broken",
      reason,
      raw: tidy(raw),
      gas: gas === null ? null : gas.toString(),
    };
    emit({ type: "result", result });
  };

  const lines: string[] = [];
  const state = (more: string[]) => {
    lines.push(...more);
    emit({ type: "state", lines: [...lines] });
  };

  const parts: [(pin: { number: bigint; timestamp: bigint }, row: Row, state: (l: string[]) => void) => Promise<void>, CheckId[]][] = [
    [runBills, BILL_IDS],
    [runGuard, GUARD_IDS],
  ];
  for (const [part, ids] of parts) {
    try {
      await part(pin, row, state);
    } catch (e) {
      // C19: a part that could not start never shows its rows as refused.
      const reason = `could not run: ${publicReason(e)}`;
      for (const id of ids) row(id, false, reason, reason, null);
    }
  }
}
