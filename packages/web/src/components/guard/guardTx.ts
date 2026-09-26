import { decodeEventLog, isAddressEqual, type Address, type Hex, type Log } from "viem";
import type { TxState } from "@/components/app/TxProgress";
import { guardAbi } from "@/lib/guard/abi";
import { buildStopRule } from "@/lib/guard/build";
import { ADAG_GUARD } from "@/lib/guard/constants";
import { erc20Abi } from "@/lib/pay/abi";
import { EXPLORER, type Currency } from "@/lib/pay/constants";
import { publicArc, simulateAndSend, type TxStep } from "@/lib/wallet/send";

export function guardEvent(logs: readonly Log[], guard: Address, name: "RuleSet" | "RuleCleared") {
  for (const log of logs) {
    if (!isAddressEqual(log.address, guard)) continue;
    try {
      const event = decodeEventLog({ abi: guardAbi, data: log.data, topics: log.topics });
      if (event.eventName === name) return event.args as { borrower: Address; marketId: Hex; triggerWad?: bigint; targetWad?: bigint; expiry?: bigint };
    } catch {
      // Not one of AdagGuard's events.
    }
  }
  return null;
}

export type StopOutcome = { ok: true; hash: Hex; text: string } | { ok: false; state: TxState };

const failed = (message: string, hash?: Hex): StopOutcome => ({ ok: false, state: { kind: "failed", message, href: hash && `${EXPLORER}/tx/${hash}` } });

// Stop protecting, the one way both the loan card and the guard list do it (C60): one signature that clears the rule
// (when there is one) and sets the approval to 0, simulated first, then proven by AdagGuard's own RuleCleared and by
// reading the rule and the approval back from the chain.
export async function stopGuard(address: Address, currency: Currency, hasRule: boolean, onStep: (step: TxStep) => void): Promise<StopOutcome> {
  const guard = ADAG_GUARD;
  if (!guard) return failed("The loan guard is not deployed, so nothing was built.");
  onStep("checking");
  const m = currency.marketId;
  let built;
  try {
    built = buildStopRule(address, m, hasRule);
  } catch (error) {
    return failed(`${(error as Error).message} Nothing was sent.`);
  }
  const out = await simulateAndSend({ account: address, to: built.to, data: built.data, onStep, usdcOut: 0n });
  if (!out.ok) return { ok: false, state: out.stage === "refused" ? { kind: "refused", error: out.error } : { kind: "failed", message: out.message, href: out.hash && `${EXPLORER}/tx/${out.hash}` } };
  const client = publicArc();
  const cleared = hasRule ? guardEvent(out.receipt.logs, guard, "RuleCleared") : { borrower: address, marketId: m };
  const [after, allowed] = await Promise.all([
    client.readContract({ address: guard, abi: guardAbi, functionName: "ruleOf", args: [address, m] }),
    client.readContract({ address: currency.address, abi: erc20Abi, functionName: "allowance", args: [address, guard] }),
  ]).catch(() => [null, null] as const);
  // C60: stopped means no rule and an approval of exactly 0, read back from the chain.
  if (!cleared || after === null || after.triggerWad !== 0n || allowed !== 0n) {
    return failed("Arc confirmed the transaction, but the rule or the approval does not read as cleared. Check the transaction.", out.hash);
  }
  return { ok: true, hash: out.hash, text: `Protection stopped. No rule, and AdagGuard's approval for your ${currency.symbol} is 0.` };
}
