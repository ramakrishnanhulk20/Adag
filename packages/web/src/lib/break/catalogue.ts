// Safe to import in the browser: plain words only, no chain code. The ids and pass rules match
// packages/contracts/prove-it/attack.mjs; A10 (the prove-it script's own chain guard) is left out on purpose.

export type CheckId =
  | "A1"
  | "A2a"
  | "A2b"
  | "A3"
  | "A4"
  | "A5"
  | "A6.1"
  | "A6.2"
  | "A6.3"
  | "A6.4"
  | "A6.5"
  | "A7a"
  | "A7b"
  | "A8"
  | "A9a"
  | "A9b";

export type Expect = "refused" | "allowed" | "by-design";

export type CheckInfo = {
  id: CheckId;
  group: string;
  attack: string;
  stopper: string;
  // The threat model invariant the check attacks.
  invariant: string;
  expect: Expect;
  simulatedPriceDrop?: boolean;
};

export const CHECKS: readonly CheckInfo[] = [
  { id: "A1", group: "Pay a bill twice", attack: "A stranger with money pays bill #1 a second time.", stopper: "A bill can be paid once. Only an open bill can be paid.", invariant: "C6", expect: "refused" },
  {
    id: "A2a",
    group: "Slip past the 40% line",
    attack: "Close the loan outside Adag, then re-borrow the same debt against a quarter of the bitcoin.",
    stopper: "Morpho's own 86% line stops it before Adag is reached.",
    invariant: "C10",
    expect: "refused",
  },
  {
    id: "A2b",
    group: "Slip past the 40% line",
    attack: "Close the loan, then re-borrow the same debt against bitcoin worth 60%, which Morpho allows, and pay a bill.",
    stopper: "Adag sees the pledge shrank since its last check, so the 40% check runs.",
    invariant: "C10",
    expect: "refused",
  },
  {
    id: "A3",
    group: "Slip past the 40% line",
    attack: "Borrow up to half the bitcoin's value and pay a new bill in the same signature.",
    stopper: "Adag sees new debt, so the 40% check runs.",
    invariant: "C10",
    expect: "refused",
  },
  {
    id: "A4",
    group: "Slip past the 40% line",
    attack: "Pay a bill from cash, then borrow up to 60% after Adag's step in the same batch. Next block, pay another bill.",
    stopper: "Allowed by design, caught on the next payment.",
    invariant: "C10",
    expect: "by-design",
  },
  { id: "A5", group: "Pay yourself", attack: "A supplier pays its own bill.", stopper: "The payer can never be the payee.", invariant: "C1", expect: "refused" },
  { id: "A6.1", group: "Write a bad bill", attack: "A stranger writes a bill payable in cirBTC.", stopper: "Bills are in USDC or EURC only.", invariant: "C8", expect: "refused" },
  { id: "A6.2", group: "Write a bad bill", attack: "A stranger writes a bill payable in WETH.", stopper: "Bills are in USDC or EURC only.", invariant: "C8", expect: "refused" },
  { id: "A6.3", group: "Write a bad bill", attack: "A stranger writes a bill payable in a made-up token.", stopper: "Bills are in USDC or EURC only.", invariant: "C8", expect: "refused" },
  { id: "A6.4", group: "Write a bad bill", attack: "A stranger writes a bill for zero.", stopper: "A bill must be for more than zero.", invariant: "C8", expect: "refused" },
  { id: "A6.5", group: "Write a bad bill", attack: "A stranger writes a bill with a 141-byte invoice reference.", stopper: "References are 140 bytes at most.", invariant: "C8", expect: "refused" },
  { id: "A7a", group: "Cancel someone's bill", attack: "A stranger cancels a supplier's open bill.", stopper: "Only the supplier who wrote a bill can cancel it.", invariant: "C9", expect: "refused" },
  { id: "A7b", group: "Cancel someone's bill", attack: "The supplier cancels bill #1 after it was paid.", stopper: "Only an open bill can be cancelled.", invariant: "C9", expect: "refused" },
  {
    id: "A8",
    group: "Skip the approval",
    attack: "Pay a bill without approving Adag to move the USDC.",
    stopper: "The token refuses, and the whole batch undoes itself.",
    invariant: "C1",
    expect: "refused",
  },
  {
    id: "A9a",
    group: "When bitcoin falls",
    attack: "Bitcoin drops 25%. Pay a new bill from cash, with no new borrowing.",
    stopper: "Allowed on purpose: no new debt, so nothing to check. A price drop never blocks a cash payment.",
    invariant: "C10",
    expect: "allowed",
    simulatedPriceDrop: true,
  },
  {
    id: "A9b",
    group: "When bitcoin falls",
    attack: "Bitcoin drops 25%. Borrow one cent more and pay the same bill.",
    stopper: "New debt, so the 40% check runs.",
    invariant: "C10",
    expect: "refused",
    simulatedPriceDrop: true,
  },
];

export type Verdict = "refused" | "allowed" | "by-design" | "broken" | "error";

export type CheckResult = {
  id: CheckId;
  pass: boolean;
  verdict: Verdict;
  // Plain English for anyone; `raw` is the decoded error exactly as the chain returned it.
  reason: string;
  raw: string;
  gas: string | null;
};

export type RunStart = { type: "start"; block: string; timestamp: number; total: number; cached: boolean; ageSeconds: number };
export type RunState = { type: "state"; lines: string[] };
export type RunResult = { type: "result"; result: CheckResult };
export type RunDone = { type: "done"; passed: number; total: number; summary: string };
export type RunFatal = { type: "fatal"; reason: string };
export type RunLine = RunStart | RunState | RunResult | RunDone | RunFatal;
