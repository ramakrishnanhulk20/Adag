// Safe to import in the browser: plain words only, no chain code. The ids and pass rules match
// packages/contracts/prove-it/attack.mjs --target enrol (A1 to A9, E1 to E5) and guard-attack.mjs (G1 to G10).
// A10, the prove-it script's own chain guard, is left out on purpose: it tests a script, not a contract.

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
  | "A9b"
  | "E1"
  | "E2"
  | "E3"
  | "E4"
  | "E5"
  | "G6"
  | "G1"
  | "G2a"
  | "G2b"
  | "G2c"
  | "G3"
  | "G4"
  | "G5a"
  | "G5b"
  | "G7"
  | "G8"
  | "G9a"
  | "G9b"
  | "G10";

// refused: the chain said no. held: the call went through and changed nothing it should not.
// allowed: the rule's own promise (a price drop never blocks a cash payment). by-design: a named residual.
export type Expect = "refused" | "held" | "allowed" | "by-design";

export type Group = "Paying bills" | "Recording an existing loan" | "The loan guard";

export type CheckInfo = {
  id: CheckId;
  group: Group;
  attack: string;
  stopper: string;
  // The threat model invariants the check attacks.
  invariant: string;
  expect: Expect;
  simulated?: "price drop" | "price crash";
};

const BILLS: Group = "Paying bills";
const ENROL: Group = "Recording an existing loan";
const GUARD: Group = "The loan guard";

export const CHECKS: readonly CheckInfo[] = [
  { id: "A1", group: BILLS, attack: "A stranger with money pays an already-paid bill a second time.", stopper: "A bill can be paid once. Only an open bill can be paid.", invariant: "C6", expect: "refused" },
  {
    id: "A2a",
    group: BILLS,
    attack: "Close the loan outside Adag, then re-borrow the same debt against a quarter of the bitcoin.",
    stopper: "Morpho's own 86% line stops it before Adag is reached.",
    invariant: "C10",
    expect: "refused",
  },
  {
    id: "A2b",
    group: BILLS,
    attack: "Close the loan, then re-borrow the same debt against bitcoin worth 60%, which Morpho allows, and pay a bill.",
    stopper: "Adag sees the pledge shrank since its last check, so the 40% check runs.",
    invariant: "C10",
    expect: "refused",
  },
  { id: "A3", group: BILLS, attack: "Borrow up to half the bitcoin's value and pay a new bill in the same signature.", stopper: "Adag sees new debt, so the 40% check runs.", invariant: "C10", expect: "refused" },
  {
    id: "A4",
    group: BILLS,
    attack: "Pay a bill from cash, then borrow up to 60% after Adag's step in the same batch. Next block, pay another bill.",
    stopper: "Allowed by design, caught on the next payment.",
    invariant: "C10",
    expect: "by-design",
  },
  { id: "A5", group: BILLS, attack: "A supplier pays its own bill.", stopper: "The payer can never be the payee.", invariant: "C1", expect: "refused" },
  { id: "A6.1", group: BILLS, attack: "A stranger writes a bill payable in cirBTC.", stopper: "Bills are in USDC or EURC only.", invariant: "C8", expect: "refused" },
  { id: "A6.2", group: BILLS, attack: "A stranger writes a bill payable in WETH.", stopper: "Bills are in USDC or EURC only.", invariant: "C8", expect: "refused" },
  { id: "A6.3", group: BILLS, attack: "A stranger writes a bill payable in a made-up token.", stopper: "Bills are in USDC or EURC only.", invariant: "C8", expect: "refused" },
  { id: "A6.4", group: BILLS, attack: "A stranger writes a bill for zero.", stopper: "A bill must be for more than zero.", invariant: "C8", expect: "refused" },
  { id: "A6.5", group: BILLS, attack: "A stranger writes a bill with a 141-byte invoice reference.", stopper: "References are 140 bytes at most.", invariant: "C8", expect: "refused" },
  { id: "A7a", group: BILLS, attack: "A stranger cancels a supplier's open bill.", stopper: "Only the supplier who wrote a bill can cancel it.", invariant: "C9", expect: "refused" },
  { id: "A7b", group: BILLS, attack: "The supplier cancels a bill after it was paid.", stopper: "Only an open bill can be cancelled.", invariant: "C9", expect: "refused" },
  { id: "A8", group: BILLS, attack: "Pay a bill without approving Adag to move the USDC.", stopper: "The token refuses, and the whole batch undoes itself.", invariant: "C1", expect: "refused" },
  {
    id: "A9a",
    group: BILLS,
    attack: "Bitcoin drops 25%. Pay a new bill from cash, with no new borrowing.",
    stopper: "Allowed on purpose: no new debt, so nothing to check. A price drop never blocks a cash payment.",
    invariant: "C10",
    expect: "allowed",
    simulated: "price drop",
  },
  { id: "A9b", group: BILLS, attack: "Bitcoin drops 25%. Borrow one cent more and pay the same bill.", stopper: "New debt, so the 40% check runs.", invariant: "C10", expect: "refused", simulated: "price drop" },

  {
    id: "E1",
    group: ENROL,
    attack: "Record the loan with enrol and pay a bill from cash in the same batch.",
    stopper: "A payer who enrolled in this block is refused, so a loan cannot be recorded and spent at once.",
    invariant: "C32",
    expect: "refused",
  },
  {
    id: "E2",
    group: ENROL,
    attack: "Borrow up to 60%, record that debt with enrol, and pay a bill, all in one batch.",
    stopper: "The same-block refusal: new debt cannot be enrolled and spent at once.",
    invariant: "C32",
    expect: "refused",
  },
  {
    id: "E3",
    group: ENROL,
    attack: "A stranger calls enrol, hoping to overwrite the demo payer's recorded loan, then the payer pays.",
    stopper: "enrol takes no arguments and only ever writes the caller's own record.",
    invariant: "C31",
    expect: "held",
  },
  {
    id: "E4",
    group: ENROL,
    attack: "Enrol in one block; in the next, close the loan outside Adag, re-borrow it against bitcoin worth 60%, and pay.",
    stopper: "The pledge fell below the enrolled one, so the 40% check runs.",
    invariant: "C32",
    expect: "refused",
  },
  {
    id: "E5",
    group: ENROL,
    attack: "Borrow up to 60% outside Adag and enrol it; in the next block, pay a bill from cash.",
    stopper: "Allowed by design: enrol accepts the loan as it stands, and only the payer's own position carries the risk.",
    invariant: "C32",
    expect: "by-design",
  },

  {
    id: "G6",
    group: GUARD,
    attack: "Call protect three times at the same price: twice in one block, once in the next.",
    stopper: "Each protect repays only what brings the loan back to the target, so a repeat finds nothing to do.",
    invariant: "C38",
    expect: "held",
  },
  {
    id: "G1",
    group: GUARD,
    attack: "Pull more than the payer approved: the loan needs more than the 0.10 USDC approval, and protect runs twice.",
    stopper: "The approval is the lifetime ceiling, and protect caps at it.",
    invariant: "C36, C38",
    expect: "held",
  },
  {
    id: "G2a",
    group: GUARD,
    attack: "Protect the payer's loan through the other real USDC/cirBTC market on Morpho.",
    stopper: "AdagGuard accepts only its two fixed market ids, checked against Morpho.",
    invariant: "C35, C41",
    expect: "refused",
  },
  {
    id: "G2b",
    group: GUARD,
    attack: "Set a rule and call protect with a market id one hex digit away from Adag's.",
    stopper: "A near miss is a different id, and it is refused.",
    invariant: "C35",
    expect: "refused",
  },
  {
    id: "G2c",
    group: GUARD,
    attack: "Protect the payer in the EURC market, where they have no loan and no rule.",
    stopper: "Each market repays only its own loan, and only for a real, triggered rule.",
    invariant: "C35, C36",
    expect: "held",
  },
  {
    id: "G3",
    group: GUARD,
    attack: "A stranger calls protect while the loan sits under the payer's 50% trigger.",
    stopper: "Protect acts only at or above the trigger; otherwise nothing moves and nothing is emitted.",
    invariant: "C36",
    expect: "held",
  },
  {
    id: "G4",
    group: GUARD,
    attack: "The payer's rule expires 60 seconds after it is set; a stranger calls protect at that second.",
    stopper: "An expired rule is inert.",
    invariant: "C41",
    expect: "held",
  },
  { id: "G5a", group: GUARD, attack: "A stranger clears the payer's rule.", stopper: "Rules are keyed by the sender; nobody can name another wallet.", invariant: "C34", expect: "refused" },
  {
    id: "G5b",
    group: GUARD,
    attack: "A stranger sets a rule (80% / 1%) hoping it lands on the payer.",
    stopper: "setRule writes only the sender's own rule.",
    invariant: "C34",
    expect: "held",
  },
  {
    id: "G7",
    group: GUARD,
    attack: "The payer's wallet holds only 0.05 USDC when the loan needs more.",
    stopper: "Protect never pulls more than the wallet holds, and does not revert.",
    invariant: "C36",
    expect: "held",
  },
  {
    id: "G8",
    group: GUARD,
    attack: "Bitcoin crashes to zero. Protect with a 2 USDC approval against the whole loan.",
    stopper: "The repay is capped at the debt rounded down, so Morpho's share maths cannot underflow.",
    invariant: "C36, C37",
    expect: "held",
    simulated: "price crash",
  },
  {
    id: "G9a",
    group: GUARD,
    attack: "Bitcoin crashes to zero. Protect a payer who approved 1 USDC but has no rule.",
    stopper: "No rule, no action, even at a zero price.",
    invariant: "C36, C41",
    expect: "held",
    simulated: "price crash",
  },
  { id: "G9b", group: GUARD, attack: "Protect a wallet with no loan and no rule.", stopper: "Nothing to repay, nothing moves.", invariant: "C36", expect: "held" },
  {
    id: "G10",
    group: GUARD,
    attack: "Call the admin functions a drain would need: transferOwnership, withdraw, rescue, pause and upgradeToAndCall.",
    stopper: "No owner, pause, rescue or upgrade exists; only setRule, clearRule and protect change state.",
    invariant: "C39",
    expect: "refused",
  },
];

export const GROUPS: readonly Group[] = [BILLS, ENROL, GUARD];

export const PREMISE_LINE =
  "Every loan guard row starts from a simulated premise: the demo payer borrows on Morpho until the loan sits at 38.00%, above the 35% trigger.";

// One plain line under each group heading, saying what the rows run against.
export const GROUP_NOTES: Record<Group, string> = {
  [BILLS]: "Against the current AdagBills and the demo wallet's real Morpho loan.",
  [ENROL]: "Recording (enrol) saves a loan the payer already had, so that payer's next payments are checked against it.",
  [GUARD]: `Against the live AdagGuard. ${PREMISE_LINE} Nothing of AdagGuard, Morpho or the oracle is overwritten.`,
};

// What each stamp means, in the words a reader without the threat model needs.
export const LEGEND: { verdict: Expect; term: string; means: string }[] = [
  { verdict: "refused", term: "Refused", means: "the chain said no." },
  { verdict: "held", term: "Held", means: "it ran, and nothing it protects moved." },
  { verdict: "by-design", term: "Allowed by design", means: "a known, accepted gap that only affects the attacker's own loan." },
  { verdict: "allowed", term: "Allowed", means: "the chain allowed it, and the threat model says that is correct." },
];

// The named residuals: allowed on purpose, each linked to where the threat model names it.
export const RESIDUALS: Partial<Record<CheckId, { text: string; href: string }>> = {
  A4: { text: "Allowed by design, caught on the next payment. The named residual under C10 in", href: "/docs/security/threat-model#loan-safety" },
  E5: {
    text: "Allowed by design: enrol in one block and pay in the next, at the payer's own risk. The named residual under C32 in",
    href: "/docs/security/threat-model#c-invariants-c31-to-c60-the-definition-of-done-for-the-second-build",
  },
};

export type Verdict = "refused" | "held" | "allowed" | "by-design" | "broken" | "error";

export type CheckResult = {
  id: CheckId;
  pass: boolean;
  verdict: Verdict;
  // Plain English for anyone; `raw` is the decoded evidence exactly as the chain returned it.
  reason: string;
  raw: string;
  gas: string | null;
};

// The simulation provider is named, never its URL: the paid endpoint's URL carries its key.
export type RunStart = { type: "start"; block: string; timestamp: number; total: number; cached: boolean; ageSeconds: number; provider: string };
export type RunState = { type: "state"; lines: string[] };
export type RunResult = { type: "result"; result: CheckResult };
export type RunDone = { type: "done"; passed: number; total: number; summary: string; providers: string[] };
export type RunFatal = { type: "fatal"; reason: string };
export type RunLine = RunStart | RunState | RunResult | RunDone | RunFatal;
